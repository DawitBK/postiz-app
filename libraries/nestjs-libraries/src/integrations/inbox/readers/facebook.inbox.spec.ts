import {
  InboxNetworkError,
  InboxNotSupportedError,
  InboxPostRef,
  InboxReplyTarget,
  InboxTokenError,
} from '../inbox.types';
import { FacebookInboxReader } from './facebook.inbox';
import { channel, scriptedFetch } from './fetch.stub';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const POST: InboxPostRef = {
  networkPostId: 'PAGE-1_POST-1',
  releaseUrl: null,
  publishedAt: new Date('2026-11-20T08:00:00Z'),
};
const reader = new FacebookInboxReader(() => NOW);
const params = (url: URL) => Object.fromEntries(url.searchParams);

// shaped like the Pages API "read comments" answer: created_time, from{name,id}, message, id, paging
const commentsPage1 = {
  data: [
    {
      created_time: '2026-11-24T10:00:00+0000',
      from: { name: 'Ana Bekele', id: 'USER-1' },
      message: 'When does it open?',
      id: 'PAGE-1_POST-1_c1',
    },
    {
      created_time: '2026-11-24T11:30:00+0000',
      from: { name: 'The Page', id: 'PAGE-1' },
      message: 'Next week.',
      id: 'PAGE-1_POST-1_c2',
      parent: { id: 'PAGE-1_POST-1_c1' },
    },
  ],
  paging: {
    cursors: { before: 'B1', after: 'A1' },
    next: 'https://graph.facebook.com/v25.0/PAGE-1_POST-1/comments?after=A1&access_token=tok-secret',
  },
};
const commentsPage2 = {
  data: [
    {
      created_time: '2026-11-23T09:00:00+0000',
      message: 'No name on this one',
      id: 'PAGE-1_POST-1_c3',
    },
  ],
  paging: { cursors: { before: 'B2', after: 'A2' } },
};

describe('FacebookInboxReader', () => {
  it('says what Facebook allows: comments and Messenger, with their permissions and the window', () => {
    const support = reader.support();
    expect(reader.identifiers).toEqual(['facebook']);
    expect(support.comments).toMatchObject({ supported: true });
    expect((support.comments as { note: string }).note).toContain('pages_manage_engagement');
    expect((support.directMessages as { note: string }).note).toContain('pages_messaging');
    expect((support.directMessages as { note: string }).note).toContain('24 hours');
  });

  describe('listComments', () => {
    it('reads a post with the exact request and maps replies, authors and fromSelf', async () => {
      const stub = scriptedFetch([
        {
          json: { ...commentsPage2, data: commentsPage1.data },
          assert: (req) => {
            expect(req.method).toBe('GET');
            expect(req.url.origin + req.url.pathname).toBe(
              'https://graph.facebook.com/v25.0/PAGE-1_POST-1/comments'
            );
            expect(params(req.url)).toEqual({
              filter: 'stream',
              order: 'chronological',
              limit: '100',
              fields: 'id,message,created_time,from,parent{id}',
              access_token: 'tok-secret',
            });
          },
        },
      ]);
      const out = await reader.listComments(
        channel(stub.fetchImpl, { accountId: 'PAGE-1' }),
        [POST],
        null
      );
      stub.assertDone();
      expect(out).toEqual([
        {
          networkId: 'PAGE-1_POST-1_c1',
          kind: 'comment',
          networkPostId: 'PAGE-1_POST-1',
          parentNetworkId: null,
          threadId: null,
          authorId: 'USER-1',
          authorName: 'Ana Bekele',
          text: 'When does it open?',
          receivedAt: new Date('2026-11-24T10:00:00Z'),
          fromSelf: false,
        },
        {
          networkId: 'PAGE-1_POST-1_c2',
          kind: 'comment',
          networkPostId: 'PAGE-1_POST-1',
          parentNetworkId: 'PAGE-1_POST-1_c1',
          threadId: null,
          authorId: 'PAGE-1',
          authorName: 'The Page',
          text: 'Next week.',
          receivedAt: new Date('2026-11-24T11:30:00Z'),
          fromSelf: true,
        },
      ]);
    });

    it('follows paging.next to the next page, and keeps a comment without an author', async () => {
      const stub = scriptedFetch([
        { json: commentsPage1 },
        {
          json: commentsPage2,
          assert: (req) => {
            // exactly the link the network gave, token included
            expect(req.url.toString()).toBe(commentsPage1.paging.next);
          },
        },
      ]);
      const out = await reader.listComments(channel(stub.fetchImpl, { accountId: 'PAGE-1' }), [POST], null);
      stub.assertDone();
      expect(out.map((m) => m.networkId)).toEqual([
        'PAGE-1_POST-1_c1',
        'PAGE-1_POST-1_c2',
        'PAGE-1_POST-1_c3',
      ]);
      expect(out[2]).toMatchObject({ authorId: null, authorName: 'Facebook user', fromSelf: false });
    });

    it('stops after 5 pages even when the network keeps offering more', async () => {
      const endless = {
        data: [],
        paging: { next: 'https://graph.facebook.com/v25.0/PAGE-1_POST-1/comments?after=X' },
      };
      const stub = scriptedFetch([1, 2, 3, 4, 5].map(() => ({ json: endless })));
      await reader.listComments(channel(stub.fetchImpl), [POST], null);
      stub.assertDone();
      expect(stub.calls).toHaveLength(5);
    });

    it('refuses to follow a paging link that points to another host', async () => {
      const stub = scriptedFetch([
        { json: { data: [], paging: { next: 'https://evil.example/steal?access_token=tok-secret' } } },
      ]);
      const run = reader.listComments(channel(stub.fetchImpl), [POST], null);
      await expect(run).rejects.toBeInstanceOf(InboxNetworkError);
      expect(stub.calls).toHaveLength(1);
    });

    it('sends since as Unix seconds and drops comments older than it', async () => {
      const since = new Date('2026-11-24T10:30:00Z');
      const stub = scriptedFetch([
        {
          json: commentsPage1,
          assert: (req) => expect(req.url.searchParams.get('since')).toBe(String(since.getTime() / 1000)),
        },
        { json: { data: [] } },
      ]);
      const out = await reader.listComments(channel(stub.fetchImpl, { accountId: 'PAGE-1' }), [POST], since);
      expect(out.map((m) => m.networkId)).toEqual(['PAGE-1_POST-1_c2']);
    });

    it('skips a post Facebook says it cannot load, and still reads the next one', async () => {
      const stub = scriptedFetch([
        {
          status: 400,
          json: {
            error: {
              message: 'Unsupported get request. Object with ID does not exist',
              type: 'GraphMethodException',
              code: 100,
              error_subcode: 33,
              fbtrace_id: 'x',
            },
          },
        },
        {
          json: commentsPage2,
          assert: (req) => expect(req.url.pathname).toBe('/v25.0/PAGE-1_POST-2/comments'),
        },
      ]);
      const out = await reader.listComments(
        channel(stub.fetchImpl),
        [{ ...POST, networkPostId: 'PAGE-1_POST-GONE' }, { ...POST, networkPostId: 'PAGE-1_POST-2' }],
        null
      );
      stub.assertDone();
      expect(out.map((m) => m.networkId)).toEqual(['PAGE-1_POST-1_c3']);
    });

    it('turns an expired token (code 190, sent as 400) into InboxTokenError without the token in the message', async () => {
      const stub = scriptedFetch([
        {
          status: 400,
          json: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190, error_subcode: 463 } },
        },
      ]);
      const error = await reader.listComments(channel(stub.fetchImpl), [POST], null).catch((e) => e);
      expect(error).toBeInstanceOf(InboxTokenError);
      expect(String(error.message)).not.toContain('tok-secret');
    });

    it('marks a Meta rate limit (code 613, sent as 400) retryable, and a permission error not', async () => {
      const throttled = scriptedFetch([{ status: 400, json: { error: { code: 613, message: 'Calls to this api have exceeded the rate limit.' } } }]);
      const denied = scriptedFetch([{ status: 403, json: { error: { code: 200, message: '(#200) Requires pages_read_engagement' } } }]);
      const a = await reader.listComments(channel(throttled.fetchImpl), [POST], null).catch((e) => e);
      const b = await reader.listComments(channel(denied.fetchImpl), [POST], null).catch((e) => e);
      expect(a).toBeInstanceOf(InboxNetworkError);
      expect(a.retryable).toBe(true);
      expect(b).toBeInstanceOf(InboxNetworkError);
      expect(b.retryable).toBe(false);
    });
  });

  describe('listMessages', () => {
    // shaped like the Conversations API: a conversation with its latest messages, Messenger from{id,name,email}
    const conversations = {
      data: [
        {
          id: 't_conv1',
          updated_time: '2026-11-25T09:00:00+0000',
          messages: {
            data: [
              {
                id: 'm_3',
                created_time: '2026-11-25T09:00:00+0000',
                from: { id: 'PAGE-1', name: 'The Page' },
                to: { data: [{ id: 'PSID-1', name: 'Ana Bekele' }] },
                message: 'Yes, 9 to 5.',
              },
              {
                id: 'm_2',
                created_time: '2026-11-25T08:00:00+0000',
                from: { id: 'PSID-1', name: 'Ana Bekele', email: 'ana@example.test' },
                to: { data: [{ id: 'PAGE-1', name: 'The Page' }] },
                message: 'Are you open on Saturday?',
              },
            ],
          },
        },
        {
          id: 't_old',
          updated_time: '2026-10-01T09:00:00+0000',
          messages: {
            data: [
              {
                id: 'm_1',
                created_time: '2026-10-01T09:00:00+0000',
                from: { id: 'PSID-2', name: 'Old Friend' },
                to: { data: [{ id: 'PAGE-1' }] },
                message: 'Hello',
              },
            ],
          },
        },
      ],
    };

    it('reads conversations with the exact request and maps who wrote, the thread and the reply context', async () => {
      const stub = scriptedFetch([
        {
          json: conversations,
          assert: (req) => {
            expect(req.method).toBe('GET');
            expect(req.url.origin + req.url.pathname).toBe('https://graph.facebook.com/v25.0/me/conversations');
            expect(params(req.url)).toEqual({
              platform: 'messenger',
              fields: 'id,updated_time,messages.limit(20){id,created_time,from,to,message}',
              limit: '25',
              access_token: 'tok-secret',
            });
          },
        },
      ]);
      const out = await reader.listMessages(channel(stub.fetchImpl, { accountId: 'PAGE-1' }), null);
      stub.assertDone();
      expect(out).toHaveLength(3);
      const inbound = out.find((m) => m.networkId === 'm_2')!;
      expect(inbound).toMatchObject({
        kind: 'direct_message',
        networkPostId: null,
        parentNetworkId: null,
        threadId: 't_conv1',
        authorId: 'PSID-1',
        authorName: 'Ana Bekele',
        text: 'Are you open on Saturday?',
        receivedAt: new Date('2026-11-25T08:00:00Z'),
        fromSelf: false,
        replyContext: { recipientId: 'PSID-1', lastInboundAt: '2026-11-25T08:00:00.000Z' },
      });
      const own = out.find((m) => m.networkId === 'm_3')!;
      expect(own.fromSelf).toBe(true);
      expect(own.replyContext).toEqual({ recipientId: 'PSID-1', lastInboundAt: '2026-11-25T08:00:00.000Z' });
    });

    it('drops conversations and messages older than since', async () => {
      const stub = scriptedFetch([{ json: conversations }]);
      const out = await reader.listMessages(
        channel(stub.fetchImpl, { accountId: 'PAGE-1' }),
        new Date('2026-11-25T08:30:00Z')
      );
      expect(out.map((m) => m.networkId)).toEqual(['m_3']);
    });

    it('pages through conversations with paging.next', async () => {
      const stub = scriptedFetch([
        { json: { data: [], paging: { next: 'https://graph.facebook.com/v25.0/me/conversations?after=A&access_token=tok-secret' } } },
        {
          json: { data: [] },
          assert: (req) => expect(req.url.searchParams.get('after')).toBe('A'),
        },
      ]);
      await reader.listMessages(channel(stub.fetchImpl), null);
      stub.assertDone();
    });

    it('turns code 190 into InboxTokenError', async () => {
      const stub = scriptedFetch([{ status: 400, json: { error: { code: 190, message: 'expired' } } }]);
      await expect(reader.listMessages(channel(stub.fetchImpl), null)).rejects.toBeInstanceOf(InboxTokenError);
    });
  });

  describe('reply', () => {
    const commentTarget: InboxReplyTarget = {
      networkId: 'PAGE-1_POST-1_c1',
      kind: 'comment',
      networkPostId: 'PAGE-1_POST-1',
      parentNetworkId: null,
      threadId: null,
      authorId: 'USER-1',
      replyContext: {},
    };
    const dmTarget = (lastInboundAt?: string): InboxReplyTarget => ({
      networkId: 'm_2',
      kind: 'direct_message',
      networkPostId: null,
      parentNetworkId: null,
      threadId: 't_conv1',
      authorId: 'PSID-1',
      replyContext: { recipientId: 'PSID-1', ...(lastInboundAt ? { lastInboundAt } : {}) },
    });

    it('answers a comment with a comment on it, as the Page', async () => {
      const stub = scriptedFetch([
        {
          json: { id: 'PAGE-1_POST-1_c9' },
          assert: (req) => {
            expect(req.method).toBe('POST');
            expect(req.url.origin + req.url.pathname).toBe(
              'https://graph.facebook.com/v25.0/PAGE-1_POST-1_c1/comments'
            );
            expect(req.url.searchParams.get('access_token')).toBe('tok-secret');
            expect(req.headers['content-type']).toBe('application/json');
            expect(req.body).toEqual({ message: 'Next week, 9 am.' });
          },
        },
      ]);
      const result = await reader.reply(channel(stub.fetchImpl), commentTarget, 'Next week, 9 am.');
      stub.assertDone();
      expect(result).toEqual({ replyId: 'PAGE-1_POST-1_c9' });
    });

    it('answers a message inside 24 hours as a normal response', async () => {
      const stub = scriptedFetch([
        {
          json: { recipient_id: 'PSID-1', message_id: 'm_new' },
          assert: (req) => {
            expect(req.method).toBe('POST');
            expect(req.url.origin + req.url.pathname).toBe('https://graph.facebook.com/v25.0/me/messages');
            expect(req.url.searchParams.get('access_token')).toBe('tok-secret');
            expect(req.body).toEqual({
              recipient: { id: 'PSID-1' },
              message: { text: 'Yes, 9 to 5.' },
              messaging_type: 'RESPONSE',
            });
          },
        },
      ]);
      const result = await reader.reply(channel(stub.fetchImpl), dmTarget('2026-11-25T08:00:00.000Z'), 'Yes, 9 to 5.');
      stub.assertDone();
      expect(result).toEqual({ replyId: 'm_new' });
    });

    it('uses the human agent tag between 24 hours and 7 days after their last message', async () => {
      const stub = scriptedFetch([
        {
          json: { recipient_id: 'PSID-1', message_id: 'm_new' },
          assert: (req) =>
            expect(req.body).toEqual({
              recipient: { id: 'PSID-1' },
              message: { text: 'Sorry for the wait.' },
              messaging_type: 'MESSAGE_TAG',
              tag: 'HUMAN_AGENT',
            }),
        },
      ]);
      await reader.reply(channel(stub.fetchImpl), dmTarget('2026-11-22T12:00:00.000Z'), 'Sorry for the wait.');
      stub.assertDone();
    });

    it('refuses, without calling Facebook, once the 7-day window has closed', async () => {
      const stub = scriptedFetch([]);
      const error = await reader
        .reply(channel(stub.fetchImpl), dmTarget('2026-11-10T12:00:00.000Z'), 'Hello?')
        .catch((e) => e);
      expect(error).toBeInstanceOf(InboxNotSupportedError);
      expect(error.message).toContain('7 days');
      expect(stub.calls).toHaveLength(0);
    });

    it('refuses when the message does not say who to answer', async () => {
      const stub = scriptedFetch([]);
      const target = { ...dmTarget(), authorId: null, replyContext: {} };
      await expect(reader.reply(channel(stub.fetchImpl), target, 'Hi')).rejects.toBeInstanceOf(InboxNotSupportedError);
    });
  });
});
