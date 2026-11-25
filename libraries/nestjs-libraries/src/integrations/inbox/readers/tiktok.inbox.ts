import {
  InboxChannelContext,
  InboxNotSupportedError,
  InboxReader,
  InboxReplyTarget,
  InboxSupport,
} from '../inbox.types';

const COMMENTS_REASON =
  'TikTok has no comment access for this connection. The scopes of the TikTok Login Kit and Content Posting API (video.list, video.publish, video.upload and the user.info scopes) cannot read or answer comments. The TikTok API for Business has comment endpoints for organic videos, but only behind its own comment permissions and access application, which this connection does not have.';
const DMS_REASON =
  'TikTok has no direct message access for this connection: none of the Login Kit or Content Posting API scopes reads or sends direct messages.';

/**
 * TikTok (`tiktok`, Login Kit and Content Posting; `tiktok-business`, the same scopes over the
 * Business API login). Nothing these connections hold reads or answers comments or messages, so this
 * reader only says so; it makes no call and has no list methods.
 */
export class TiktokInboxReader implements InboxReader {
  readonly identifiers = ['tiktok', 'tiktok-business'] as const;

  support(): InboxSupport {
    return {
      comments: { supported: false, reason: COMMENTS_REASON },
      directMessages: { supported: false, reason: DMS_REASON },
    };
  }

  async reply(
    _ctx: InboxChannelContext,
    target: InboxReplyTarget
  ): Promise<{ replyId: string | null }> {
    throw new InboxNotSupportedError(
      target.kind === 'comment' ? COMMENTS_REASON : DMS_REASON
    );
  }
}
