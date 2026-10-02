import type { AttachmentService } from "@anthelia/runtime";
import { defineService } from "@anthelia/runtime-services";

/** The attachment service token; lives with the mechanism. */
export const attachmentService = defineService<AttachmentService>(
  "attachment.service",
  { scope: "workspace", capability: "services" },
);
