import type { LocalAttachment } from "@anthelia/contracts";
import type { SessionRecord } from "@anthelia/session";
import type { AttachmentService } from "@anthelia/runtime";
import {
  attachmentDataURL,
  attachmentText,
  cleanupUnreferencedAttachments,
  isTextAttachment,
  referencedAttachmentsForSessions,
  storeLocalAttachmentBytes,
  storeLocalAttachments,
} from "./attachments";

export function createAttachmentService(
  workspaceRoot: string,
): AttachmentService {
  return {
    store: (paths: string[]) => storeLocalAttachments({ workspaceRoot, paths }),
    storeBytes: (input) =>
      storeLocalAttachmentBytes({ workspaceRoot, ...input }),
    dataURL: (attachment: LocalAttachment) =>
      attachmentDataURL(workspaceRoot, attachment),
    text: (attachment: LocalAttachment) =>
      attachmentText(workspaceRoot, attachment),
    isText: isTextAttachment,
    cleanup: (attachments: LocalAttachment[]) =>
      cleanupUnreferencedAttachments({ workspaceRoot, attachments }),
    referencedForSessions: (sessions: SessionRecord[]) =>
      referencedAttachmentsForSessions(sessions),
  };
}
