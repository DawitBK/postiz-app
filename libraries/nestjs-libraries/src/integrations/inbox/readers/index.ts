import { InboxReader } from '../inbox.types';
import { FacebookInboxReader } from './facebook.inbox';
import { InstagramInboxReader } from './instagram.inbox';
import { LinkedinInboxReader, LinkedinMemberInboxReader } from './linkedin.inbox';
import { TiktokInboxReader } from './tiktok.inbox';
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
