import { expect, test } from "bun:test";
import {
  clearRepeat,
  recordRepeat,
  repeatKey,
  REPEAT_MAX,
  REPEAT_WINDOW_MS,
  type RepeatStore,
} from "../src/runtime/tool-execution/repeat-guard";

test("repeat guard blocks the 11th identical call inside the window", () => {
  const store: RepeatStore = new Map();
  const key = repeatKey("run_shell", JSON.stringify({ command: "ls" }), "/ws");
  let last = { count: 0, blocked: false };
  for (let i = 0; i <= REPEAT_MAX; i++) {
    last = recordRepeat(store, key, 1_000 + i * 1_000);
  }
  expect(last.count).toBe(REPEAT_MAX + 1);
  expect(last.blocked).toBe(true);
});

test("repeat guard forgets calls outside the sliding window", () => {
  const store: RepeatStore = new Map();
  const key = repeatKey("run_shell", "pwd", "/ws");
  for (let i = 0; i < REPEAT_MAX; i++)
    recordRepeat(store, key, 1_000 + i * 1_000);
  const afterWindow = recordRepeat(
    store,
    key,
    1_000 + REPEAT_WINDOW_MS + 10_000,
  );
  expect(afterWindow.blocked).toBe(false);
  expect(afterWindow.count).toBe(1);
});

test("clearRepeat resets a key after a successful execution", () => {
  const store: RepeatStore = new Map();
  const key = repeatKey("run_shell", "npm test", "/ws");
  for (let i = 0; i < REPEAT_MAX; i++) recordRepeat(store, key, 1_000 + i);
  clearRepeat(store, key);
  const next = recordRepeat(store, key, 10_000);
  expect(next.count).toBe(1);
  expect(next.blocked).toBe(false);
});

test("repeat keys normalize workspace absolute paths", () => {
  const a = repeatKey(
    "run_shell",
    JSON.stringify({
      command: 'cd "/home/user/project/build" && cmake --build .',
    }),
    "/home/user/project",
  );
  const b = repeatKey(
    "run_shell",
    JSON.stringify({
      command: 'cd "/home/user/project/build" && cmake --build .',
    }),
    "/home/user/project",
  );
  expect(a).toBe(b);
  expect(a).toContain("<workspace>");
});

test("repeat stores are independent per session", () => {
  const a: RepeatStore = new Map();
  const b: RepeatStore = new Map();
  const key = repeatKey("run_shell", "ls", "/ws");
  for (let i = 0; i < REPEAT_MAX; i++) recordRepeat(a, key, 1_000 + i);
  expect(recordRepeat(a, key, 10_000).blocked).toBe(true);
  expect(recordRepeat(b, key, 10_000).blocked).toBe(false);
});
