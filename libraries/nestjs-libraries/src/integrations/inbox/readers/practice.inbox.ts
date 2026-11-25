import {
  InboxChannelContext,
  InboxNetworkError,
  InboxPostRef,
  InboxReader,
  InboxReplyTarget,
  InboxSupport,
  NetworkMessage,
} from '@gitroom/nestjs-libraries/integrations/inbox/inbox.types';

/**
 * The inbox of the practice network (development and tests only, see practice.provider.ts): comments under the
 * channel's posts and direct messages to its account, read from the pretend network on `PRACTICE_NETWORK_URL`.
 */
const baseUrl = () =>
  (process.env.PRACTICE_NETWORK_URL || 'http://practice-network:4100').replace(
    /\/$/,
    ''
  );

const call = async <T>(
  ctx: InboxChannelContext,
  method: string,
  path: string,
  body?: unknown
): Promise<T> => {
  const response = await (ctx.fetchImpl ?? fetch)(baseUrl() + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new InboxNetworkError(
      `Practice network answered ${response.status} to ${method} ${path}`,
      response.status,
      response.status === 429 || response.status >= 500
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
};

type PracticeComment = {
  id: string;
  authorName: string;
  text: string;
  fromSelf: boolean;
  createdAt: string;
  parentId?: string | null;
};
type PracticeMessage = {
  id: string;
  threadId: string;
  authorName: string;
  text: string;
  fromSelf: boolean;
  createdAt: string;
};

export class PracticeInboxReader implements InboxReader {
  readonly identifiers = ['practice'] as const;

  support(): InboxSupport {
    return {
      comments: { supported: true },
      directMessages: { supported: true },
    };
  }

  async listComments(
    ctx: InboxChannelContext,
    posts: InboxPostRef[],
    since: Date | null
  ): Promise<NetworkMessage[]> {
    const all: NetworkMessage[] = [];
    for (const post of posts) {
      const comments = await call<PracticeComment[]>(
        ctx,
        'GET',
        `/api/posts/${encodeURIComponent(post.networkPostId)}/comments`
      );
      for (const c of comments) {
        const receivedAt = new Date(c.createdAt);
        if (since && receivedAt.getTime() < since.getTime()) {
          continue;
        }
        all.push({
          networkId: c.id,
          kind: 'comment',
          networkPostId: post.networkPostId,
          parentNetworkId: c.parentId ?? null,
          threadId: null,
          authorId: null,
          authorName: c.authorName,
          text: c.text,
          receivedAt,
          fromSelf: c.fromSelf,
          replyContext: {},
        });
      }
    }
    return all;
  }

  async listMessages(
    ctx: InboxChannelContext,
    since: Date | null
  ): Promise<NetworkMessage[]> {
    const messages = await call<PracticeMessage[]>(
      ctx,
      'GET',
      `/api/messages?accountId=${encodeURIComponent(ctx.accountId)}`
    );
    return messages
      .map((m) => ({
        networkId: m.id,
        kind: 'direct_message' as const,
        networkPostId: null,
        parentNetworkId: null,
        threadId: m.threadId,
        authorId: null,
        authorName: m.authorName,
        text: m.text,
        receivedAt: new Date(m.createdAt),
        fromSelf: m.fromSelf,
        replyContext: { threadId: m.threadId },
      }))
      .filter((m) => !since || m.receivedAt.getTime() >= since.getTime());
  }

  async reply(
    ctx: InboxChannelContext,
    target: InboxReplyTarget,
    text: string
  ): Promise<{ replyId: string | null }> {
    if (target.kind === 'comment') {
      const created = await call<{ id: string }>(
        ctx,
        'POST',
        `/api/posts/${encodeURIComponent(target.networkPostId ?? '')}/comments`,
        {
          authorName: ctx.profile || 'account',
          text,
          fromSelf: true,
          parentId: target.networkId,
        }
      );
      return { replyId: created.id };
    }
    const created = await call<{ id: string }>(
      ctx,
      'POST',
      `/api/messages/${encodeURIComponent(target.threadId ?? '')}/reply`,
      { accountId: ctx.accountId, text }
    );
    return { replyId: created.id };
  }
}
