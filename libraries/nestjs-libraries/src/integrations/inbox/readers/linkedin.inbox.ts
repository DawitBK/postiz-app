import { inboxRequest } from '../inbox.http';
import {
  InboxChannelContext,
  InboxNetworkError,
  InboxNotSupportedError,
  InboxPostRef,
  InboxReader,
  InboxReplyTarget,
  InboxSupport,
  NetworkMessage,
} from '../inbox.types';
import { isOnOrAfter, jsonRequest, paginate, parseDate } from './shared';

/** The version header the fork's LinkedIn provider sends on its other calls. */
export const LINKEDIN_API_VERSION = '202601';
const LINKEDIN_REST = 'https://api.linkedin.com/rest';
const PAGE_SIZE = 50;
/** Replies are one call per comment that has any: never more than this many per read. */
const MAX_REPLY_LOOKUPS = 50;

interface LinkedinComment {
  id?: string;
  commentUrn?: string;
  actor?: string;
  object?: string;
  parentComment?: string;
  created?: { time?: number };
  message?: { text?: string };
  commentsSummary?: { totalFirstLevelComments?: number };
}

const PAGE_MESSAGES_REASON =
  'LinkedIn offers no way for an app like this to read or answer Company Page messages. The only Page messaging endpoints are read-only data-export (Digital Markets Act) APIs in a separate product that needs its own application; nothing sends a reply as a Page.';
const MEMBER_COMMENTS_REASON =
  'LinkedIn only lets an app read the comments on a personal profile\'s posts with the r_member_social permission, and LinkedIn is not accepting requests for it. Connect the Company Page ("LinkedIn Page") channel to read comments.';
const MEMBER_MESSAGES_REASON =
  'LinkedIn\'s Messages API is restricted to approved partners under an API agreement; there is no messaging access for this app.';

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'LinkedIn-Version': LINKEDIN_API_VERSION,
  'X-Restli-Protocol-Version': '2.0.0',
});

/** Rest.li 2.0 wants the URN in the path percent-encoded, brackets and commas included. */
const urnInPath = (urn: string) =>
  encodeURIComponent(urn).replace(/\(/g, '%28').replace(/\)/g, '%29');

async function fetchComments(
  ctx: InboxChannelContext,
  targetUrn: string
): Promise<LinkedinComment[]> {
  return paginate<LinkedinComment>(async (cursor) => {
    const start = cursor ? Number(cursor) : 0;
    const body = await inboxRequest<{ elements?: LinkedinComment[] }>(
      ctx,
      `${LINKEDIN_REST}/socialActions/${urnInPath(targetUrn)}/comments?count=${PAGE_SIZE}&start=${start}`,
      jsonRequest('GET', headers(ctx.accessToken))
    );
    const items = body.elements ?? [];
    // the end of the data is a page with fewer elements than asked for
    return { items, next: items.length < PAGE_SIZE ? null : String(start + PAGE_SIZE) };
  });
}

/**
 * LinkedIn Company Pages: comments on the Page's posts (Community Management API). `ctx.accountId` is
 * the organization id; the Page answers as `urn:li:organization:<id>`. LinkedIn gives the author only as
 * a URN, so names are not resolved here (that needs profile calls and permissions of its own).
 */
export class LinkedinInboxReader implements InboxReader {
  readonly identifiers = ['linkedin-page'] as const;

  support(): InboxSupport {
    return {
      comments: {
        supported: true,
        note: 'Reads comments and replies on the Page posts and answers them as the Page. Needs the Community Management API (r_organization_social and w_organization_social) and a Page administrator. Authors come as LinkedIn URNs, without names.',
      },
      directMessages: {
        supported: false,
        reason: PAGE_MESSAGES_REASON,
      },
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
      let topLevel: LinkedinComment[];
      try {
        topLevel = await fetchComments(ctx, post.networkPostId);
      } catch (error) {
        // a deleted post must not stop the others from being read
        if (error instanceof InboxNetworkError && error.status === 404) {
          continue;
        }
        throw error;
      }
      for (const comment of topLevel) {
        const urn = this.urnOf(comment);
        this.push(out, ctx, post.networkPostId, comment, comment.parentComment ?? null, since);
        if (
          urn &&
          !comment.parentComment &&
          (comment.commentsSummary?.totalFirstLevelComments ?? 0) > 0 &&
          replyLookups < MAX_REPLY_LOOKUPS
        ) {
          replyLookups++;
          for (const reply of await fetchComments(ctx, urn)) {
            this.push(out, ctx, post.networkPostId, reply, reply.parentComment ?? urn, since);
          }
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
      throw new InboxNotSupportedError(PAGE_MESSAGES_REASON);
    }
    if (!target.networkPostId) {
      throw new InboxNotSupportedError(
        'This comment does not say which post it belongs to, and LinkedIn needs that to answer it; read the inbox again and retry.'
      );
    }
    // A reply to a reply goes to the top-level comment (LinkedIn threads are two levels deep).
    const parentComment = target.parentNetworkId ?? target.networkId;
    const answer = await inboxRequest<{ commentUrn?: string; id?: string }>(
      ctx,
      `${LINKEDIN_REST}/socialActions/${urnInPath(parentComment)}/comments`,
      jsonRequest('POST', headers(ctx.accessToken), {
        actor: `urn:li:organization:${ctx.accountId}`,
        object: target.networkPostId,
        message: { text },
        parentComment,
      })
    );
    return { replyId: answer.commentUrn ?? answer.id ?? null };
  }

  private urnOf(comment: LinkedinComment): string | null {
    if (comment.commentUrn) {
      return comment.commentUrn;
    }
    return comment.object && comment.id
      ? `urn:li:comment:(${comment.object},${comment.id})`
      : null;
  }

  private push(
    out: NetworkMessage[],
    ctx: InboxChannelContext,
    networkPostId: string,
    comment: LinkedinComment,
    parentNetworkId: string | null,
    since: Date | null
  ) {
    const networkId = this.urnOf(comment);
    const receivedAt = parseDate(comment.created?.time);
    if (!networkId || !receivedAt || !isOnOrAfter(receivedAt, since)) {
      return;
    }
    out.push({
      networkId,
      kind: 'comment',
      networkPostId,
      parentNetworkId,
      threadId: null,
      authorId: comment.actor ?? null,
      authorName: comment.actor?.startsWith('urn:li:organization:')
        ? 'LinkedIn Page'
        : 'LinkedIn member',
      text: comment.message?.text ?? '',
      receivedAt,
      fromSelf: comment.actor === `urn:li:organization:${ctx.accountId}`,
      replyContext: comment.actor ? { actorUrn: comment.actor } : undefined,
    });
  }
}

/**
 * A personal LinkedIn profile channel (`linkedin`). Reading comments on a member's posts needs
 * r_member_social, which LinkedIn has closed to new requests, so this reader only says so.
 */
export class LinkedinMemberInboxReader implements InboxReader {
  readonly identifiers = ['linkedin'] as const;

  support(): InboxSupport {
    return {
      comments: { supported: false, reason: MEMBER_COMMENTS_REASON },
      directMessages: { supported: false, reason: MEMBER_MESSAGES_REASON },
    };
  }

  async reply(
    _ctx: InboxChannelContext,
    target: InboxReplyTarget
  ): Promise<{ replyId: string | null }> {
    throw new InboxNotSupportedError(
      target.kind === 'comment' ? MEMBER_COMMENTS_REASON : MEMBER_MESSAGES_REASON
    );
  }
}
