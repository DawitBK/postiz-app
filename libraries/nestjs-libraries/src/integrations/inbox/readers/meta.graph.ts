import {
  InboxChannelContext,
  InboxNotSupportedError,
  InboxReplyTarget,
  NetworkMessage,
} from '../inbox.types';
import {
  byteLength,
  isOnOrAfter,
  isSameOrigin,
  jsonPath,
  jsonRequest,
  paginate,
  parseDate,
  ReaderHttpError,
  requestKeepingBody,
} from './shared';

/** The Graph API version the fork's Facebook provider uses (`META_GRAPH_API_VERSION`). */
export const META_GRAPH_API_VERSION = 'v25.0';
export const GRAPH_FACEBOOK = 'https://graph.facebook.com';
export const GRAPH_INSTAGRAM = 'https://graph.instagram.com';

const HOUR_MS = 60 * 60 * 1000;
const STANDARD_WINDOW_MS = 24 * HOUR_MS;
const HUMAN_AGENT_WINDOW_MS = 7 * 24 * HOUR_MS;

/** Meta's rate-limit error codes (Graph API rate limiting guide). Meta sends them as plain 400s. */
const THROTTLE_CODES = [4, 17, 32, 613, 80001, 80002, 80006];

export function graphUrl(
  host: string,
  path: string,
  params: Record<string, string | number | undefined>
): string {
  const url = new URL(`${host}/${META_GRAPH_API_VERSION}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** `error.code` and `error.error_subcode` of a Graph error answer. */
export function graphErrorCodes(body: string): {
  code: number | null;
  subcode: number | null;
} {
  const code = jsonPath(body, ['error', 'code']);
  const subcode = jsonPath(body, ['error', 'error_subcode']);
  return {
    code: typeof code === 'number' ? code : null,
    subcode: typeof subcode === 'number' ? subcode : null,
  };
}

/** Code 190 is an expired or invalid token; code 102 without a subcode is the same (Graph error handling guide). */
function isGraphTokenFailure(status: number, body: string): boolean {
  const { code, subcode } = graphErrorCodes(body);
  return status === 401 || code === 190 || (code === 102 && subcode === null);
}

export function graphRequest<T>(
  ctx: InboxChannelContext,
  url: string,
  init: RequestInit = { method: 'GET' }
): Promise<T> {
  return requestKeepingBody<T>(ctx, url, init, {
    isTokenFailure: isGraphTokenFailure,
    isRetryable: (_status, body) => {
      const { code } = graphErrorCodes(body);
      return code !== null && THROTTLE_CODES.includes(code);
    },
  });
}

/** The post or object is gone, or this token cannot see it: skip it instead of failing the whole read. */
export function isMissingGraphObject(error: unknown): boolean {
  if (!(error instanceof ReaderHttpError)) {
    return false;
  }
  const { code, subcode } = graphErrorCodes(error.body);
  return error.status === 404 || (code === 100 && subcode === 33);
}

interface GraphPage<T> {
  data?: T[];
  paging?: { next?: string };
}

/** Follows `paging.next` (at most MAX_PAGES), and only on the host the call started on. */
export function graphPages<T>(
  ctx: InboxChannelContext,
  firstUrl: string,
  host: string
): Promise<T[]> {
  return paginate<T>(async (cursor) => {
    const page = await graphRequest<GraphPage<T>>(ctx, cursor ?? firstUrl);
    const next = page.paging?.next ?? null;
    if (next && !isSameOrigin(next, host)) {
      throw new ReaderHttpError(
        'The network sent a paging link to another host; it was not followed',
        0,
        false,
        ''
      );
    }
    return { items: page.data ?? [], next };
  });
}

/* ------------------------------ direct messages ------------------------------ */

interface GraphParty {
  id?: string;
  name?: string;
  username?: string;
}

interface GraphMessage {
  id: string;
  created_time?: string | number;
  message?: string;
  from?: GraphParty;
  to?: { data?: GraphParty[] };
}

interface GraphConversation {
  id: string;
  updated_time?: string | number;
  messages?: { data?: GraphMessage[] };
}

/** What differs between Messenger and Instagram messaging; the calls are the same shape. */
export interface GraphDmConfig {
  host: string;
  token: string;
  platform: 'messenger' | 'instagram';
  /** Ids that mean "the connected account itself". */
  selfIds: string[];
  /** Handles (lower case) that mean the connected account itself. */
  selfHandles: string[];
  /** Messenger asks for `messaging_type: RESPONSE` on a normal answer; Instagram sends only recipient and message. */
  sendsMessagingType: boolean;
  /** Instagram limits a direct message to this many bytes of UTF-8 text. */
  maxBytes: number | null;
  label: string;
}

function isSelf(cfg: GraphDmConfig, party?: GraphParty): boolean {
  if (!party) {
    return false;
  }
  return (
    (!!party.id && cfg.selfIds.includes(party.id)) ||
    (!!party.username && cfg.selfHandles.includes(party.username.toLowerCase()))
  );
}

/**
 * Conversations with their latest messages in one call per page (Graph field expansion:
 * `messages.limit(20){...}`; Meta only returns details for the 20 most recent messages anyway).
 * `me` is the Page or the Instagram account that owns the token.
 */
export async function listGraphMessages(
  ctx: InboxChannelContext,
  cfg: GraphDmConfig,
  since: Date | null
): Promise<NetworkMessage[]> {
  const firstUrl = graphUrl(cfg.host, 'me/conversations', {
    platform: cfg.platform,
    fields: 'id,updated_time,messages.limit(20){id,created_time,from,to,message}',
    limit: 25,
    access_token: cfg.token,
  });
  const conversations = await graphPages<GraphConversation>(ctx, firstUrl, cfg.host);

  const out: NetworkMessage[] = [];
  for (const conversation of conversations) {
    const updatedAt = parseDate(conversation.updated_time);
    if (updatedAt && !isOnOrAfter(updatedAt, since)) {
      continue;
    }
    const messages = conversation.messages?.data ?? [];
    const lastInbound = messages
      .filter((m) => !isSelf(cfg, m.from))
      .map((m) => parseDate(m.created_time))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    for (const message of messages) {
      const receivedAt = parseDate(message.created_time);
      if (!receivedAt || !isOnOrAfter(receivedAt, since)) {
        continue;
      }
      const fromSelf = isSelf(cfg, message.from);
      const otherParty = fromSelf ? message.to?.data?.[0] : message.from;
      const replyContext: Record<string, string> = {};
      if (otherParty?.id) {
        replyContext.recipientId = otherParty.id;
      }
      if (lastInbound) {
        replyContext.lastInboundAt = lastInbound.toISOString();
      }
      out.push({
        networkId: message.id,
        kind: 'direct_message',
        networkPostId: null,
        parentNetworkId: null,
        threadId: conversation.id,
        authorId: message.from?.id ?? null,
        authorName: message.from?.name ?? message.from?.username ?? `${cfg.label} user`,
        text: message.message ?? '',
        receivedAt,
        fromSelf,
        replyContext,
      });
    }
  }
  return out;
}

/**
 * Sends the answer to the person who wrote. Inside 24 hours of their last message it is a normal
 * answer; up to 7 days it needs the human agent tag; after that Meta refuses, so we say so first.
 */
export async function replyGraphMessage(
  ctx: InboxChannelContext,
  cfg: GraphDmConfig,
  target: InboxReplyTarget,
  text: string,
  now: Date
): Promise<{ replyId: string | null }> {
  const recipientId = target.replyContext.recipientId ?? target.authorId;
  if (!recipientId) {
    throw new InboxNotSupportedError(
      `${cfg.label} needs to know who to answer and this message does not say; read the inbox again and retry.`
    );
  }
  if (cfg.maxBytes !== null && byteLength(text) > cfg.maxBytes) {
    throw new InboxNotSupportedError(
      `${cfg.label} limits a direct message to ${cfg.maxBytes} bytes of text; this reply is ${byteLength(
        text
      )}. Shorten it and send again.`
    );
  }

  const lastInbound = parseDate(target.replyContext.lastInboundAt);
  const age = lastInbound ? now.getTime() - lastInbound.getTime() : null;
  if (age !== null && age > HUMAN_AGENT_WINDOW_MS) {
    throw new InboxNotSupportedError(
      `${cfg.label} only lets an account answer within 24 hours of the person's last message, or within 7 days with the human agent tag. Their last message is ${Math.floor(
        age / (24 * HOUR_MS)
      )} days old, so the window has closed.`
    );
  }

  const body: Record<string, unknown> = {
    recipient: { id: recipientId },
    message: { text },
  };
  if (age !== null && age > STANDARD_WINDOW_MS) {
    body.messaging_type = 'MESSAGE_TAG';
    body.tag = 'HUMAN_AGENT';
  } else if (cfg.sendsMessagingType) {
    body.messaging_type = 'RESPONSE';
  }

  const url = graphUrl(cfg.host, 'me/messages', { access_token: cfg.token });
  const answer = await graphRequest<{ message_id?: string }>(
    ctx,
    url,
    jsonRequest('POST', {}, body)
  );
  return { replyId: answer.message_id ?? null };
}
