import { expect, test } from "bun:test";
import { NativeTerminalRegistry } from "../src";

test("injects broker credentials only when starting the Terminal Hub", async () => {
  const launches: Array<Record<string, string | undefined> | undefined> = [];
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 22, window_id: 2, tab_id: 3 };
    },
    async list() {
      return [{ pane_id: 22, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
    },
    async read() {
      return "";
    },
    async write() {},
    async open(_paneID, options) {
      launches.push(options?.environment);
      return { pane_id: 22, window_id: 2, tab_id: 3 };
    },
    async focus() {},
    async resize() {},
    async stop() {},
  });
  registry.setHumanInputBridge({
    endpoint: "/run/user/1000/broker.sock",
    token: "token_1",
  });
  await registry.start({ cwd: "/repo", command: "cat" });
  expect(launches).toEqual([
    {
      NATALIA_NATIVE_INPUT_ENDPOINT: "/run/user/1000/broker.sock",
      NATALIA_NATIVE_INPUT_TOKEN: "token_1",
    },
  ]);
});
