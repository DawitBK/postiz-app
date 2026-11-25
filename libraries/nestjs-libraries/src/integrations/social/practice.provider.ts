import {
  AnalyticsData,
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';

/**
 * The practice network: a channel type that publishes to a pretend network (the small service in
 * `operational-engine/practice-network` of the DCC repository), so publishing, scheduling, deleting, comments and
 * analytics can be proven end to end without a developer app.
 *
 * Development and tests only. It is registered only when `POSTIZ_PRACTICE_NETWORK=true` (see
 * `integration.manager.ts`), and it talks to `PRACTICE_NETWORK_URL` (default http://practice-network:4100).
 * It deliberately uses plain `fetch`, not the SSRF-safe one the real providers use: the pretend network lives
 * on a private address.
 */
const baseUrl = () =>
  (process.env.PRACTICE_NETWORK_URL || 'http://practice-network:4100').replace(
    /\/$/,
    ''
  );

const call = async <T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> => {
  const response = await fetch(baseUrl() + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Practice network answered ${response.status} to ${method} ${path}: ${text.slice(0, 200)}`
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
};

type PracticePost = { id: string; url: string; state: string };

/**
 * The account on the pretend network, made sure of by its handle (the channel's profile). The pretend network forgets
 * what it holds when it restarts, a real network never forgets an account, so this stands in for that.
 */
const accountIdOf = async (
  internalId: string,
  profile: string | null | undefined
): Promise<string> => {
  if (!profile) {
    return internalId;
  }
  const account = await call<{ id: string }>('POST', '/api/accounts', {
    handle: profile,
  });
  return account.id;
};
type PracticeSeries = {
  label: string;
  data: { date: string; total: string }[];
};

export class PracticeProvider extends SocialAbstract implements SocialProvider {
  identifier = 'practice';
  name = 'Practice network';
  isBetweenSteps = false;
  scopes = [] as string[];
  editor = 'normal' as const;
  maxLength() {
    return 500;
  }

  async customFields() {
    return [
      {
        key: 'handle',
        label: 'Account handle on the practice network',
        defaultValue: 'practice-account',
        validation: `/^[a-zA-Z0-9_.-]{2,60}$/`,
        type: 'text' as const,
      },
    ];
  }

  async generateAuthUrl() {
    const state = makeSecureId(6);
    return { url: state, codeVerifier: makeSecureId(10), state };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }): Promise<AuthTokenDetails | string> {
    let handle = '';
    try {
      handle = JSON.parse(Buffer.from(params.code, 'base64').toString()).handle;
    } catch {
      return 'The handle could not be read';
    }
    try {
      const account = await call<{
        id: string;
        name: string;
        handle: string;
        picture?: string;
      }>('POST', '/api/accounts', { handle });
      return {
        id: account.id,
        name: account.name,
        username: account.handle,
        picture: account.picture || '',
        accessToken: makeSecureId(24),
        refreshToken: '',
        expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
      };
    } catch (error) {
      return `The practice network refused this handle: ${(error as Error).message}`;
    }
  }

  async refreshToken(): Promise<AuthTokenDetails> {
    // A practice account never expires; there is nothing to refresh.
    return {
      id: '',
      name: '',
      accessToken: '',
      refreshToken: '',
      expiresIn: 0,
      picture: '',
      username: '',
    };
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [first, ...rest] = postDetails;
    const created = await call<PracticePost>('POST', '/api/posts', {
      accountId: await accountIdOf(id, integration?.profile),
      text: first.message,
      media: (first.media ?? []).map((m) => m.path),
    });
    const responses: PostResponse[] = [
      {
        id: first.id,
        postId: created.id,
        releaseURL: created.url,
        status: 'completed',
      },
    ];
    // The rest of a thread become comments of the account itself under the first post.
    for (const next of rest) {
      const comment = await call<{ id: string }>(
        'POST',
        `/api/posts/${created.id}/comments`,
        {
          authorName: integration?.name || 'account',
          text: next.message,
          fromSelf: true,
        }
      );
      responses.push({
        id: next.id,
        postId: comment.id,
        releaseURL: created.url,
        status: 'completed',
      });
    }
    return responses;
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const responses: PostResponse[] = [];
    for (const detail of postDetails) {
      const comment = await call<{ id: string }>(
        'POST',
        `/api/posts/${postId}/comments`,
        {
          authorName: integration?.name || 'account',
          text: detail.message,
          fromSelf: true,
        }
      );
      responses.push({
        id: detail.id,
        postId: comment.id,
        releaseURL: `${baseUrl()}/p/${postId}`,
        status: 'completed',
      });
    }
    return responses;
  }

  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const days = Math.min(Math.max(Math.floor(date) || 30, 1), 90);
    const series = await call<PracticeSeries[]>(
      'GET',
      `/api/analytics?accountId=${encodeURIComponent(id)}&days=${days}`
    );
    return series.map((s) => ({
      label: s.label,
      data: s.data,
      percentageChange: 0,
    }));
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    fromDate: number
  ): Promise<AnalyticsData[]> {
    const days = Math.min(Math.max(Math.floor(fromDate) || 30, 1), 90);
    const series = await call<PracticeSeries[]>(
      'GET',
      `/api/posts/${encodeURIComponent(postId)}/analytics?days=${days}`
    );
    return series.map((s) => ({
      label: s.label,
      data: s.data,
      percentageChange: 0,
    }));
  }
}
