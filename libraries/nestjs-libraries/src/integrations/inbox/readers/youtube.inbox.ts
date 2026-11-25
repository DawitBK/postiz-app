import { inboxRequest } from '../inbox.http';
import {
  InboxChannelContext,
  InboxNotSupportedError,
  InboxPostRef,
  InboxReader,
  InboxReplyTarget,
  InboxSupport,
  NetworkMessage,
} from '../inbox.types';
import {
  isOnOrAfter,
  jsonPath,
  jsonRequest,
  paginate,
  parseDate,
  ReaderHttpError,
  requestKeepingBody,
} from './shared';

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const PAGE_SIZE = 100;
/** A thread shows only some of its replies inline; the rest is one `comments.list` call per thread, at most this many per read. */
const MAX_REPLY_LOOKUPS = 50;

const DMS_REASON =
  'YouTube has no direct messages: the YouTube Data API has no endpoint for private messages.';

interface YoutubeComment {
  id: string;
  snippet?: {
    authorDisplayName?: string;
    authorChannelId?: { value?: string };
    textDisplay?: string;
    parentId?: string;
    publishedAt?: string;
  };
}

interface YoutubeThread {
  id: string;
  snippet?: { topLevelComment?: YoutubeComment; totalReplyCount?: number };
  replies?: { comments?: YoutubeComment[] };
}

const authorization = (ctx: InboxChannelContext) => ({
  Authorization: `Bearer ${ctx.accessToken}`,
});

/** A video that has comments turned off, or is gone, must not stop the other videos from being read. */
function isSkippableVideoError(error: unknown): boolean {
  if (!(error instanceof ReaderHttpError)) {
    return false;
  }
  const reason = jsonPath(error.body, ['error', 'errors', '0', 'reason']);
  return reason === 'commentsDisabled' || reason === 'videoNotFound';
}

/**
 * YouTube: comments on the channel's videos (`commentThreads.list`, 1 quota unit a page) and replies
 * to them (`comments.insert`, 50 units). `ctx.accountId` is the channel id, `networkPostId` the video id.
 */
export class YoutubeInboxReader implements InboxReader {
  readonly identifiers = ['youtube'] as const;

  support(): InboxSupport {
    return {
      comments: {
        supported: true,
        note: 'Reads comments and replies on the channel videos and answers them as the channel. Needs the youtube.force-ssl scope. Reading costs 1 quota unit a page of 100 threads, an answer costs 50 (the default quota is 10,000 units a day).',
      },
      directMessages: { supported: false, reason: DMS_REASON },
    };
  }

  async listComments(
    ctx: InboxChannelContext,
    posts: InboxPostRef[],
    since: Date | null
  ): Promise<NetworkMessage[]> {
    const out: NetworkMessage[] = [];
    let replyLookups = 0;
    for (const post of posts) {
      let threads: YoutubeThread[];
      try {
        threads = await this.fetchThreads(ctx, post.networkPostId);
      } catch (error) {
        if (isSkippableVideoError(error)) {
          continue;
        }
        throw error;
      }
      for (const thread of threads) {
        const top = thread.snippet?.topLevelComment;
        if (!top) {
          continue;
        }
        this.push(out, ctx, post.networkPostId, top, null, since);

        let replies = thread.replies?.comments ?? [];
        const total = thread.snippet?.totalReplyCount ?? replies.length;
        if (total > replies.length && replyLookups < MAX_REPLY_LOOKUPS) {
          replyLookups++;
          replies = await this.fetchReplies(ctx, top.id);
        }
        for (const reply of replies) {
          this.push(out, ctx, post.networkPostId, reply, top.id, since);
        }
      }
    }
    return out;
  }

  async reply(
    ctx: InboxChannelContext,
    target: InboxReplyTarget,
    text: string
  ): Promise<{ replyId: string | null }> {
    if (target.kind === 'direct_message') {
      throw new InboxNotSupportedError(DMS_REASON);
    }
    // YouTube supports replies to top-level comments only
    const parentId = target.parentNetworkId ?? target.networkId;
    const answer = await inboxRequest<{ id?: string }>(
      ctx,
      `${YOUTUBE_API}/comments?part=snippet`,
      jsonRequest('POST', authorization(ctx), { snippet: { parentId, textOriginal: text } })
    );
    return { replyId: answer.id ?? null };
  }

  private fetchThreads(ctx: InboxChannelContext, videoId: string): Promise<YoutubeThread[]> {
    return paginate<YoutubeThread>(async (cursor) => {
      const params = new URLSearchParams({
        part: 'snippet,replies',
        videoId,
        maxResults: String(PAGE_SIZE),
        order: 'time',
        textFormat: 'plainText',
      });
      if (cursor) {
        params.set('pageToken', cursor);
      }
      const page = await requestKeepingBody<{
        items?: YoutubeThread[];
        nextPageToken?: string;
      }>(ctx, `${YOUTUBE_API}/commentThreads?${params}`, jsonRequest('GET', authorization(ctx)));
      return { items: page.items ?? [], next: page.nextPageToken ?? null };
    });
  }

  private fetchReplies(ctx: InboxChannelContext, parentId: string): Promise<YoutubeComment[]> {
    return paginate<YoutubeComment>(async (cursor) => {
      const params = new URLSearchParams({
        part: 'snippet',
        parentId,
        maxResults: String(PAGE_SIZE),
        textFormat: 'plainText',
      });
      if (cursor) {
        params.set('pageToken', cursor);
      }
      const page = await inboxRequest<{
        items?: YoutubeComment[];
        nextPageToken?: string;
      }>(ctx, `${YOUTUBE_API}/comments?${params}`, jsonRequest('GET', authorization(ctx)));
      return { items: page.items ?? [], next: page.nextPageToken ?? null };
    });
  }

  private push(
    out: NetworkMessage[],
    ctx: InboxChannelContext,
    videoId: string,
    comment: YoutubeComment,
    parentNetworkId: string | null,
    since: Date | null
  ) {
    const receivedAt = parseDate(comment.snippet?.publishedAt);
    // YouTube cannot filter comments by time, so the bound is applied here
    if (!receivedAt || !isOnOrAfter(receivedAt, since)) {
      return;
    }
    const authorId = comment.snippet?.authorChannelId?.value ?? null;
    out.push({
      networkId: comment.id,
      kind: 'comment',
      networkPostId: videoId,
      parentNetworkId,
      threadId: null,
      authorId,
      authorName: comment.snippet?.authorDisplayName ?? 'YouTube viewer',
      text: comment.snippet?.textDisplay ?? '',
      receivedAt,
      fromSelf: authorId !== null && authorId === ctx.accountId,
    });
  }
}
