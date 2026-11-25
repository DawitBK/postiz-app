import { Injectable } from '@nestjs/common';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { allInboxReaders } from '@gitroom/nestjs-libraries/integrations/inbox/readers';
import {
  InboxChannelContext,
  InboxKind,
  InboxPostRef,
  InboxReader,
  InboxReplyTarget,
  NetworkMessage,
} from '@gitroom/nestjs-libraries/integrations/inbox/inbox.types';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';

/** One comment or direct message, as the public API shows it. No token, no network secret. */
export interface InboxItem {
  /** `<channel id>:<c|d>:<the network id of the message>`. Give it back to `reply`. */
  id: string;
  integrationId: string;
  kind: InboxKind;
  authorName: string;
  text: string;
  receivedAt: string;
  /** Comments: the network id of the post (`releaseId`). */
  networkPostId: string | null;
  /** True when the channel account already answered this message. */
  replied: boolean;
}

export interface InboxResult {
  messages: InboxItem[];
  /** Channels that could not be read, and why. A channel that failed is never reported as empty. */
  problems: { integrationId: string; reason: string }[];
}

/** How far back published posts are looked at for their comments, and messages for a reply. */
const POST_LOOKBACK_DAYS = 30;
const REPLY_LOOKBACK_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

export class InboxNotFoundError extends Error {}

/**
 * The unified inbox (DCC task W-08): comments under the posts Postiz published, and direct messages, read from each
 * network on request through one reader per network (`integrations/inbox/readers`). Nothing is stored here: the
 * network is the source, and the id of a message carries what is needed to find it again for a reply.
 */
@Injectable()
export class InboxService {
  constructor(
    private _integrationService: IntegrationService,
    private _postsService: PostsService
  ) {}

  private readerFor(identifier: string): InboxReader | undefined {
    return allInboxReaders().find((reader) =>
      reader.identifiers.includes(identifier)
    );
  }

  private contextOf(integration: {
    providerIdentifier: string;
    internalId: string;
    profile: string | null;
    token: string;
  }): InboxChannelContext {
    return {
      identifier: integration.providerIdentifier,
      accountId: integration.internalId,
      profile: integration.profile,
      accessToken: integration.token,
    };
  }

  private async postRefs(
    orgId: string,
    integrationId: string,
    from: Date,
    to: Date
  ): Promise<InboxPostRef[]> {
    const posts = await this._postsService.getPosts(orgId, {
      startDate: new Date(
        from.getTime() - POST_LOOKBACK_DAYS * DAY
      ).toISOString(),
      endDate: to.toISOString(),
    } as GetPostsDto);
    return posts
      .filter(
        (post: any) =>
          post.integration?.id === integrationId &&
          post.state === 'PUBLISHED' &&
          post.releaseId
      )
      .map((post: any) => ({
        networkPostId: String(post.releaseId),
        releaseUrl: post.releaseURL ?? null,
        publishedAt: new Date(post.publishDate),
      }));
  }

  private async readAll(
    reader: InboxReader,
    ctx: InboxChannelContext,
    refs: InboxPostRef[],
    since: Date
  ): Promise<NetworkMessage[]> {
    const support = reader.support();
    const found: NetworkMessage[] = [];
    if (support.comments.supported && reader.listComments) {
      found.push(...(await reader.listComments(ctx, refs, since)));
    }
    if (support.directMessages.supported && reader.listMessages) {
      found.push(...(await reader.listMessages(ctx, since)));
    }
    return found;
  }

  async list(
    orgId: string,
    from: Date,
    to: Date,
    integrationId?: string
  ): Promise<InboxResult> {
    const integrations = (
      await this._integrationService.getIntegrationsList(orgId)
    ).filter(
      (integration) =>
        !integration.disabled &&
        (!integrationId || integration.id === integrationId)
    );

    const messages: InboxItem[] = [];
    const problems: InboxResult['problems'] = [];
    for (const integration of integrations) {
      const reader = this.readerFor(integration.providerIdentifier);
      if (!reader) {
        continue;
      }
      try {
        const refs = await this.postRefs(orgId, integration.id, from, to);
        const read = await this.readAll(
          reader,
          this.contextOf(integration),
          refs,
          from
        );
        // What the channel account wrote answers what it was written under or in.
        const answeredComments = new Set(
          read
            .filter((m) => m.fromSelf && m.parentNetworkId)
            .map((m) => m.parentNetworkId as string)
        );
        const lastSelfInThread = new Map<string, number>();
        for (const m of read) {
          if (m.fromSelf && m.threadId) {
            lastSelfInThread.set(
              m.threadId,
              Math.max(
                lastSelfInThread.get(m.threadId) ?? 0,
                m.receivedAt.getTime()
              )
            );
          }
        }
        for (const m of read) {
          if (
            m.fromSelf ||
            m.receivedAt.getTime() < from.getTime() ||
            m.receivedAt.getTime() > to.getTime()
          ) {
            continue;
          }
          messages.push({
            id: `${integration.id}:${m.kind === 'comment' ? 'c' : 'd'}:${m.networkId}`,
            integrationId: integration.id,
            kind: m.kind,
            authorName: m.authorName,
            text: m.text,
            receivedAt: m.receivedAt.toISOString(),
            networkPostId: m.networkPostId,
            replied:
              m.kind === 'comment'
                ? answeredComments.has(m.networkId)
                : (lastSelfInThread.get(m.threadId ?? '') ?? 0) >=
                  m.receivedAt.getTime(),
          });
        }
      } catch (error) {
        problems.push({
          integrationId: integration.id,
          reason: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
    messages.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    return { messages, problems };
  }

  /** Answers one message in public, as the channel account. Throws InboxNotFoundError when the id is not found. */
  async reply(
    orgId: string,
    id: string,
    text: string
  ): Promise<{ replyId: string | null }> {
    const firstColon = id.indexOf(':');
    const secondColon = id.indexOf(':', firstColon + 1);
    if (firstColon < 1 || secondColon < 0) {
      throw new InboxNotFoundError('That message id is not valid.');
    }
    const integrationId = id.slice(0, firstColon);
    const kindCode = id.slice(firstColon + 1, secondColon);
    const networkId = id.slice(secondColon + 1);
    if ((kindCode !== 'c' && kindCode !== 'd') || !networkId) {
      throw new InboxNotFoundError('That message id is not valid.');
    }

    const integration = (
      await this._integrationService.getIntegrationsList(orgId)
    ).find((item) => item.id === integrationId && !item.disabled);
    const reader =
      integration && this.readerFor(integration.providerIdentifier);
    if (!integration || !reader) {
      throw new InboxNotFoundError('That channel has no inbox.');
    }

    // The message is read again, so what the network needs to answer it (a thread, a parent) is the network's own.
    const now = new Date();
    const since = new Date(now.getTime() - REPLY_LOOKBACK_DAYS * DAY);
    const ctx = this.contextOf(integration);
    const refs = await this.postRefs(orgId, integration.id, since, now);
    const read = await this.readAll(reader, ctx, refs, since);
    const wanted: InboxKind = kindCode === 'c' ? 'comment' : 'direct_message';
    const message = read.find(
      (m) => m.networkId === networkId && m.kind === wanted && !m.fromSelf
    );
    if (!message) {
      throw new InboxNotFoundError('That message was not found any more.');
    }
    const target: InboxReplyTarget = {
      networkId: message.networkId,
      kind: message.kind,
      networkPostId: message.networkPostId,
      parentNetworkId: message.parentNetworkId,
      threadId: message.threadId,
      authorId: message.authorId,
      replyContext: message.replyContext ?? {},
    };
    return reader.reply(ctx, target, text);
  }
}
