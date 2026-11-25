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
import { OAuth1Credentials, signOAuth1 } from './oauth1';
import { isOnOrAfter, jsonRequest, paginate, parseDate } from './shared';

const X_API = 'https://api.x.com/2';
/**
 * The query-string name of the post field list. docs.x.com names it `post.fields`; the official SDK
 * reference and `twitter-api-v2` (what the fork's X provider uses) send `tweet.fields`. Flip it here
 * if X's live API turns out to want the other one.
 */
const POST_FIELDS = 'tweet.fields';
const RECENT_SEARCH_DAYS = 7;
const MIN_AGE_MS = 15 * 1000;

interface XUser {
  id: string;
  name?: string;
  username?: string;
}

interface XPost {
  id: string;
  text?: string;
  created_at?: string;
  author_id?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
}

interface XDmEvent {
  id: string;
  event_type?: string;
  text?: string;
  sender_id?: string;
  dm_conversation_id?: string;
  created_at?: string;
}

interface XPage<T> {
  data?: T[];
  includes?: { users?: XUser[] };
  meta?: { next_token?: string };
}

export interface XInboxOptions {
  /** The X app's API key and secret. Default: the `X_API_KEY` and `X_API_SECRET` variables, as the X provider reads them. */
  appKey?: string;
  appSecret?: string;
  /** Fixed values for tests. */
  nonce?: () => string;
  now?: () => Date;
}

/**
 * X (Twitter) API v2 over OAuth 1.0a user context, with the token pair Postiz stores
 * (`oauthToken:oauthTokenSecret`). `ctx.accountId` is the X user id. Every read is billed by X.
 */
export class XInboxReader implements InboxReader {
  readonly identifiers = ['x'] as const;

  constructor(private readonly options: XInboxOptions = {}) {}

  support(): InboxSupport {
    return {
      comments: {
        supported: true,
        note: 'Reads replies to the posts of the last 7 days (recent search) and answers them. X charges for every post read (USD 0.005 each) and for every post created. X may refuse an API reply to someone who did not mention or quote the account first.',
      },
      directMessages: {
        supported: true,
        note: 'Reads and answers direct messages of the last 30 days. Needs the app permission "Read, write and Direct message". X charges USD 0.010 for every message read and 0.015 for every one sent.',
      },
    };
  }

  async listComments(
    ctx: InboxChannelContext,
    posts: InboxPostRef[],
    since: Date | null
  ): Promise<NetworkMessage[]> {
    const startTime = this.searchStart(since);
    const out: NetworkMessage[] = [];
    for (const post of posts) {
      const found = await paginate<{ post: XPost; users: XUser[] }>(async (cursor) => {
        const params = new URLSearchParams({
          query: `conversation_id:${post.networkPostId}`,
          max_results: '100',
          [POST_FIELDS]: 'id,text,created_at,author_id,referenced_tweets',
          expansions: 'author_id',
          'user.fields': 'name,username',
        });
        params.set('start_time', startTime.toISOString());
        if (cursor) {
          params.set('next_token', cursor);
        }
        const page = await this.call<XPage<XPost>>(
          ctx,
          'GET',
          `${X_API}/tweets/search/recent?${params}`
        );
        return {
          items: (page.data ?? []).map((p) => ({ post: p, users: page.includes?.users ?? [] })),
          next: page.meta?.next_token ?? null,
        };
      });

      for (const { post: reply, users } of found) {
        if (reply.id === post.networkPostId) {
          continue; // the conversation search returns the post itself too
        }
        const receivedAt = parseDate(reply.created_at);
        if (!receivedAt || !isOnOrAfter(receivedAt, since)) {
          continue;
        }
        const repliedTo = reply.referenced_tweets?.find((t) => t.type === 'replied_to')?.id;
        const author = users.find((u) => u.id === reply.author_id);
        out.push({
          networkId: reply.id,
          kind: 'comment',
          networkPostId: post.networkPostId,
          parentNetworkId: repliedTo && repliedTo !== post.networkPostId ? repliedTo : null,
          threadId: null,
          authorId: reply.author_id ?? null,
          authorName: author?.name ?? author?.username ?? 'X user',
          text: reply.text ?? '',
          receivedAt,
          fromSelf: reply.author_id === ctx.accountId,
        });
      }
    }
    return out;
  }

  async listMessages(ctx: InboxChannelContext, since: Date | null): Promise<NetworkMessage[]> {
    // The endpoint documents no time filter and no order, so every page is read and filtered here
    const events = await paginate<{ event: XDmEvent; users: XUser[] }>(async (cursor) => {
      const params = new URLSearchParams({
        max_results: '100',
        event_types: 'MessageCreate',
        'dm_event.fields': 'id,event_type,text,sender_id,dm_conversation_id,created_at',
        expansions: 'sender_id',
        'user.fields': 'name,username',
      });
      if (cursor) {
        params.set('pagination_token', cursor);
      }
      const page = await this.call<XPage<XDmEvent>>(ctx, 'GET', `${X_API}/dm_events?${params}`);
      return {
        items: (page.data ?? []).map((e) => ({ event: e, users: page.includes?.users ?? [] })),
        next: page.meta?.next_token ?? null,
      };
    });

    const out: NetworkMessage[] = [];
    for (const { event, users } of events) {
      const receivedAt = parseDate(event.created_at);
      if (!receivedAt || !isOnOrAfter(receivedAt, since)) {
        continue;
      }
      const fromSelf = event.sender_id === ctx.accountId;
      const sender = users.find((u) => u.id === event.sender_id);
      const replyContext: Record<string, string> = {};
      if (event.dm_conversation_id) {
        replyContext.conversationId = event.dm_conversation_id;
      }
      if (event.sender_id && !fromSelf) {
        replyContext.participantId = event.sender_id;
      }
      out.push({
        networkId: event.id,
        kind: 'direct_message',
        networkPostId: null,
        parentNetworkId: null,
        threadId: event.dm_conversation_id ?? null,
        authorId: event.sender_id ?? null,
        authorName: sender?.name ?? sender?.username ?? 'X user',
        text: event.text ?? '',
        receivedAt,
        fromSelf,
        replyContext,
      });
    }
    return out;
  }

  async reply(
    ctx: InboxChannelContext,
    target: InboxReplyTarget,
    text: string
  ): Promise<{ replyId: string | null }> {
    if (target.kind === 'comment') {
      const answer = await this.call<{ data?: { id?: string } }>(ctx, 'POST', `${X_API}/tweets`, {
        text,
        reply: { in_reply_to_tweet_id: target.networkId },
      });
      return { replyId: answer.data?.id ?? null };
    }

    const conversationId = target.replyContext.conversationId ?? target.threadId;
    const participantId = target.replyContext.participantId ?? target.authorId;
    const path = conversationId
      ? `dm_conversations/${encodeURIComponent(conversationId)}/messages`
      : participantId
      ? `dm_conversations/with/${encodeURIComponent(participantId)}/messages`
      : null;
    if (!path) {
      throw new InboxNotSupportedError(
        'X needs to know which conversation or person to answer and this message does not say; read the inbox again and retry.'
      );
    }
    const answer = await this.call<{ data?: { dm_event_id?: string } }>(
      ctx,
      'POST',
      `${X_API}/${path}`,
      { text }
    );
    return { replyId: answer.data?.dm_event_id ?? null };
  }

  /** Recent search only reaches back 7 days, and its start time must be in the past: clamp `since` into that range. */
  private searchStart(since: Date | null): Date {
    const now = (this.options.now ?? (() => new Date()))().getTime();
    const earliest = now - RECENT_SEARCH_DAYS * 24 * 60 * 60 * 1000 + 60 * 1000;
    const latest = now - MIN_AGE_MS;
    const wanted = since ? since.getTime() : earliest;
    return new Date(Math.min(Math.max(wanted, earliest), latest));
  }

  private credentials(ctx: InboxChannelContext): OAuth1Credentials {
    const consumerKey = this.options.appKey ?? process.env.X_API_KEY;
    const consumerSecret = this.options.appSecret ?? process.env.X_API_SECRET;
    if (!consumerKey || !consumerSecret) {
      throw new Error('The X inbox needs the X_API_KEY and X_API_SECRET of the X app, and they are not set.');
    }
    const [token, tokenSecret] = ctx.accessToken.split(':');
    return { consumerKey, consumerSecret, token, tokenSecret };
  }

  private call<T>(
    ctx: InboxChannelContext,
    method: 'GET' | 'POST',
    url: string,
    body?: unknown
  ): Promise<T> {
    const authorization = signOAuth1({
      method,
      url,
      credentials: this.credentials(ctx),
      nonce: this.options.nonce?.(),
      timestamp: this.options.now ? Math.floor(this.options.now().getTime() / 1000) : undefined,
    });
    return inboxRequest<T>(ctx, url, jsonRequest(method, { Authorization: authorization }, body));
  }
}
