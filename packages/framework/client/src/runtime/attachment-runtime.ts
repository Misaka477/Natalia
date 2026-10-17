/**
 * Attachment upload surface exposed over RuntimeClient.
 *
 * The UI sends clipboard/drop image bytes as base64; the runtime stores them
 * directly in the attachment store (`.natalia/attachments/`) and returns a
 * durable LocalAttachment path for later submit. This avoids writing pasted
 * files into the user workspace.
 */
import type { LocalAttachment, SessionID } from "@anthelia/contracts";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { escapesDir } from "./attachment-paths";
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
      // A WORKSPACE media path (a file the model read with read_media_file) is
      // served from where it lives, not from the attachment store. The store-only
      // branch below is why every read-image card said 加载失败: the tool's result
      // sentence names the file (`image attached: E:\…\x.png`), the client asked
      // for it, and `attachmentDataURL` refused it with "attachment store path
      // escapes root" (measured; 20+ diagnostics in one session).
      //
      // TWO gates, and the workspace one is not optional. The permission rules
      // are a permissive read policy (`auto` allows reads), so they are NOT a
      // boundary: measured, `{path: "C:\\Windows\\win.ini", mediaType:
      // "image/png"}` was served as base64 with only the rule check in place.
      // The boundary is the workspace root, resolved through realpath so a
      // symlink cannot step outside it — the same containment `attachmentDataURL`
      // applies to the store, for the same reason.
      //
      // Only media types are served: this route draws a picture or a clip, it is
      // not a general file reader.
      if (
        input.mediaType.startsWith("image/") ||
        input.mediaType.startsWith("video/")
      ) {
        const root = await realpath(ctx.ports.getWorkspaceRoot());
        const target = await realpath(resolve(root, input.path));
        if (escapesDir(root, target))
          throw new Error(
            `refusing to preview a path outside the workspace: ${input.path}`,
          );
        await ctx.ports.authorizeWorkspaceRead({
          toolName: "read_media_file",
          paths: [target],
        });
        const bytes = await readFile(target);
        return `data:${input.mediaType};base64,${bytes.toString("base64")}`;
      }
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
