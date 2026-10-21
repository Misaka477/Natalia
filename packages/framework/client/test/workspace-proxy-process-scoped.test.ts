/**
 * The workspace proxy answers the process-scoped faces.
 *
 * The 浏览 button failed with `POST /rpc 400` and
 * `RuntimeRPCError: internal runtime failure` at `Proxy.pickFile`. The cause:
 * the proxy forwarded `pickFile` to `active.client`, whose surface does not
 * carry it, so the lookup answered `undefined` — and the transport's
 * `requireMember` turns a non-function into `RuntimeNotSupported`, which
 * `describeFailure` classifies as `internal`. The row accepted the click and
 * did nothing.
 *
 * These four answer about the RUNTIME, not about one workspace: the chooser
 * opens the runtime's own platform dialog and the browse primitives walk the
 * host filesystem. Routing them per workspace is wrong twice over, so they are
 * answered directly.
 */
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createWorkspaceManager,
  createWorkspaceRuntimeClient,
} from "../src/workspace-manager";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

test("the workspace proxy carries the process-scoped faces", async () => {
  const root = await officialPluginWorkspace("proxy-surface");
  await writeFile(join(root, "input.txt"), "x\n", "utf8");
  const manager = createWorkspaceManager({
    pluginStoreRoot: `${root}-plugin-store`,
    sessionDir: join(root, ".natalia", "sessions"),
    checkpointDir: join(root, ".natalia", "checkpoints"),
  });
  await manager.load();
  const client = createWorkspaceRuntimeClient(manager);
  const surface = client as unknown as Record<string, unknown>;
  for (const name of [
    "pickDirectory",
    "pickFile",
    "listDirectoryLevel",
    "createChildDirectory",
  ])
    expect(typeof surface[name], `${name} is not reachable`).toBe("function");
  await manager.dispose?.();
});
