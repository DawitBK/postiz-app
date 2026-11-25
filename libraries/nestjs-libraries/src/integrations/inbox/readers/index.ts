import { InboxReader } from '../inbox.types';
import { FacebookInboxReader } from './facebook.inbox';
import { InstagramInboxReader } from './instagram.inbox';
import { LinkedinInboxReader, LinkedinMemberInboxReader } from './linkedin.inbox';
import { TiktokInboxReader } from './tiktok.inbox';
import { PracticeInboxReader } from './practice.inbox';
import { XInboxReader } from './x.inbox';
import { YoutubeInboxReader } from './youtube.inbox';

/**
 * One reader for each real network Postiz holds tokens for. LinkedIn has two because a Company Page
 * and a personal profile are allowed different things.
 */
export const realNetworkInboxReaders: InboxReader[] = [
  new FacebookInboxReader(),
  new InstagramInboxReader(),
  new LinkedinInboxReader(),
  new LinkedinMemberInboxReader(),
  new YoutubeInboxReader(),
  new TiktokInboxReader(),
  new XInboxReader(),
];

/**
 * The readers in use. The practice network reader (development and tests only) exists only when
 * POSTIZ_PRACTICE_NETWORK=true, like its channel type.
 */
export const allInboxReaders = (): InboxReader[] =>
  process.env.POSTIZ_PRACTICE_NETWORK === 'true'
    ? [...realNetworkInboxReaders, new PracticeInboxReader()]
    : realNetworkInboxReaders;
