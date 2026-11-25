/**
 * Unified inbox (DCC task W-08): the contract between the inbox service and one reader per network.
 *
 * Deliberately a pure module: no Nest, no Prisma and no Postiz imports, so the readers can be unit
 * tested on their own with `fetch` mocked, and an upgrade of Postiz cannot break them.
 */

export type InboxKind = 'comment' | 'direct_message';

/** Everything a reader needs about one connected channel. Built by the service from the Integration row. */
export interface InboxChannelContext {
  /** Postiz provider identifier, e.g. `facebook`, `linkedin-page`, `x`. */
  identifier: string;
  /** The network's own id of the connected account or page (`Integration.internalId`). */
  accountId: string;
  /** The account's handle or profile name, when Postiz stored one (`Integration.profile`). */
  profile?: string | null;
  /** The channel's access token. For X this is `oauthToken:oauthTokenSecret`, as Postiz stores it. */
  accessToken: string;
  /** Injected in tests. Production uses the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** A post DCC published (Postiz `Post` with a `releaseId`), in the window the inbox reads comments for. */
export interface InboxPostRef {
  /** The network's own id for the post (`Post.releaseId`). */
  networkPostId: string;
  releaseUrl: string | null;
  publishedAt: Date;
}

/** One comment or message as a network reports it. */
export interface NetworkMessage {
  /** The network's id of this comment or message. Unique per channel and kind. */
  networkId: string;
  kind: InboxKind;
  /** Comments: the network id of the post the comment belongs to. Direct messages: null. */
  networkPostId: string | null;
  /** Comments: the network id of the comment this one answers, null for a top-level comment. */
  parentNetworkId: string | null;
  /** Direct messages: the conversation id. Comments: null. */
  threadId: string | null;
  authorId: string | null;
  authorName: string;
  text: string;
  receivedAt: Date;
  /**
   * True when the connected account itself wrote it. Such items are never shown as inbox work: the
   * service uses them to mark the message they answer as replied.
   */
  fromSelf: boolean;
  /** Opaque values the reader needs again to answer (a recipient id, a parent URN). Stored as JSON. */
  replyContext?: Record<string, string>;
}

/** What a reader gets back when the service asks it to answer one stored message. */
export interface InboxReplyTarget {
  networkId: string;
  kind: InboxKind;
  networkPostId: string | null;
  parentNetworkId: string | null;
  threadId: string | null;
  authorId: string | null;
  replyContext: Record<string, string>;
}

export type InboxAllowance =
  | { supported: true; note?: string }
  | { supported: false; reason: string };

/** What the network's API allows for this channel. Shown to DCC as is: it never pretends. */
export interface InboxSupport {
  comments: InboxAllowance;
  directMessages: InboxAllowance;
}

export interface InboxReader {
  /** Postiz provider identifiers this reader serves. */
  readonly identifiers: readonly string[];
  support(): InboxSupport;
  /** Comments under the given posts of this channel. Absent when `support().comments` is not supported. */
  listComments?(
    ctx: InboxChannelContext,
    posts: InboxPostRef[],
    since: Date | null
  ): Promise<NetworkMessage[]>;
  /** Direct messages of this channel. Absent when `support().directMessages` is not supported. */
  listMessages?(
    ctx: InboxChannelContext,
    since: Date | null
  ): Promise<NetworkMessage[]>;
  /**
   * Publish a reply. Throws InboxNotSupportedError when the network does not allow it for this kind
   * of message; never fakes success.
   */
  reply(
    ctx: InboxChannelContext,
    target: InboxReplyTarget,
    text: string
  ): Promise<{ replyId: string | null }>;
}

/** The network's API does not allow this (no endpoint, no permission, a window that closed). The message is shown to DCC. */
export class InboxNotSupportedError extends Error {
  readonly code = 'not_supported';
  constructor(message: string) {
    super(message);
    this.name = 'InboxNotSupportedError';
  }
}

/** The token was refused (expired, revoked). The service refreshes the token once and retries. */
export class InboxTokenError extends Error {
  readonly code = 'token_refused';
  constructor(message: string) {
    super(message);
    this.name = 'InboxTokenError';
  }
}

/** Any other failure of the network call. `retryable` is true for 429 and 5xx. */
export class InboxNetworkError extends Error {
  readonly code = 'network_error';
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'InboxNetworkError';
  }
}
