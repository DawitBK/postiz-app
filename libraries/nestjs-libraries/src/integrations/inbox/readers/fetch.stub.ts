import { InboxChannelContext } from '../inbox.types';

/** One request as the reader sent it, ready to be asserted on. */
export interface RecordedRequest {
  url: URL;
  method: string;
  /** Header names in lower case. */
  headers: Record<string, string>;
  /** The body, parsed when it is JSON, otherwise the text. Undefined when there was none. */
  body: any;
}

/** One expected call and the answer to give it. `assert` throws when the reader sent something else. */
export interface FetchStep {
  assert?: (request: RecordedRequest) => void;
  status?: number;
  json?: unknown;
  text?: string;
}

/**
 * A hand-written `fetch` for reader tests: it answers the steps in order, lets each step assert the
 * exact request, and fails on a call nobody expected. `assertDone` fails when a step was never used.
 */
export function scriptedFetch(steps: FetchStep[]) {
  const calls: RecordedRequest[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const step = steps[calls.length];
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (!step) {
      throw new Error(`Unexpected request #${calls.length + 1}: ${method} ${url.origin}${url.pathname}`);
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    let body: any;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const request: RecordedRequest = { url, method, headers, body };
    calls.push(request);
    step.assert?.(request);
    return new Response(step.text ?? JSON.stringify(step.json ?? {}), {
      status: step.status ?? 200,
    });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    assertDone() {
      if (calls.length !== steps.length) {
        throw new Error(`Expected ${steps.length} requests, the reader sent ${calls.length}`);
      }
    },
  };
}

/** A channel context for a test, with the stub as its `fetch`. */
export function channel(
  fetchImpl: typeof fetch,
  overrides: Partial<InboxChannelContext> = {}
): InboxChannelContext {
  return {
    identifier: 'facebook',
    accountId: 'ACCOUNT-1',
    profile: null,
    accessToken: 'tok-secret',
    fetchImpl,
    ...overrides,
  };
}
