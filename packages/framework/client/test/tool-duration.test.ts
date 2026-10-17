/**
 * Every tool call states what it cost.
 *
 * Measured gap this pins: a turn read as "37 minutes" with nothing on any card
 * to say whether one command held it or thirty did. `session.usage.toolMs` is a
 * SUM over every call of every turn, and `tool.update` carried only
 * `startedAt`/`endedAt`, so a reader had to subtract two client clocks to guess
 * a single call's cost — and a chat turn's cards (Navi/Nia execute their tools
 * directly) carried neither.
 *
 * The runner now stamps `durationMs` on every settled tool event, in all four
 * publish paths, and the card shows it in the runner's own measurement.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const repo = join(import.meta.dir, "..", "..", "..");

async function source(...segments: string[]): Promise<string> {
  return await Bun.file(join(repo, ...segments)).text();
}

test("the contract carries the duration on both tool-event shapes", async () => {
  const events = await source("core", "contracts", "src", "events.ts");
  const main = events.indexOf('type: "tool.update"');
  expect(main).toBeGreaterThan(0);
  expect(events.slice(main, main + 2200)).toContain("durationMs?: number");
  // The namespaced chat form and the legacy shared form — a chat turn has no
  // `tool.update` at all, so without these its cards had no reading.
  expect(events).toContain(
    "type: `${Namespace}.chat.tool.used`;\n      id: string;",
  );
  const chat = events.indexOf('type: "chat.tool.used"');
  expect(chat).toBeGreaterThan(0);
  expect(events.slice(chat, chat + 900)).toContain("durationMs?: number");
});

test("every agent path measures its own call", async () => {
  const sites: Array<[string[], string]> = [
    [
      [
        "framework",
        "client",
        "src",
        "runtime",
        "tool-execution",
        "execute-run.ts",
      ],
      "durationMs: Date.now() - startedAtMs",
    ],
    [
      [
        "framework",
        "client",
        "src",
        "runtime",
        "initialize",
        "subagent-tools.ts",
      ],
      "durationMs: Date.now() - startedAt",
    ],
    [
      ["domains", "collab", "src", "chat-turn-navi.ts"],
      "durationMs: performance.now() - toolStart",
    ],
    [
      ["domains", "collab", "src", "chat-turn-nia.ts"],
      "durationMs: performance.now() - toolStart",
    ],
  ];
  for (const [path, needle] of sites) {
    const text = await source(...path);
    expect(text.includes(needle), path.join("/")).toBe(true);
  }
});

test("the main path times a FAILED call too, not just a successful one", async () => {
  const text = await source(
    "framework",
    "client",
    "src",
    "runtime",
    "tool-execution",
    "execute-run.ts",
  );
  // One clock, opened before the row starts, so `startedAt` and `durationMs`
  // are the same measurement rather than two.
  expect(text).toContain("const startedAtMs = Date.now()");
  expect(text).toContain("startedAt: startedAtMs");
  expect(
    (text.match(/durationMs: Date\.now\(\) - startedAtMs/gu) ?? []).length,
  ).toBe(2);
});

test("the projection carries it and the card renders it, with no confident zero", async () => {
  const state = await source("hosts", "view-store", "src", "state.ts");
  expect(state).toContain("durationMs?: number");
  const conversation = await source(
    "hosts",
    "view-store",
    "src",
    "conversation.ts",
  );
  expect(
    (conversation.match(/durationMs/gu) ?? []).length,
  ).toBeGreaterThanOrEqual(2);
  const kit = await source("plugins", "ui", "kit", "src", "transcript.tsx");
  // Rendered only when the event carried one: a running call and a replayed
  // pre-field event show nothing rather than "0ms".
  expect(kit).toContain("props.toolCall.durationMs !== undefined");
  expect(kit).toContain("formatToolDuration(props.toolCall.durationMs!)");
  const message = await source("plugins", "ui", "kit", "src", "message.ts");
  expect(message).toContain(
    "...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {})",
  );
});
