/**
 * Attachment upload surface exposed over RuntimeClient.
 *
 * The UI sends clipboard/drop image bytes as base64; the runtime stores them
 * directly in the attachment store (`.natalia/attachments/`) and returns a
 * durable LocalAttachment path for later submit. This avoids writing pasted
 * files into the user workspace.
 */
import type { LocalAttachment, SessionID } from "@anthelia/contracts";
import { sessionStoreController } from "@anthelia/session-store";
import { attachmentService } from "@anthelia/attachments";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import type { AttachmentService } from "@anthelia/runtime";
import type { SessionStoreController } from "@anthelia/session-store";

export function createAttachmentRuntime(
  ctx: RuntimeContext,
): Pick<RuntimeServiceClient, "uploadAttachment" | "attachmentDataUrl"> {
  return {
    async attachmentDataUrl(input: {
      path?: string;
      mediaType?: string;
      attachmentID?: string;
      sessionID?: string;
    }): Promise<string> {
      await ctx.ports.getReady();
      const attachments = ctx.state.serviceDirectory.get(attachmentService);

      if (input.attachmentID || input.sessionID) {
        if (!input.attachmentID || !input.sessionID)
          throw new Error(
            "attachmentDataUrl requires attachmentID and sessionID together",
          );
        const session =
          ctx.ports.getExecutionBySession().get(input.sessionID as SessionID)
            ?.session ??
          (await (async () => {
            const store = ctx.state.serviceDirectory.get(
              sessionStoreController,
            );
            if (!store)
              throw new Error(
                "session store unavailable (natalia-session-store)",
              );
            return (await store.load(input.sessionID as SessionID)).session;
          })());
        const referenced = attachments.referencedForSessions([session]);
        const attachment = referenced.find(
          (item) => item.id === input.attachmentID,
        );
        if (!attachment)
          throw new Error(
            `attachment is not referenced by session: ${input.attachmentID}`,
          );
        return await attachments.dataURL(attachment);
      }

      if (!input.path || !input.mediaType)
        throw new Error(
          "attachmentDataUrl requires path+mediaType or attachmentID+sessionID",
        );
      const filename = input.path.split(/[\\/]/u).pop() ?? "attachment";
      return await attachments.dataURL({
        id: "",
        path: input.path,
        filename,
        mediaType: input.mediaType as LocalAttachment["mediaType"],
        byteLength: 0,
        sha256: "",
      });
    },
    async uploadAttachment(input: {
      name: string;
      mediaType: string;
      data: string;
    }): Promise<LocalAttachment> {
      await ctx.ports.getReady();
      const attachments = ctx.state.serviceDirectory.get(attachmentService);
      const bytes = Buffer.from(input.data, "base64");
      return await attachments.storeBytes({
        name: input.name,
        mediaType: input.mediaType,
        data: new Uint8Array(bytes),
      });
    },
  };
}
