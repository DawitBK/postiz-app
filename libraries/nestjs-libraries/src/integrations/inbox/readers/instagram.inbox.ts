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
  GRAPH_INSTAGRAM,
  GraphDmConfig,
  graphPages,
  graphRequest,
  graphUrl,
  isMissingGraphObject,
  listGraphMessages,
  replyGraphMessage,
} from './meta.graph';
import { isOnOrAfter, jsonRequest, parseDate } from './shared';

interface InstagramComment {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  from?: { id?: string; username?: string };
  parent_id?: string;
  replies?: { data?: InstagramComment[] };
}

const COMMENT_FIELDS = 'id,text,timestamp,username,from,parent_id';

/**
 * Instagram professional accounts, both login variants. `instagram` (through a Facebook Page) talks
 * to graph.facebook.com with the Page token (the first part of the stored `pageToken___userToken`);
 * `instagram-standalone` (Instagram Login) talks to graph.instagram.com with its own token.
 * `ctx.accountId` is the Instagram account id in both cases.
 */
export class InstagramInboxReader implements InboxReader {
  readonly identifiers = ['instagram', 'instagram-standalone'] as const;

  constructor(private readonly now: () => Date = () => new Date()) {}

  support(): InboxSupport {
    return {
      comments: {
        supported: true,
        note: 'Reads comments on the account\'s media and answers them. Needs instagram_manage_comments (instagram_business_manage_comments with Instagram Login). The newest 250 top-level comments of a post are read; an answer to a reply goes to the top-level comment.',
      },
      directMessages: {
        supported: true,
        note: 'Reads Direct conversations and answers them. Needs instagram_manage_messages (instagram_business_manage_messages with Instagram Login). Only the 20 most recent messages of a conversation can be read; an account can answer within 24 hours of the person\'s last message, or within 7 days with the human agent tag; a message is at most 1000 bytes.',
      },
    };
  }

  async listComments(
    ctx: InboxChannelContext,
    posts: InboxPostRef[],
    since: Date | null
  ): Promise<NetworkMessage[]> {
    const { host, token } = this.route(ctx);
    const out: NetworkMessage[] = [];
    for (const post of posts) {
      // Instagram cannot filter comments by time, and returns only top-level ones
      // (at most 50 per call): replies come with the `replies` field expansion.
      const url = graphUrl(host, `${post.networkPostId}/comments`, {
        fields: `${COMMENT_FIELDS},replies.limit(100){${COMMENT_FIELDS}}`,
        limit: 50,
        access_token: token,
      });
      let comments: InstagramComment[];
      try {
        comments = await graphPages<InstagramComment>(ctx, url, host);
      } catch (error) {
        if (isMissingGraphObject(error)) {
          continue;
        }
        throw error;
      }
      for (const comment of comments) {
        this.pushComment(out, ctx, post.networkPostId, comment, null, since);
        for (const reply of comment.replies?.data ?? []) {
          this.pushComment(out, ctx, post.networkPostId, reply, comment.id, since);
        }
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
    const { host, token } = this.route(ctx);
    // Instagram adds a reply to a reply to the top-level comment anyway: answer that one directly
    const commentId = target.parentNetworkId ?? target.networkId;
    const url = graphUrl(host, `${commentId}/replies`, { access_token: token });
    const answer = await graphRequest<{ id?: string }>(
      ctx,
      url,
      jsonRequest('POST', {}, { message: text })
    );
    return { replyId: answer.id ?? null };
  }

  private route(ctx: InboxChannelContext): { host: string; token: string } {
    return ctx.identifier === 'instagram-standalone'
      ? { host: GRAPH_INSTAGRAM, token: ctx.accessToken }
      : { host: GRAPH_FACEBOOK, token: ctx.accessToken.split('___')[0] };
  }

  private dmConfig(ctx: InboxChannelContext): GraphDmConfig {
    const { host, token } = this.route(ctx);
    return {
      host,
      token,
      platform: 'instagram',
      selfIds: [ctx.accountId],
      selfHandles: ctx.profile ? [ctx.profile.toLowerCase()] : [],
      sendsMessagingType: false,
      maxBytes: 1000,
      label: 'Instagram',
    };
  }

  private pushComment(
    out: NetworkMessage[],
    ctx: InboxChannelContext,
    networkPostId: string,
    comment: InstagramComment,
    parentId: string | null,
    since: Date | null
  ) {
    const receivedAt = parseDate(comment.timestamp);
    if (!receivedAt || !isOnOrAfter(receivedAt, since)) {
      return;
    }
    const username = comment.username ?? comment.from?.username;
    out.push({
      networkId: comment.id,
      kind: 'comment',
      networkPostId,
      parentNetworkId: comment.parent_id ?? parentId,
      threadId: null,
      authorId: comment.from?.id ?? null,
      authorName: username ?? 'Instagram user',
      text: comment.text ?? '',
      receivedAt,
      fromSelf:
        comment.from?.id === ctx.accountId ||
        (!!ctx.profile && username?.toLowerCase() === ctx.profile.toLowerCase()),
    });
  }
}
