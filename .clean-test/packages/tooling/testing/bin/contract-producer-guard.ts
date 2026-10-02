/**
 * Every declared contract member must be produced, or be listed with a reason.
 *
 * Roughly forty declarations in one stretch of work could never occur: an event
 * type no writer emitted, an enum member no branch compared against, a status a
 * capability reported that nothing could reach. None were caught by anything,
 * because "something is declared and nothing produces it" is invisible to a
 * type checker and to every behavioural test — the consumer tests all passed.
 *
 * A member that nothing produces is worse than an absent one: it tells every
 * later reader that a path exists. This check makes the choice explicit — wire
 * it, delete it, or say in `ALLOWED` why it stays.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CONTRACTS = "packages/core/contracts/src/events.ts";

/**
 * Members that nothing produces, kept deliberately.
 *
 * Every entry needs a reason: this list is the record of a decision, and a
 * decision without a reason is indistinguishable from an oversight.
 */
const ALLOWED: Record<string, string> = {
  // Namespaced collaboration messages. The journal split each agent stream into
  // its own namespace and the shared `collab.*` types were kept so journals
  // written before the split still replay — the contract says so in a comment on
  // `NamespacedCollabMessageEventData`.
  "collab.answer":
    "legacy journal replay: shared collab.* predates the stream split",
  "collab.chat":
    "legacy journal replay: shared collab.* predates the stream split",
  "collab.message":
    "legacy journal replay: shared collab.* predates the stream split",
  "collab.notice":
    "legacy journal replay: shared collab.* predates the stream split",
  "collab.question":
    "legacy journal replay: shared collab.* predates the stream split",
  "collab.response":
    "legacy journal replay: shared collab.* predates the stream split",
  "collab.suggestion":
    "legacy journal replay: shared collab.* predates the stream split",
  // Emitted by the renderer, not the runtime, and consumed by view-store. The
  // api-reference carries them with a "UI-only" trigger description.
  "dialog.open": "UI-only: emitted by the renderer, consumed by view-store",
  "dialog.close": "UI-only: emitted by the renderer, consumed by view-store",
  "terminal.pane.select":
    "UI-only: emitted by the renderer, consumed by view-store",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|dist/.test(path)) walk(path, out);
    } else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

function eventTypes(text: string): string[] {
  const from = text.indexOf("type RuntimeEventData =");
  const to = text.indexOf("export type RuntimeEvent =");
  if (from === -1 || to === -1 || to < from)
    throw new Error(`${CONTRACTS}: RuntimeEventData union not found`);
  const union = text.slice(from, to);
  return [
    ...new Set(
      [...union.matchAll(/type:\s*"([a-z][a-z0-9_.]*)"/gu)].map((m) => m[1]!),
    ),
  ];
}

/** Enum members declared in the contract, excluding the event union. */
function enumMembers(text: string): string[] {
  const unionFrom = text.indexOf("type RuntimeEventData =");
  const unionTo = text.indexOf("export type RuntimeEvent =");
  const outside = text.slice(0, unionFrom) + text.slice(unionTo);
  const members: string[] = [];
  for (const match of outside.matchAll(/export type \w+ =([^;]+);/gs))
    for (const value of match[1]!.matchAll(/"([a-z][a-z0-9_]*)"/gu))
      members.push(value[1]!);
  return [...new Set(members)];
}

const contract = readFileSync(join(ROOT, CONTRACTS), "utf8");
// The contract file itself declares the members, so counting it as a producer
// would make every check pass.
const sources = walk(join(ROOT, "packages"))
  .filter(
    (path) =>
      path.includes("/src/") &&
      !path.includes("/test/") &&
      !path.endsWith(CONTRACTS),
  )
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const inApps = walk(join(ROOT, "apps"))
  .filter((path) => !path.includes("/test/"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const producers = `${sources}\n${inApps}`;

// Everything declared with no producer, before the allowlist is consulted, so an
// allowlisted member can be told apart from one that was resolved.
const unproduced = [
  ...eventTypes(contract)
    .filter((type) => !producers.includes(`type: "${type}"`))
    .map((type) => `event ${type}`),
  ...enumMembers(contract)
    .filter((member) => !producers.includes(`"${member}"`))
    .map((member) => `enum member ${member}`),
];
const unproducedKeys = new Set(
  unproduced.map((entry) => entry.slice(entry.lastIndexOf(" ") + 1)),
);

const missing = unproduced.filter(
  (entry) => !(entry.slice(entry.lastIndexOf(" ") + 1) in ALLOWED),
);

// An allowlist entry that stopped being needed hides the next real case, so
// entries are pruned as they resolve.
const stale = Object.keys(ALLOWED).filter((key) => !unproducedKeys.has(key));

if (stale.length) {
  console.error(
    [
      "contract producer guard: allowlist entries that are no longer needed",
      "",
      ...stale.map((key) => `  ${key}`),
      "",
      "The member is produced now (or gone). Remove the entry so the list keeps",
      "describing only what is deliberately unproduced.",
    ].join("\n"),
  );
  process.exit(1);
}

if (missing.length) {
  console.error(
    [
      "contract producer guard: declared with nothing that produces it",
      "",
      ...missing.map((entry) => `  ${entry}`),
      "",
      "For each: give it a producer, remove it, or add it to ALLOWED in",
      "packages/tooling/testing/bin/contract-producer-guard.ts with the reason it",
      "stays. A member nothing can produce reads to every later reader as a path",
      "that exists.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("contract producer guard passed");
