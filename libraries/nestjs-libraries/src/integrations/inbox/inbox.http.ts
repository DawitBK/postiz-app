import {
  InboxChannelContext,
  InboxNetworkError,
  InboxTokenError,
} from './inbox.types';

/**
 * One HTTP call for a reader: `fetch` (or the injected one), a JSON answer, and the same error
 * classes for every network. A 401, or a body the network marks as an expired token, becomes
 * InboxTokenError; 429 and 5xx are retryable InboxNetworkError; other failures are not.
 * The token and the full URL (it can carry the token) are never put in an error message.
 */
export async function inboxRequest<T>(
  ctx: InboxChannelContext,
  url: string,
  init: RequestInit = {},
  isTokenFailure: (status: number, body: string) => boolean = (status) =>
    status === 401
): Promise<T> {
  const doFetch = ctx.fetchImpl ?? fetch;
  const response = await doFetch(url, init);
  const text = await response.text();
  if (response.ok) {
    return (text ? JSON.parse(text) : {}) as T;
  }
  const where = `${init.method ?? 'GET'} ${new URL(url).origin}${
    new URL(url).pathname
  }`;
  if (isTokenFailure(response.status, text)) {
    throw new InboxTokenError(`${where}: the network refused the token (${response.status})`);
  }
  throw new InboxNetworkError(
    `${where}: ${response.status} ${text.slice(0, 300)}`,
    response.status,
    response.status === 429 || response.status >= 500
  );
}
