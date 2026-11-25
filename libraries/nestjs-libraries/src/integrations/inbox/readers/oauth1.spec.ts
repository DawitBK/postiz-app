import {
  percentEncode,
  signatureBaseString,
  signOAuth1,
} from './oauth1';

// The worked example of X's "Creating a signature" page (docs.x.com), with the secrets it prints.
const X_DOCS_CREDENTIALS = {
  consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
  consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
  token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
  tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
};

describe('percentEncode', () => {
  it('encodes the characters RFC 3986 reserves, including ! * \' ( )', () => {
    expect(percentEncode("Ladies + Gentlemen! (*')")).toBe(
      'Ladies%20%2B%20Gentlemen%21%20%28%2A%27%29'
    );
    expect(percentEncode('a-b_c.d~e')).toBe('a-b_c.d~e');
  });
});

describe('signatureBaseString', () => {
  it('matches the example of RFC 5849 section 3.4.1.1 (duplicate names, encoded values, empty values)', () => {
    const base = signatureBaseString('POST', 'http://example.com/request', [
      ['b5', '=%3D'],
      ['a3', 'a'],
      ['c@', ''],
      ['a2', 'r b'],
      ['c2', ''],
      ['a3', '2 q'],
      ['oauth_consumer_key', '9djdj82h48djs9d2'],
      ['oauth_token', 'kkk9d7dh3k39sjv7'],
      ['oauth_signature_method', 'HMAC-SHA1'],
      ['oauth_timestamp', '137131201'],
      ['oauth_nonce', '7d8f3e4a'],
    ]);
    expect(base).toBe(
      'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q' +
        '%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key' +
        '%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method' +
        '%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7'
    );
  });
});

describe('signOAuth1', () => {
  it('reproduces the signature printed on X\'s "Creating a signature" page', () => {
    // a form-encoded body: its parameters are signed together with the oauth ones
    const header = signOAuth1({
      method: 'POST',
      url: 'https://api.x.com/1.1/statuses/update.json?include_entities=true',
      credentials: X_DOCS_CREDENTIALS,
      formParams: [['status', 'Hello Ladies + Gentlemen, a signed OAuth request!']],
      nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      timestamp: 1318622958,
    });
    expect(header).toBe(
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", ' +
        'oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", ' +
        'oauth_signature="Ls93hJiZbQ3akF3HF3x1Bz8%2FzU4%3D", ' +
        'oauth_signature_method="HMAC-SHA1", ' +
        'oauth_timestamp="1318622958", ' +
        'oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", ' +
        'oauth_version="1.0"'
    );
  });

  it('reproduces the signature of the same example on the old api.twitter.com host', () => {
    const header = signOAuth1({
      method: 'POST',
      url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
      credentials: X_DOCS_CREDENTIALS,
      formParams: [['status', 'Hello Ladies + Gentlemen, a signed OAuth request!']],
      nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      timestamp: 1318622958,
    });
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });

  it('signs the query string of a GET, so a changed query changes the signature', () => {
    const sign = (query: string) =>
      signOAuth1({
        method: 'GET',
        url: `https://api.x.com/2/tweets/search/recent?${query}`,
        credentials: X_DOCS_CREDENTIALS,
        nonce: 'n',
        timestamp: 1,
      });
    expect(sign('query=conversation_id%3A1')).not.toBe(sign('query=conversation_id%3A2'));
    expect(sign('query=conversation_id%3A1')).toBe(sign('query=conversation_id%3A1'));
  });

  it('uses a fresh nonce on every call when none is given', () => {
    const sign = () =>
      signOAuth1({ method: 'GET', url: 'https://api.x.com/2/users/me', credentials: X_DOCS_CREDENTIALS });
    expect(sign()).not.toBe(sign());
  });
});
