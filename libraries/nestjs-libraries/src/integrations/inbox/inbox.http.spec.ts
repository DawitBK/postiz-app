import { inboxRequest } from './inbox.http';
import { InboxNetworkError, InboxTokenError } from './inbox.types';

const ctxWith = (status: number, body: string) => ({
  identifier: 'x',
  accountId: '1',
  accessToken: 'secret-token',
  fetchImpl: (async () =>
    new Response(body, { status })) as unknown as typeof fetch,
});

describe('inboxRequest', () => {
  it('returns the parsed JSON of a successful call', async () => {
    const out = await inboxRequest<{ a: number }>(
      ctxWith(200, '{"a":1}'),
      'https://example.test/v1/x?access_token=secret-token'
    );
    expect(out).toEqual({ a: 1 });
  });

  it('turns a 401 into InboxTokenError without the token in the message', async () => {
    const run = inboxRequest(
      ctxWith(401, 'nope'),
      'https://example.test/v1/x?access_token=secret-token'
    );
    await expect(run).rejects.toBeInstanceOf(InboxTokenError);
    await run.catch((e) => expect(String(e.message)).not.toContain('secret-token'));
  });

  it('marks 429 and 5xx retryable and 4xx not', async () => {
    const a = await inboxRequest(ctxWith(429, ''), 'https://example.test/a').catch((e) => e);
    const b = await inboxRequest(ctxWith(503, ''), 'https://example.test/a').catch((e) => e);
    const c = await inboxRequest(ctxWith(400, ''), 'https://example.test/a').catch((e) => e);
    expect(a).toBeInstanceOf(InboxNetworkError);
    expect(a.retryable).toBe(true);
    expect(b.retryable).toBe(true);
    expect(c.retryable).toBe(false);
  });

  it('lets a network call an expired token by its body (Meta sends 400 with code 190)', async () => {
    const run = inboxRequest(
      ctxWith(400, '{"error":{"code":190}}'),
      'https://example.test/a',
      {},
      (_status, body) => body.includes('"code":190')
    );
    await expect(run).rejects.toBeInstanceOf(InboxTokenError);
  });
});
