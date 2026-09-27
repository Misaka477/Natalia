import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeTerminalRegistry,
  createWezTermHost,
  writeWezTermNativeDomainConfig,
} from "../../../plugins/native-terminal/src";
import { createToolRegistry } from "../../../core/tools/src";

const root = await mkdtemp(join(tmpdir(), "natalia-native-headless-"));
const runtimeDir = join(root, "runtime");
const muxRuntimeDir = join(runtimeDir, "wezterm-runtime");
const socketPath = join(muxRuntimeDir, "wezterm", "sock");
await mkdir(muxRuntimeDir, { recursive: true, mode: 0o700 });

const nativeDomain = await writeWezTermNativeDomainConfig({
  directory: muxRuntimeDir,
  socketPath,
});
const nativeTerminal = new NativeTerminalRegistry(
  createWezTermHost({
    environment: { WEZTERM_UNIX_SOCKET: socketPath },
    muxRuntimeDir,
    nativeDomain,
  }),
  { windowMode: "windowless" },
);
const tools = createToolRegistry([]);
const context = { workspaceRoot: root, nativeTerminal };

try {
  const start = JSON.parse(
    await tools
      .get("interactive_terminal_start")!
      .execute({ command: "sh", id: "tty_headless" }, context),
  ) as { id: string };
  await tools
    .get("interactive_terminal_write")!
    .execute(
      { id: start.id, input: "printf 'NATALIA_HEADLESS_WRITE_OK'\r" },
      context,
    );
  await tools
    .get("interactive_terminal_send_line")!
    .execute(
      { id: start.id, text: "printf ' NATALIA_HEADLESS_SEND_OK\\n'" },
      context,
    );

  await waitFor(async () => (await nativeTerminal.read(start.id)).text);
  const read = JSON.parse(
    await tools
      .get("interactive_terminal_read")!
      .execute({ id: start.id, maxLines: 80 }, context),
  ) as { text: string };
  const snapshot = JSON.parse(
    await tools
      .get("interactive_terminal_snapshot")!
      .execute({ id: start.id }, context),
  ) as { text: string };
  if (
    !read.text.includes("NATALIA_HEADLESS_WRITE_OK") ||
    !read.text.includes("NATALIA_HEADLESS_SEND_OK") ||
    !snapshot.text.includes("NATALIA_HEADLESS_SEND_OK")
  )
    throw new Error("headless native terminal output was incomplete");
  await tools
    .get("interactive_terminal_stop")!
    .execute({ id: start.id }, context);
  console.log(
    JSON.stringify({
      result: "passed",
      display: process.env.DISPLAY ?? null,
      waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
      tools: ["start", "read", "write", "send_line", "snapshot", "stop"],
    }),
  );
} finally {
  await nativeTerminal.dispose();
}

async function waitFor(read: () => Promise<string>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = await read();
    if (
      text.includes("NATALIA_HEADLESS_WRITE_OK") &&
      text.includes("NATALIA_HEADLESS_SEND_OK")
    )
      return;
    await Bun.sleep(100);
  }
  throw new Error("headless native terminal did not produce expected output");
}
