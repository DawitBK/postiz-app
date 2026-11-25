import {
  InboxChannelContext,
  InboxPostRef,
  InboxReader,
  InboxReplyTarget,
  InboxSupport,
  NetworkMessage,
} from '../inbox.types';
import {
  GRAPH_FACEBOOK,
  GraphDmConfig,
  graphPages,
  graphRequest,
  graphUrl,
  isMissingGraphObject,
  listGraphMessages,
  replyGraphMessage,
} from './meta.graph';
import { isOnOrAfter, jsonRequest, parseDate } from './shared';

interface FacebookComment {
  id: string;
  message?: string;
  created_time?: string;
  from?: { id?: string; name?: string };
  parent?: { id?: string };
}

/**
 * Facebook Pages: comments on the Page's posts and Messenger conversations, through the Graph API
 * with the Page access token Postiz stores for the channel. `ctx.accountId` is the Page id.
 */
export class FacebookInboxReader implements InboxReader {
  readonly identifiers = ['facebook'] as const;

  constructor(private readonly now: () => Date = () => new Date()) {}

  support(): InboxSupport {
    return {
      comments: {
        supported: true,
        note: 'Reads and answers comments on the Page posts as the Page. Needs the Page permissions pages_read_engagement and pages_manage_engagement.',
      },
      directMessages: {
        supported: true,
        note: 'Reads Messenger conversations and answers them. Needs pages_messaging (Meta App Review). A Page can answer within 24 hours of the person\'s last message, or within 7 days with the human agent tag.',
      },
    };
  }

  async listComments(
    ctx: InboxChannelContext,
    posts: InboxPostRef[],
    since: Date | null
  ): Promise<NetworkMessage[]> {
    const out: NetworkMessage[] = [];
    for (const post of posts) {
      // filter=stream returns replies as well as top-level comments, each with its `parent`
      const url = graphUrl(GRAPH_FACEBOOK, `${post.networkPostId}/comments`, {
        filter: 'stream',
        order: 'chronological',
        limit: 100,
        fields: 'id,message,created_time,from,parent{id}',
        since: since ? Math.floor(since.getTime() / 1000) : undefined,
        access_token: ctx.accessToken,
      });
      let comments: FacebookComment[];
      try {
        comments = await graphPages<FacebookComment>(ctx, url, GRAPH_FACEBOOK);
      } catch (error) {
        if (isMissingGraphObject(error)) {
          continue;
        }
        throw error;
      }
      for (const comment of comments) {
        const receivedAt = parseDate(comment.created_time);
        if (!receivedAt || !isOnOrAfter(receivedAt, since)) {
          continue;
        }
        out.push({
          networkId: comment.id,
          kind: 'comment',
          networkPostId: post.networkPostId,
          parentNetworkId: comment.parent?.id ?? null,
          threadId: null,
          authorId: comment.from?.id ?? null,
          authorName: comment.from?.name ?? 'Facebook user',
          text: comment.message ?? '',
          receivedAt,
          fromSelf: comment.from?.id === ctx.accountId,
        });
      }
    }
    return out;
  }

  listMessages(ctx: InboxChannelContext, since: Date | null): Promise<NetworkMessage[]> {
    return listGraphMessages(ctx, this.dmConfig(ctx), since);
  }

  async reply(
    ctx: InboxChannelContext,
    target: InboxReplyTarget,
    text: string
  ): Promise<{ replyId: string | null }> {
    if (target.kind === 'direct_message') {
      return replyGraphMessage(ctx, this.dmConfig(ctx), target, text, this.now());
    }
    // a comment on a comment; the Page is the author (needs pages_manage_engagement)
    const url = graphUrl(GRAPH_FACEBOOK, `${target.networkId}/comments`, {
      access_token: ctx.accessToken,
    });
    const answer = await graphRequest<{ id?: string }>(
      ctx,
      url,
      jsonRequest('POST', {}, { message: text })
    );
    return { replyId: answer.id ?? null };
  }

  private dmConfig(ctx: InboxChannelContext): GraphDmConfig {
    return {
      host: GRAPH_FACEBOOK,
      token: ctx.accessToken,
      platform: 'messenger',
      selfIds: [ctx.accountId],
      selfHandles: [],
      sendsMessagingType: true,
      maxBytes: null,
      label: 'Messenger',
    };
  }
}
