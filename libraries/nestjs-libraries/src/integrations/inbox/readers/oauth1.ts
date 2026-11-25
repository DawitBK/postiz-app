import { createHmac, randomBytes } from 'node:crypto';

/**
 * OAuth 1.0a request signing (RFC 5849, HMAC-SHA1), the way X signs user-context calls. Kept here, small
 * and with no dependency, so the X reader can be tested without the Postiz X provider or `twitter-api-v2`.
 */

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/** RFC 3986 percent-encoding, which also encodes `! * ' ( )` (RFC 5849 section 3.6). */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * The signature base string (RFC 5849 section 3.4.1): method, base URL and the sorted parameters
 * (query, form body and `oauth_*`; every name and value encoded, then sorted by name, then value).
 */
export function signatureBaseString(
  method: string,
  baseUrl: string,
  params: Array<[string, string]>
): string {
  const normalized = params
    .map(([name, value]) => [percentEncode(name), percentEncode(value)] as [string, string])
    .sort(([an, av], [bn, bv]) => (an === bn ? (av < bv ? -1 : av > bv ? 1 : 0) : an < bn ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  return [method.toUpperCase(), percentEncode(baseUrl), percentEncode(normalized)].join('&');
}

/** `https://host/path` of a request URL: no query, no fragment, default port dropped (RFC 5849 section 3.4.1.2). */
export function baseUrlOf(url: URL): string {
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`;
}

export interface SignOptions {
  method: string;
  url: string;
  credentials: OAuth1Credentials;
  /** Parameters of a form-encoded body, if the call has one (a JSON body is not part of the signature). */
  formParams?: Array<[string, string]>;
  /** Fixed values for tests; a random nonce and the current time otherwise. */
  nonce?: string;
  timestamp?: number;
}

/** The value of the `Authorization` header for one request. */
export function signOAuth1(options: SignOptions): string {
  const { method, credentials } = options;
  const url = new URL(options.url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: options.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(options.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: credentials.token,
    oauth_version: '1.0',
  };
  const params: Array<[string, string]> = [
    ...url.searchParams.entries(),
    ...(options.formParams ?? []),
    ...Object.entries(oauth),
  ];
  const baseString = signatureBaseString(method, baseUrlOf(url), params);
  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(
    credentials.tokenSecret
  )}`;
  oauth.oauth_signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  return (
    'OAuth ' +
    Object.keys(oauth)
      .sort()
      .map((name) => `${percentEncode(name)}="${percentEncode(oauth[name])}"`)
      .join(', ')
  );
}
