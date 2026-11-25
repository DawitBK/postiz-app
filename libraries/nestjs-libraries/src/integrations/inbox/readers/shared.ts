import { inboxRequest } from '../inbox.http';
import { InboxChannelContext, InboxNetworkError } from '../inbox.types';

/** The most pages any list call walks. The loop is bounded on purpose: a channel is never read to its end. */
export const MAX_PAGES = 5;

/**
 * Reads a time as the networks send it: an ISO string (Meta writes `+0000` without a colon), or a
 * Unix time in seconds or milliseconds, as a number or as digits in a string.
 */
export function parseDate(value: unknown): Date | null {
  let date: Date;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const n = Number(value);
    date = new Date(n < 1e11 ? n * 1000 : n);
  } else if (typeof value === 'string' && value !== '') {
    date = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  } else {
    return null;
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

/** True when there is no lower bound, or the date is on or after it. */
export function isOnOrAfter(date: Date, since: Date | null): boolean {
  return !since || date.getTime() >= since.getTime();
}

/**
 * Walks pages with an opaque cursor (a next-page URL, a page token, an offset), at most `maxPages`.
 * `fetchPage` gets null for the first page and returns the cursor of the next one, or null at the end.
 */
export async function paginate<T>(
  fetchPage: (cursor: string | null) => Promise<{ items: T[]; next: string | null }>,
  maxPages = MAX_PAGES
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const { items, next } = await fetchPage(cursor);
    all.push(...items);
    if (!next) {
      break;
    }
    cursor = next;
  }
  return all;
}

/** A request with a JSON body, or without one. */
export function jsonRequest(
  method: 'GET' | 'POST',
  headers: Record<string, string> = {},
  body?: unknown
): RequestInit {
  return body === undefined
    ? { method, headers }
    : {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      };
}

/** True when `candidate` is an https link on the same origin as `base`: the only links a reader follows. */
export function isSameOrigin(candidate: string, base: string): boolean {
  try {
    return new URL(candidate).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** A failed call that still carries the network's raw answer, so a reader can tell the failure apart. */
export class ReaderHttpError extends InboxNetworkError {
  constructor(message: string, status: number, retryable: boolean, readonly body: string) {
    super(message, status, retryable);
    this.name = 'ReaderHttpError';
  }
}

/**
 * `inboxRequest` for networks that need more from a failed answer than the shared error carries:
 * the raw body stays on the error, and the network can mark more answers as worth a retry
 * (Meta sends its rate limits as plain 400s). The token and the URL never go into a message.
 */
export async function requestKeepingBody<T>(
  ctx: InboxChannelContext,
  url: string,
  init: RequestInit,
  rules: {
    isTokenFailure?: (status: number, body: string) => boolean;
    isRetryable?: (status: number, body: string) => boolean;
  } = {}
): Promise<T> {
  let lastBody = '';
  try {
    return await inboxRequest<T>(ctx, url, init, (status, body) => {
      lastBody = body;
      return rules.isTokenFailure ? rules.isTokenFailure(status, body) : status === 401;
    });
  } catch (error) {
    if (error instanceof InboxNetworkError) {
      throw new ReaderHttpError(
        error.message,
        error.status,
        error.retryable || !!rules.isRetryable?.(error.status, lastBody),
        lastBody
      );
    }
    throw error;
  }
}

/** A value of a JSON body by its path (`['error', 'code']`); undefined when it is missing or the body is not JSON. */
export function jsonPath(body: string, path: string[]): unknown {
  try {
    let node: unknown = JSON.parse(body);
    for (const key of path) {
      node = (node as Record<string, unknown> | undefined)?.[key];
    }
    return node;
  } catch {
    return undefined;
  }
}

/** UTF-8 size of a text, for the networks that limit a message in bytes. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
