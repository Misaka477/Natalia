import { expect, test } from "bun:test";
import type { ToolCard } from "@anthelia/tools";
import { ManagedProcessRegistry, managedProcessTools } from "../src";

/**
 * The process family's cards (UI refactor R1) — the template the other
 * families copy.
 *
 * The contract this family pins for everyone:
 *
 *   1. every tool declares `presentationMeta` AND `presentResult`, and the
 *      result card is composed from the FACTS the meta slot carries — the
 *      runtime computes them once and hands them to the presenter, so the
 *      result string is never parsed a second time;
 *   2. the structured fields the `ToolCard` union declares for a kind are
 *      what the card carries (a terminal's `output`, its `exitCode`);
 *   3. a result that is not the envelope degrades the card to its call
 *      verb — a presenter never throws, because a throwing presenter takes
 *      the whole transcript row down.
 *
 * The poison test is the mutation proof for (1): a presenter that re-parses
 * `value` instead of reading the facts fails it the moment someone writes
 * one.
 */

const registry = new ManagedProcessRegistry();
const tools = new Map(
  managedProcessTools(registry).map((tool) => [tool.name, tool]),
);

function outputOf(name: string) {
  const output = tools.get(name)?.output;
  if (!output?.presentCall || !output.presentResult || !output.presentationMeta)
    throw new Error(`${name} must declare the full projection`);
  return output;
}

function metaOf(name: string, args: unknown, value: string) {
  return outputOf(name).presentationMeta!(args, value);
}

function cardOf(
  name: string,
  args: unknown,
  value: string,
  meta?: Record<string, unknown>,
): ToolCard {
  const card = outputOf(name).presentResult!(args, value, meta);
  if (!card) throw new Error(`${name} produced no card`);
  return card;
}

test("all twelve tools declare the full projection", () => {
  expect([...tools.keys()]).toHaveLength(12);
  for (const [name, tool] of tools) {
    expect(tool.output, `${name} needs an output definition`).toBeDefined();
    expect(typeof tool.output?.presentCall, `${name} needs presentCall`).toBe(
      "function",
    );
    expect(
      typeof tool.output?.presentResult,
      `${name} needs presentResult`,
    ).toBe("function");
    expect(
      typeof tool.output?.presentationMeta,
      `${name} needs presentationMeta`,
    ).toBe("function");
  }
});

test("process_start's card carries the command and the handle as facts", () => {
  const args = { command: "npm run dev", description: "Start the dev server" };
  const value = JSON.stringify({
    id: "proc_abc",
    command: "npm run dev",
    status: "running",
  });
  const meta = metaOf("process_start", args, value);
  expect(meta).toMatchObject({ id: "proc_abc", status: "running" });
  const card = cardOf("process_start", args, value, meta);
  expect(card).toMatchObject({
    kind: "terminal",
    title: "npm run dev",
    summary: "started proc_abc",
    meta: [["id", "proc_abc"]],
  });
  // The call card is the command itself, before anything ran.
  expect(outputOf("process_start").presentCall!(args)).toEqual({
    kind: "terminal",
    title: "npm run dev",
    summary: "Start the dev server",
  });
});

test("the card is composed from the FACTS, not a second parse (poison)", () => {
  // The runtime hands the presenter the facts it just computed. A presenter
  // that ignores them and parses `value` again would read POISON here and
  // lose the structured fields — which is the regression this pins.
  const args = { id: "proc_abc" };
  const meta = metaOf(
    "process_wait",
    args,
    JSON.stringify({
      id: "proc_abc",
      status: "exited",
      exitCode: 3,
      timedOut: false,
    }),
  );
  const card = cardOf("process_wait", args, "POISON", meta);
  expect(card).toMatchObject({
    kind: "terminal",
    title: "proc_abc",
    summary: "exited",
  });
  expect(card.meta).toEqual([["exit", "3"]]);
  // The same fact on the card's structured field, which is what a client
  // reads (the pill is the same fact for the eye).
  expect(card.kind === "terminal" && card.exitCode).toBe(3);
});

test("process_status's card reports status, exit and readiness", () => {
  const args = { id: "proc_abc" };
  const value = JSON.stringify({
    id: "proc_abc",
    status: "running",
    exitCode: null,
    ready: true,
    outputUpdatedAt: "2026-10-08T00:00:00.000Z",
  });
  const meta = metaOf("process_status", args, value);
  expect(cardOf("process_status", args, value, meta).meta).toEqual([
    ["status", "running"],
    ["ready", "true"],
    ["output", "2026-10-08T00:00:00.000Z"],
  ]);
});

test("process_wait's timeout is a state, not a silent one", () => {
  const args = { id: "proc_abc" };
  const value = JSON.stringify({
    id: "proc_abc",
    status: "running",
    timedOut: true,
  });
  const meta = metaOf("process_wait", args, value);
  expect(cardOf("process_wait", args, value, meta)).toMatchObject({
    summary: "still running",
    meta: [["timedOut", "yes"]],
  });
});

test("process_output's dump is the terminal card's structured output", () => {
  // The read that returns text must not round-trip through the flatten: the
  // card carries the dump as the `output` field a terminal renderer draws
  // verbatim.
  const args = { id: "proc_abc" };
  const card = cardOf("process_output", args, "line one\nline two\n");
  expect(card).toMatchObject({
    kind: "terminal",
    title: "proc_abc",
    summary: "read",
    output: "line one\nline two\n",
  });
});

test("a listing's counts are facts, and its envelope stays the body", () => {
  const value = JSON.stringify([
    { id: "a", status: "running" },
    { id: "b", status: "exited" },
  ]);
  const meta = metaOf("process_list", {}, value);
  expect(meta).toMatchObject({ total: 2, running: 1 });
  expect(cardOf("process_list", {}, value, meta)).toMatchObject({
    kind: "generic",
    title: "processes",
    summary: "2 listed · 1 running",
    meta: [["running", "1"]],
    body: value,
  });
  // The audit reads the same facts out of its `processes` envelope.
  const audit = JSON.stringify({
    root: "/tmp/x",
    processes: [
      { id: "a", status: "running" },
      { id: "b", status: "running" },
    ],
  });
  expect(metaOf("process_audit", {}, audit)).toMatchObject({
    total: 2,
    running: 2,
  });
  expect(
    cardOf("process_audit", {}, audit, metaOf("process_audit", {}, audit)),
  ).toMatchObject({ summary: "audit · 2 listed · 2 running" });
});

test("the control tools have cards of their own (they had none)", () => {
  // restart/attach/detach were built through a shared factory that carried
  // no output definition at all, so their rows fell to the generic path.
  for (const [name, summary] of [
    ["process_restart", "restart"],
    ["process_attach", "attach"],
    ["process_detach", "detach"],
  ] as const) {
    const args = { id: "proc_abc" };
    const value = JSON.stringify({ id: "proc_abc", status: "running" });
    expect(cardOf(name, args, value, metaOf(name, args, value))).toMatchObject({
      kind: "terminal",
      title: "proc_abc",
      summary: "running",
    });
    expect(outputOf(name).presentCall!(args)).toMatchObject({ summary });
  }
});

test("a result that is not the envelope degrades to the call verb", () => {
  // A prose error, a truncated write, a text dump: no facts, so the row
  // reads its call verb — never a thrown presenter, never a raw prefix.
  expect(
    cardOf("process_wait", { id: "proc_abc" }, "process not found"),
  ).toMatchObject({ summary: "wait", title: "proc_abc" });
  expect(cardOf("process_list", {}, "")).toMatchObject({
    summary: "list",
    title: "processes",
  });
});
