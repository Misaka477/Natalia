import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { expect, test } from "bun:test";
import {
  API_VERSION,
  DEPRECATED_RUNTIME_MEMBERS,
  REQUIRED_RUNTIME_MEMBERS,
  RUNTIME_CAPABILITY_GROUPS,
  RUNTIME_RPC_ERROR_CODES,
  UNIMPLEMENTED_QUERIES,
  capabilityGroupOf,
} from "@anthelia/contracts";
import type { RuntimeClient } from "@anthelia/contracts";
import {
  RPC_INTENTIONALLY_LOCAL,
  RPC_ROUTE_MEMBERS,
  RPC_WRITE_METHODS,
} from "../src/rpc";

/**
 * P0-Docs: `docs/api-reference.md` must not rot.
 *
 * Every number and table in the generated block of that document is derived
 * here from the same constants the transport and the contracts use — the route
 * table, the write surface, the intentionally-local whitelist, the capability
 * groups, the stable surface, the failure codes, the unimplemented queries and
 * the event/projection counts (the last two by a source scan of the union and
 * the projector, the same pattern the route-table guard uses).
 *
 * Two modes:
 *
 *   - `bun test packages/hosts/transport/test/api-reference.test.ts` — assert mode:
 *     the committed document must contain the generated block byte for byte.
 *     Any table change, or any hand edit inside the block, turns the gate red.
 *   - `npm run docs:api-reference` — write mode (`API_REFERENCE_WRITE=1 bun run
 *     packages/hosts/transport/test/api-reference.test.ts`): replaces the block
 *     between the markers in place and reports the path.
 */

const API_REFERENCE_PATH = join(process.cwd(), "docs", "api-reference.md");
const API_REFERENCE_ZH_PATH = join(
  process.cwd(),
  "docs",
  "api-reference.zh-CN.md",
);
const TYPES_REFERENCE_PATH = join(process.cwd(), "docs", "types-reference.md");
const TYPES_REFERENCE_ZH_PATH = join(
  process.cwd(),
  "docs",
  "types-reference.zh-CN.md",
);
const CONFIG_REFERENCE_PATH = join(
  process.cwd(),
  "docs",
  "config-reference.md",
);
const CONFIG_REFERENCE_ZH_PATH = join(
  process.cwd(),
  "docs",
  "config-reference.zh-CN.md",
);
const GEN_BEGIN = "<!-- api-reference:generated -->";
const GEN_END = "<!-- /api-reference:generated -->";
const TYPES_GEN_BEGIN = "<!-- types-reference:generated -->";
const TYPES_GEN_END = "<!-- /types-reference:generated -->";
const CONFIG_GEN_BEGIN = "<!-- config-reference:generated -->";
const CONFIG_GEN_END = "<!-- /config-reference:generated -->";
const MARKER =
  "All numbers and tables below are derived from the source tables the " +
  "transport and the contracts use. Regenerate with `npm run " +
  "docs:api-reference`. A hand edit inside this block, or any disagreement " +
  "with the code, turns `packages/hosts/transport/test/api-reference.test.ts` red.";
const CONTRACT_SCHEMA_ENTRY = join(
  process.cwd(),
  "packages",
  "core",
  "contracts",
  "src",
  "schemas.ts",
);

function exportedModuleSources(entry: string): string[] {
  const sources: string[] = [];
  const visited = new Set<string>();
  const visit = (path: string) => {
    const resolved = extname(path) ? path : `${path}.ts`;
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const text = readFileSync(resolved, "utf8");
    sources.push(text);
    const exports = [...text.matchAll(/export \* from ["'](\.[^"']+)["'];?/gu)]
      .map((match) => match[1] ?? "")
      .filter(Boolean)
      .sort();
    for (const target of exports) visit(resolve(dirname(resolved), target));
  };
  visit(entry);
  return sources;
}

function eventTypeCount(): number {
  const text = readFileSync(
    join(process.cwd(), "packages", "core", "contracts", "src", "events.ts"),
    "utf8",
  );
  const from = text.indexOf("type RuntimeEventData =");
  const to = text.indexOf("export type RuntimeEvent =");
  if (from === -1 || to === -1 || to < from)
    throw new Error(
      "events.ts: RuntimeEventData union not found for doc count",
    );
  return text
    .slice(from, to)
    .split("\n")
    .filter((line) => /^\s*\| \{/u.test(line)).length;
}

function projectedEventTypeCount(): number {
  const dir = join(process.cwd(), "packages", "hosts", "view-store", "src");
  const cases = new Set<string>();
  for (const name of readdirSync(dir))
    if (name.endsWith(".ts"))
      for (const match of readFileSync(join(dir, name), "utf8").matchAll(
        /\bcase "([a-z_.]+)":/gu,
      ))
        cases.add(match[1] ?? "");
  return cases.size;
}

/**
 * The one-line meaning per failure kind, taken from the JSDoc on each member of
 * `RUNTIME_RPC_ERROR_CODES` in `packages/core/contracts/src/failures.ts`. The
 * comments are the source of truth for the reference; editing the constant's
 * prose without regenerating turns the guard red.
 */
function failureCodeMeanings(): Map<string, string> {
  const text = readFileSync(
    join(process.cwd(), "packages", "core", "contracts", "src", "failures.ts"),
    "utf8",
  );
  const start = text.indexOf("export const RUNTIME_RPC_ERROR_CODES =");
  if (start === -1)
    throw new Error("failures.ts: RUNTIME_RPC_ERROR_CODES not found");
  const block = text.slice(start);
  const meanings = new Map<string, string>();
  for (const match of block.matchAll(
    /\/\*\*([\s\S]*?)\*\/\s*([a-zA-Z][a-zA-Z0-9]*)\s*:/gu,
  )) {
    const comment = (match[1] ?? "")
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/u, "").trim())
      .filter(Boolean)
      .join(" ");
    meanings.set(match[2] ?? "", comment);
  }
  return meanings;
}

/**
 * SDK method → RPC method → params, scanned from the SDK's own `call(...)` sites
 * (`packages/tooling/sdk/src/sdk.ts`). The SDK object literal is the fact source: it
 * names the method, the RPC route it calls, the params object literal, and the
 * `call<T>` return type. A signature change in the SDK shows up here, so the
 * reference cannot describe a call the SDK does not make.
 */
/**
 * SDK method → RPC method → params, scanned from the SDK's own `call(...)` sites
 * and the `NataliaSDK` type (`packages/tooling/sdk/src/sdk.ts`). The SDK is the fact
 * source: it names the method, the RPC route it calls, and the signature. A
 * signature change in the SDK shows up here, so the reference cannot describe a
 * call the SDK does not make.
 */
function sdkMethodReference(): Array<{
  sdkMethod: string;
  rpcMethod: string;
  params: string;
  returnType: string;
}> {
  const text = readFileSync(
    join(process.cwd(), "packages", "tooling", "sdk", "src", "sdk.ts"),
    "utf8",
  );
  const objectStart = text.indexOf("return {");
  if (objectStart === -1)
    throw new Error("sdk/src/sdk.ts: SDK object not found");
  let depth = 0;
  let objectEnd = -1;
  for (let i = objectStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        objectEnd = i;
        break;
      }
    }
  }
  if (objectEnd === -1)
    throw new Error("sdk/src/index.ts: SDK object never closes");
  const object = text.slice(objectStart, objectEnd);
  const starts: Array<{ name: string; index: number }> = [];
  for (const entry of object.matchAll(/([a-zA-Z][a-zA-Z0-9]*): async/gu))
    starts.push({ name: entry[1] ?? "", index: entry.index ?? 0 });
  const rpcByMethod = new Map<
    string,
    { rpcMethod: string; callParams: string }
  >();
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]?.index ?? 0;
    const to =
      i + 1 < starts.length
        ? (starts[i + 1]?.index ?? object.length)
        : object.length;
    const body = object.slice(from, to);
    const callAt = body.indexOf("await call");
    if (callAt === -1) continue;
    const args = splitCallArgs(body, callAt);
    if (!args) continue;
    const rpcMethod = args[0]?.replace(/^"(.*)"$/u, "$1") ?? "";
    if (!rpcMethod) continue;
    const callParams = paramKeysOf(args[1] ?? "");
    rpcByMethod.set(starts[i]?.name ?? "", { rpcMethod, callParams });
  }

  /** Signature truth from the `NataliaSDK` type: params and return type. */
  const typeStart = text.indexOf("export type NataliaSDK = {");
  if (typeStart === -1)
    throw new Error("sdk/src/index.ts: NataliaSDK type not found");
  depth = 0;
  let typeEnd = -1;
  for (let i = typeStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        typeEnd = i;
        break;
      }
    }
  }
  if (typeEnd === -1)
    throw new Error("sdk/src/index.ts: NataliaSDK type never closes");
  const typeBlock = text.slice(typeStart, typeEnd);
  const rows: Array<{
    sdkMethod: string;
    rpcMethod: string;
    params: string;
    returnType: string;
  }> = [];
  for (const entry of typeBlock.matchAll(
    /([a-zA-Z][a-zA-Z0-9]*)\(([^)]*)\):\s*Promise</gu,
  )) {
    const [, sdkMethod, rawParams] = entry;
    if (!sdkMethod) continue;
    const returnMatch = balancedUntilAngle(
      text,
      typeStart +
        (entry.index ?? 0) +
        (entry[0] ?? "").indexOf("Promise<") +
        "Promise<".length,
    );
    const call = rpcByMethod.get(sdkMethod);
    const members = runtimeClientMembers();
    const typeParams = paramSignatureOf(
      resolveIndirection(rawParams ?? "", members),
    );
    rows.push({
      sdkMethod,
      rpcMethod: call?.rpcMethod ?? "—",
      params: typeParams || call?.callParams || "—",
      returnType: resolveIndirection(cleanType(returnMatch), members),
    });
  }
  return rows;
}

/** Reads a type expression until its angle and brace brackets balance. */
function balancedUntilAngle(text: string, start: number): string {
  let angleDepth = 0;
  let braceDepth = 0;
  let out = "";
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<") angleDepth++;
    else if (ch === ">") {
      if (angleDepth === 0 && braceDepth === 0) break;
      angleDepth--;
    } else if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth--;
    else if (ch === ";" && angleDepth === 0 && braceDepth === 0) break;
    out += ch;
  }
  return cleanType(out);
}

/** Strips the contracts import prefix and collapses newlines in a type. */
function cleanType(type: string): string {
  return type
    .replace(/import\("@natalia\/contracts"\)\./gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Extracts parameter keys with their types from a TypeScript parameter list. */
function paramKeysOf(params: string): string {
  const keys: string[] = [];
  const seen = new Set<string>();
  const stop = new Set([
    "string",
    "number",
    "boolean",
    "void",
    "undefined",
    "null",
    "unknown",
    "any",
    "true",
    "false",
    "Array",
    "Record",
    "Promise",
    "Extract",
    "Exclude",
    "NonNullable",
    "Awaited",
    "ReturnType",
    "readonly",
    "Date",
    "Error",
    "Object",
    "import",
  ]);
  const add = (name: string) => {
    if (name && !seen.has(name) && !stop.has(name)) {
      seen.add(name);
      keys.push(name);
    }
  };
  for (const match of params.matchAll(/([a-zA-Z][a-zA-Z0-9]*)\s*\??:/gu))
    add(match[1] ?? "");
  for (const match of params.matchAll(
    /(?:^|[{,\s])([a-z][a-zA-Z0-9]*)\s*\??\s*(?=:|\?|,|\}|\))/gu,
  ))
    add(match[1] ?? "");
  return keys.join(", ");
}

/** Splits a `call(...)` invocation into its top-level comma-separated arguments. */
function splitCallArgs(text: string, callIndex: number): string[] | undefined {
  let i = callIndex + "await call".length;
  while (i < text.length && text[i] !== "(") i++;
  if (i >= text.length) return undefined;
  // The call's own opening paren counts as depth 1, so its closing paren
  // returns to 0 and ends the argument list.
  let depth = 1;
  const args: string[] = [];
  let current = "";
  for (i = i + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      current += ch;
    } else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
      current += ch;
    } else if (ch === "," && depth === 1) {
      args.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  return undefined;
}

/**
 * Curated trigger notes for the event dictionary, keyed by event type. The
 * notes are grounded in the publish sites of the runtime; an event type with
 * no writer yet says so instead of guessing. A new event type that has no
 * note here shows a dash, so the gap is visible rather than silent.
 */
const EVENT_TRIGGERS: Record<string, string> = {
  "agent.selection":
    "an agent was selected or switched; `pending: false` after a deferred switch applied",
  "approval.request":
    "a tool or action needs approval; carries the request the caller must answer",
  "approval.response":
    "an approval was answered or timed out; `accepted: false` means it was too late",
  "capability.failed": "an optional capability failed to load",
  "capability.loaded": "an optional capability finished loading",
  "capability.unloaded": "an optional capability was unloaded",
  "checkpoint.created":
    "a durable checkpoint was created (turn start, compaction, context-limit recovery)",
  "checkpoint.failed":
    "a checkpoint could not be created; `reason`/`message` say why",
  "checkpoint.unavailable":
    "checkpointing is unavailable (for example no git present)",
  "compaction.begin": "context compaction started",
  "compaction.end": "context compaction finished with the retained summary",
  "constitution.check":
    "a constitution rule was evaluated against a workspace change",
  "constitution.override_granted":
    "the user approved a scoped constitution override",
  "constitution.rule_added": "a constitution rule was added",
  "constitution.rule_updated": "a constitution rule was updated",
  "content.delta": "streaming answer text; live only, never journaled",
  "content.partial":
    "throttled durable batch of streamed answer text (crash-recovery copy)",
  "content.done": "one completed answer chunk per provider step; journaled",
  "context.checkpoint":
    "the context journal reached a durable checkpoint (projection point)",
  "context.limit.recovery":
    "a provider context-limit hit and recovery (compaction plus retry) ran",
  "context.status":
    "the context ledger status changed (token estimate vs configured limits)",
  "decision.recorded": "a decision record was appended; no writer yet",
  diagnostic: "an error, warning or info message; `level` and `message`",
  "dialog.close": "the TUI dialog closed; UI-only",
  "dialog.open": "the TUI dialog opened; UI-only",
  "drift.finding_opened": "a drift finding was opened; no writer yet",
  "drift.finding_updated": "a drift finding was updated; no writer yet",
  "evidence.recorded":
    "evidence for a task objective was recorded; no writer yet",
  "mcp.status": "an MCP server connection changed state",
  "model.selection": "the model was selected or switched",
  "task.selection":
    "a completion/evidence card was selected so UIs align on one taskID",
  "plugin.update": "a plugin loaded, unloaded or reported a lifecycle change",
  "projections.updated":
    "plugin projection contributions changed; live snapshot of title/placement/text",
  "policy.decision":
    "a tool or action policy decision was made (allow/deny/approval_required/rejected)",
  "question.request":
    "a question needs an answer; carries the interactive request",
  "question.response": "a question was answered",
  "rollback.begin": "a workspace rollback started",
  "rollback.end": "a workspace rollback finished",
  "rollback.failed": "a workspace rollback failed",
  "rollback.previewed": "a rollback dry-run produced a preview",
  "sandbox.audit": "a sandbox management action was audited",
  "sandbox.diff": "a sandbox's pending change set was recorded or read",
  "sandbox.update": "a sandbox's status or change/resource counts changed",
  "session.created": "a session record was created",
  "session.ready": "the runtime's session finished loading (startup)",
  "session.snapshot": "a complete session state snapshot (projection)",
  "snapshot.created":
    "the `snapshot` member was called (a named snapshot id is minted)",
  "status.snapshot":
    "a full status snapshot (startup, or after significant changes)",
  "status.update": "the runtime status changed (paused, resumed, running, …)",
  "step.retry": "a provider step is being retried",
  "step.retry.cleared": "a pending step retry was cleared",
  "step.retry.exhausted": "a step retry was exhausted; the step fails",
  "subagent.update": "a subagent session changed state",
  "terminal.action": "a terminal action was performed (human or model side)",
  "terminal.approval": "a terminal approval scope was granted or revoked",
  "terminal.pane.select": "a terminal pane was selected; UI-only",
  "terminal.timeline": "a terminal action was appended to the timeline",
  "terminal.update": "a terminal session's status or screen changed",
  "terminal.viewer": "a terminal viewer was opened; UI-only",
  "flow.evaluator":
    "streaming reasoning/content text from a flow module evaluator (task delivery only)",
  "flow.finished":
    "a flow task finished (succeeded, failed or skipped); emitted by the flow submit path",
  "flow.module_event":
    "a flow module's arbitration lifecycle changed (activated, claimed, evaluated, completed, blocked, stalled, continued); streamed from task delivery so the TUI can render arbitration",
  "thinking.delta": "streaming reasoning text; live only, never journaled",
  "thinking.done": "completed reasoning text; journaled",
  "tool.registered": "a tool was registered in the catalogue",
  "tool.unregistered": "a tool was unregistered from the catalogue",
  "tool.update": "one per tool invocation: status, arguments and result",
  "turn.cancelled": "a turn was cancelled; `reason`",
  "turn.finished": "a turn ended; `stopReason`: done, cancelled or error",
  "turn.paused": "a turn is waiting on an approval or question",
  "turn.resumed": "a paused turn resumed",
  "turn.submitted": "a turn was accepted; `id` is the turn id",
  "workgraph.edge_added": "a work graph edge was added",
  "workgraph.node_added": "a work graph node was added",
};

/**
 * The event dictionary, scanned from the `RuntimeEventData` union in
 * `packages/core/contracts/src/events.ts`: every member's `type` literal and its
 * field names (with optionality). Field *types* are shown when they sit on the
 * field's own line; multi-line nested types are elided. The union is the fact
 * source, so adding an event or renaming a field updates the reference. The
 * trigger column comes from `EVENT_TRIGGERS`; an event without a note shows a
 * dash so a missing trigger is visible.
 */
function eventDictionary(): Array<{
  type: string;
  fields: string;
  trigger: string;
}> {
  const text = readFileSync(
    join(process.cwd(), "packages", "core", "contracts", "src", "events.ts"),
    "utf8",
  );
  const from = text.indexOf("type RuntimeEventData =");
  const to = text.indexOf("export type RuntimeEvent =");
  if (from === -1 || to === -1 || to < from)
    throw new Error(
      "events.ts: RuntimeEventData union not found for dictionary",
    );
  const union = text.slice(from, to);
  const rows: Array<{ type: string; fields: string; trigger: string }> = [];
  const lines = union.split("\n");
  let i = 0;
  while (i < lines.length) {
    const start = lines[i];
    if (!start || !/^\s*\| \{/u.test(start)) {
      i++;
      continue;
    }
    const memberLines: string[] = [];
    let braces = 0;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      memberLines.push(line);
      for (const ch of line) {
        if (ch === "{") braces++;
        else if (ch === "}") braces--;
      }
      i++;
      if (braces <= 0) break;
    }
    const member = memberLines.join("\n");
    const type = member.match(/type: "([a-z_.]+)"/u)?.[1] ?? "";
    if (!type) continue;
    const fields: string[] = [];
    const body = member
      .replace(/^\s*\|\s*\{/u, "")
      .replace(/\}\s*$/u, "")
      .trim();
    for (const part of splitTypeFields(body)) {
      const field = part
        .trim()
        .match(/^([a-zA-Z][a-zA-Z0-9]*)(\??):\s*(.+?)\s*$/u);
      if (!field) continue;
      const [, name, optional, typeText] = field;
      if (!name || name === "type") continue;
      if (/[{}\n]/u.test(typeText ?? "")) continue;
      fields.push(
        `\`${name}${optional === "?" ? "?" : ""}\`: ${(typeText ?? "").trim()}`,
      );
    }
    rows.push({
      type,
      fields: fields.join(", ") || "—",
      trigger: EVENT_TRIGGERS[type] ?? "—",
    });
  }
  return rows;
}

/**
 * Splits a `{ ... }` type body into field declarations: comments are
 * stripped first (a field preceded by a JSDoc comment must not take the whole
 * preceding chunk down with it), then semicolons are honored only at brace
 * depth zero so the fields of an inline object/array type do not leak to the
 * top level (an `Array<{ name; description? }>` must not surface its inner
 * `description` as if the outer type had it twice).
 */
function splitTypeFields(body: string): string[] {
  const cleaned = body
    .replace(/\/\*\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "");
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of cleaned) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (ch === ";" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Splits a parameter list on top-level commas (braces/parens/brackets aware). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Parses the `RuntimeClient` type into member -> { params, returnType }. */
function runtimeClientMembers(): Map<
  string,
  { params: string; returnType: string }
> {
  const text = readFileSync(
    join(process.cwd(), "packages", "core", "contracts", "src", "events.ts"),
    "utf8",
  );
  const from = text.indexOf("export type RuntimeClient = {");
  if (from === -1) throw new Error("events.ts: RuntimeClient type not found");
  let depth = 0;
  let end = -1;
  for (let i = from; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error("events.ts: RuntimeClient type never closes");
  const body = text
    .slice(from, end)
    .replace(/\/\*\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "");
  const members = new Map<string, { params: string; returnType: string }>();
  for (const match of body.matchAll(
    /([a-zA-Z][a-zA-Z0-9]*)\?*\(([^()]*)\)\s*:\s*/gu,
  )) {
    const name = match[1] ?? "";
    const params = match[2] ?? "";
    let i = (match.index ?? 0) + (match[0]?.length ?? 0);
    let memberDepth = 0;
    let ret = "";
    for (; i < body.length; i++) {
      const ch = body[i] ?? "";
      if (ch === "{") memberDepth++;
      else if (ch === "}") memberDepth--;
      else if (ch === ";" && memberDepth === 0) break;
      ret += ch;
    }
    members.set(name, { params: params.trim(), returnType: cleanType(ret) });
  }
  return members;
}

/**
 * Replaces `Parameters<NonNullable<RuntimeClient["x"]>>[n]` and
 * `Awaited<ReturnType<NonNullable<RuntimeClient["x"]>>>` indirections with
 * the member's concrete types, so the SDK table reads without opening the
 * contracts. Unresolvable indirections stay as written.
 */
function resolveIndirection(
  text: string,
  members: Map<string, { params: string; returnType: string }>,
): string {
  let out = text;
  out = out.replace(
    /Parameters<NonNullable<RuntimeClient\["([a-zA-Z0-9_]+)"\]>>\[(\d+)\]/gu,
    (whole, name, index) => {
      const member = members.get(name ?? "");
      if (!member) return whole;
      // `Parameters<F>[n]` is the whole n-th parameter including its
      // `name?:` prefix; the SDK names the parameter itself, so substitute
      // only the parameter's type.
      return (splitTopLevel(member.params)[Number(index)] ?? whole).replace(
        /^[a-zA-Z][a-zA-Z0-9]*\??:\s*/u,
        "",
      );
    },
  );
  out = out.replace(
    /Parameters<NonNullable<RuntimeClient\["([a-zA-Z0-9_]+)"\]>>/gu,
    (whole, name) => {
      const member = members.get(name ?? "");
      if (!member) return whole;
      return member.params || "void";
    },
  );
  out = out.replace(
    /Awaited<ReturnType<NonNullable<RuntimeClient\["([a-zA-Z0-9_]+)"\]>>>/gu,
    (whole, name) => {
      const member = members.get(name ?? "");
      if (!member) return whole;
      return member.returnType.replace(/^Promise<([\s\S]*?)>$/u, "$1");
    },
  );
  return cleanType(out);
}

/** Parameter names with their concrete types, `name?: Type`, nested objects kept whole. */
function paramSignatureOf(params: string): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const part of splitTopLevel(params)) {
    const field = part
      .trim()
      .match(/^([a-zA-Z][a-zA-Z0-9]*)(\??):\s*([\s\S]+?)\s*$/u);
    if (!field) continue;
    const [, name, optional, rawType] = field;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const type = cleanType(rawType ?? "");
    parts.push(`\`${name}${optional === "?" ? "?" : ""}\`: ${type || "—"}`);
  }
  return parts.join(", ") || "—";
}

/**
 * Parses every `export type NAME = RHS` in `packages/core/contracts/src` — object
 * bodies, unions and aliases alike — keyed by name.
 */
function contractTypeDefinitions(): Map<string, string> {
  const dir = join(process.cwd(), "packages", "core", "contracts", "src");
  const definitions = new Map<string, string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(join(dir, file), "utf8");
    for (const match of text.matchAll(/export type ([A-Z][A-Za-z0-9_]*) =/gu)) {
      const name = match[1] ?? "";
      if (definitions.has(name)) continue;
      const start = (match.index ?? 0) + (match[0]?.length ?? 0);
      let i = start;
      while (i < text.length && /\s/u.test(text[i] ?? "")) i++;
      const object = text[i] === "{";
      let depth = 0;
      let rhs = "";
      for (; i < text.length; i++) {
        const ch = text[i] ?? "";
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (object && depth === 0) {
            rhs += ch;
            i++;
            break;
          }
        } else if (!object && ch === ";" && depth === 0) break;
        rhs += ch;
      }
      definitions.set(name, rhs.trim());
    }
  }
  return definitions;
}

/** The text between the first `{` and its matching `}`. */
function extractFirstBraceBody(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) return "";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return "";
}

/**
 * Resolves an alias RHS into a self-contained display: a zod-derived type
 * points at its schema's rows in the config reference, and an
 * `Extract<RuntimeEvent, { type: "x" }>` alias resolves to the event
 * dictionary fields of that event (an `& { ... }` intersection is appended).
 */
function resolveAliasRHS(
  body: string,
  eventFields: Map<string, string>,
): string {
  const flat = body
    .replace(/import\("[^"]+"\)\./gu, "")
    .replace(/\s+/gu, " ")
    .replace(/\s*\|\s*/gu, " | ")
    .trim();
  const zod = flat.match(
    /^z\.(?:infer|input)<typeof ([A-Za-z][A-Za-z0-9]*)>$/u,
  );
  if (zod)
    return `zod schema \`${zod[1] ?? ""}\` — fields in the config reference`;
  const extract = flat.match(
    /^Extract<\s*RuntimeEvent,\s*\{\s*type: "([a-z_.]+)"\s*\}>(.*)$/u,
  );
  if (extract) {
    const fields = eventFields.get(extract[1] ?? "");
    const rest = (extract[2] ?? "").trim();
    const base = fields
      ? `event dictionary \`${extract[1] ?? ""}\` fields: ${fields}`
      : flat;
    return rest ? `${base} ${rest}` : base;
  }
  return flat;
}

/** The type text of one field inside an object type body. */
function objectFieldType(body: string, fieldName: string): string | undefined {
  for (const part of splitTypeFields(body)) {
    const field = part
      .trim()
      .match(/^([a-zA-Z][a-zA-Z0-9]*)(\??):\s*([\s\S]+?)\s*$/u);
    if (field?.[1] === fieldName) return field[3] ?? "";
  }
  return undefined;
}

const TYPE_BUILTINS = new Set([
  "Array",
  "Record",
  "Promise",
  "Extract",
  "Exclude",
  "Omit",
  "Pick",
  "Partial",
  "Required",
  "Readonly",
  "NonNullable",
  "Awaited",
  "ReturnType",
  "Parameters",
  "Exact",
  "string",
  "number",
  "boolean",
  "void",
  "undefined",
  "null",
  "unknown",
  "any",
  "never",
  "symbol",
  "bigint",
  "object",
  "Date",
  "Error",
  "Function",
]);

/**
 * Expands one field type into display rows. Inline objects/arrays expand with
 * dotted (`obj.field`) or indexed (`arr[].field`) paths; `Name["field"]`
 * indexed accesses resolve when the target type is known; multi-line unions
 * collapse to one line; named types stay as names (their own row exists).
 */
function expandFieldType(
  path: string,
  typeText: string,
  definitions: Map<string, string>,
  depth: number,
): Array<{ path: string; type: string }> {
  const cleaned = typeText
    .replace(/\/\*\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "")
    .replace(/import\("[^"]+"\)\./gu, "")
    .trim();
  const flat = (value: string) =>
    value
      .replace(/\s+/gu, " ")
      .replace(/\s*\|\s*/gu, " | ")
      .trim();
  if (depth > 6) return [{ path, type: "…" }];
  if (hasTopLevelUnion(cleaned)) return [{ path, type: flat(cleaned) || "—" }];
  if (
    /Array<\{/u.test(cleaned) ||
    (/\]\s*$/u.test(cleaned) && /\{/u.test(cleaned))
  ) {
    const inner = extractFirstBraceBody(cleaned);
    if (inner)
      return expandObjectBody(`${path}[]`, inner, definitions, depth + 1);
  }
  if (cleaned.startsWith("{")) {
    const inner = extractFirstBraceBody(cleaned);
    if (inner) return expandObjectBody(path, inner, definitions, depth + 1);
  }
  const indexed = cleaned.match(
    /^([A-Z][A-Za-z0-9_]*)\[["']([A-Za-z0-9_]+)["']\]$/u,
  );
  if (indexed) {
    const target = definitions.get(indexed[1] ?? "");
    if (target?.trim().startsWith("{")) {
      const fieldType = objectFieldType(target, indexed[2] ?? "");
      if (fieldType)
        return expandFieldType(path, fieldType, definitions, depth + 1);
    }
  }
  return [{ path, type: flat(cleaned) || "—" }];
}

function hasTopLevelUnion(value: string): boolean {
  let braces = 0;
  let brackets = 0;
  let angles = 0;
  for (const character of value) {
    if (character === "{") braces++;
    else if (character === "}") braces--;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (character === "<") angles++;
    else if (character === ">") angles--;
    else if (
      character === "|" &&
      braces === 0 &&
      brackets === 0 &&
      angles === 0
    )
      return true;
  }
  return false;
}

/** Expands an object type body into dotted-path rows. */
function expandObjectBody(
  path: string,
  body: string,
  definitions: Map<string, string>,
  depth: number,
): Array<{ path: string; type: string }> {
  const out: Array<{ path: string; type: string }> = [];
  if (depth > 6) return [{ path, type: "…" }];
  for (const part of splitTypeFields(body)) {
    const field = part
      .trim()
      .match(/^([a-zA-Z][a-zA-Z0-9]*)(\??):\s*([\s\S]+?)\s*$/u);
    if (!field) continue;
    const [, name, optional, typeText] = field;
    if (!name) continue;
    out.push(
      ...expandFieldType(
        `${path}.${name}${optional === "?" ? "?" : ""}`,
        typeText ?? "",
        definitions,
        depth + 1,
      ),
    );
  }
  return out;
}

/**
 * The deep result type dictionary for `docs/types-reference.md`: every type
 * reachable from the SDK's parameters and returns, with nested objects
 * expanded into dotted/indexed field paths. The contracts are the fact
 * source, so the table cannot rot; the giant event union family
 * (`RuntimeEvent`/`RuntimeEventData`) is skipped because api-reference's
 * event dictionary already covers it.
 */
function deepTypeDictionary(): Array<{ name: string; fields: string }> {
  const definitions = contractTypeDefinitions();
  const skip = new Set(["RuntimeEvent", "RuntimeEventData"]);
  const members = runtimeClientMembers();
  const eventFields = new Map(
    eventDictionary().map((row) => [row.type, row.fields]),
  );
  const seed = new Set<string>();
  const collectNames = (text: string) => {
    for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/gu)) {
      const name = match[1] ?? "";
      if (definitions.has(name) && !TYPE_BUILTINS.has(name)) seed.add(name);
    }
  };
  for (const row of sdkMethodReference()) {
    collectNames(resolveIndirection(row.params, members));
    collectNames(resolveIndirection(row.returnType, members));
  }
  const rows: Array<{ name: string; fields: string }> = [];
  const done = new Set<string>();
  const pending = [...seed].filter((name) => !skip.has(name)).sort();
  while (pending.length > 0) {
    const name = pending.shift() ?? "";
    if (done.has(name)) continue;
    done.add(name);
    const rhs = definitions.get(name);
    if (!rhs) continue;
    const body = rhs
      .replace(/\/\*\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/[^\n]*/gu, "");
    const fields: Array<{ path: string; type: string }> = [];
    if (rhs.trim().startsWith("{")) {
      const inner = extractFirstBraceBody(rhs);
      fields.push(...expandObjectBody("", inner, definitions, 0));
    } else {
      fields.push({ path: "", type: resolveAliasRHS(body, eventFields) });
    }
    for (const match of body.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/gu)) {
      const reference = match[1] ?? "";
      if (
        definitions.has(reference) &&
        !TYPE_BUILTINS.has(reference) &&
        !skip.has(reference) &&
        !done.has(reference)
      )
        pending.push(reference);
    }
    rows.push({
      name,
      fields: fields
        .map((field) =>
          field.path
            ? `\`${field.path.replace(/^\./u, "")}\`: ${field.type}`
            : `\`${field.type}\``,
        )
        .join(", "),
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The value-refusal dictionary, scanned from `RUNTIME_MEMBER_REFUSAL_SEMANTICS`
 * in `packages/core/contracts/src/refusals.ts`: the members that refuse with a
 * value (instead of an error), which field expresses the refusal, and the
 * semantics note. The table is the fact source for §5's "refusal is a value"
 * rule, so a member whose refusal semantics change updates the reference.
 */
function valueRefusalDictionary(): Array<{
  member: string;
  expressedBy: string;
  note: string;
}> {
  const text = readFileSync(
    join(process.cwd(), "packages", "core", "contracts", "src", "refusals.ts"),
    "utf8",
  );
  const from = text.indexOf("export const RUNTIME_MEMBER_REFUSAL_SEMANTICS =");
  if (from === -1)
    throw new Error("refusals.ts: RUNTIME_MEMBER_REFUSAL_SEMANTICS not found");
  let depth = 0;
  let end = -1;
  for (let i = from; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1)
    throw new Error(
      "refusals.ts: RUNTIME_MEMBER_REFUSAL_SEMANTICS never closes",
    );
  const body = text.slice(from, end);
  const rows: Array<{ member: string; expressedBy: string; note: string }> = [];
  for (const match of body.matchAll(
    /([a-zA-Z][a-zA-Z0-9]*):\s*\{[^}]*refusal:\s*"value"[^}]*expressedBy:\s*"([^"]*)"[^}]*note:\s*"([^"]*)"[^}]*\}/gu,
  )) {
    const member = match[1] ?? "";
    if (!member) continue;
    rows.push({
      member,
      expressedBy: match[2] ?? "",
      note: (match[3] ?? "").trim(),
    });
  }
  return rows.sort((a, b) => a.member.localeCompare(b.member));
}

/**
 * The config shape dictionary, parsed from the zod schema export graph rooted
 * at `packages/core/contracts/src/schemas.ts` (`configV3Schema` validates
 * `.natalia/config.json`). One row per schema field, dotted paths for nested
 * objects, `?` for optional fields and the default value where the schema
 * declares one. `z.record(X)` keys are arbitrary; the element type's own
 * fields live on its schema's rows.
 */
function zodSchemaDictionary(): Array<{
  schema: string;
  path: string;
  type: string;
  optional: boolean;
  defaultValue: string;
}> {
  const text = stripComments(
    exportedModuleSources(CONTRACT_SCHEMA_ENTRY).join("\n"),
  );
  const schemas = new Map<string, string>();
  for (const match of text.matchAll(
    /export const ([A-Za-z][A-Za-z0-9]*) = ([\s\S]*?)(?=\nexport )/gu,
  )) {
    const name = match[1] ?? "";
    if (name.endsWith("Schema") || name === "configV3Schema")
      schemas.set(name, (match[2] ?? "").trim());
  }
  const rows: Array<{
    schema: string;
    path: string;
    type: string;
    optional: boolean;
    defaultValue: string;
  }> = [];
  const visited = new Set<string>();
  const visit = (schemaName: string) => {
    if (visited.has(schemaName)) return;
    visited.add(schemaName);
    const rhs = schemas.get(schemaName);
    if (!rhs) return;
    const object = extractZodObjectBody(rhs);
    if (!object) return;
    for (const field of splitTopLevel(object)) {
      const parsed = field
        .trim()
        .match(/^([a-zA-Z][a-zA-Z0-9]*):\s*([\s\S]+?)\s*$/u);
      if (!parsed) continue;
      const fieldName = parsed[1] ?? "";
      const zod = parseZodType(parsed[2] ?? "");
      rows.push({
        schema: schemaName,
        path: fieldName,
        type: zod.type,
        optional: zod.optional,
        defaultValue: zod.defaultValue,
      });
      for (const nested of expandZodObject(
        fieldName,
        parsed[2] ?? "",
        schemas,
        1,
      ))
        rows.push({ schema: schemaName, ...nested });
    }
    for (const reference of zodReferences(rhs)) visit(reference);
  };
  visit("configV3Schema");
  return rows;
}

/**
 * Removes `//` and block comments, keeping newlines so the remaining text
 * stays on its original lines.
 *
 * The field scan splits an object body on top-level commas and then matches
 * `name: type`, so a documented field would otherwise be dropped from the
 * table: the comma-bearing prose above it lands in the same segment and the
 * segment no longer starts with a field name. Comments inside string and
 * template literals are left alone, so a `"https://…"` default survives.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length) {
        const cur = source[i] ?? "";
        out += cur;
        i++;
        if (cur === "\\") {
          out += source[i] ?? "";
          i++;
          continue;
        }
        if (cur === quote) break;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (
        i < source.length &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** The object body of a `z.object({ ... })` schema expression. */
function extractZodObjectBody(rhs: string): string | undefined {
  const object = rhs.match(/z\s*\.\s*object\(\{/u);
  if (!object) return undefined;
  const start = (object.index ?? 0) + (object[0]?.length ?? 0);
  // The object's own opening brace counts as depth 1, so its matching close
  // returns to 0 and ends the body (a nested `{ ... }` inside `.default()`
  // must not end it).
  let depth = 1;
  for (let i = start; i < rhs.length; i++) {
    const ch = rhs[i] ?? "";
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return rhs.slice(start, i);
    }
  }
  return undefined;
}

/** Nested `z.object` bodies inside a field, expanded to dotted paths. */
function expandZodObject(
  path: string,
  expr: string,
  schemas: Map<string, string>,
  depth: number,
): Array<{
  path: string;
  type: string;
  optional: boolean;
  defaultValue: string;
}> {
  const out: Array<{
    path: string;
    type: string;
    optional: boolean;
    defaultValue: string;
  }> = [];
  if (depth > 6) return out;
  const arrayBody = expr.match(/z\s*\.\s*array\(\s*z\s*\.\s*object\(\{/u);
  const objectBody = expr.match(/z\s*\.\s*object\(\{/u);
  const body = extractFirstBraceBody(
    arrayBody
      ? (arrayBody[0] ?? "") + expr.slice((arrayBody[0] ?? "").length)
      : expr,
  );
  const prefix = arrayBody ? `${path}[]` : path;
  if (!body) {
    // `z.infer<typeof X>` — the referenced schema's fields stay on its rows.
    return out;
  }
  for (const field of splitTopLevel(body)) {
    const parsed = field
      .trim()
      .match(/^([a-zA-Z][a-zA-Z0-9]*):\s*([\s\S]+?)\s*$/u);
    if (!parsed) continue;
    const fieldName = parsed[1] ?? "";
    const zod = parseZodType(parsed[2] ?? "");
    out.push({
      path: `${prefix}.${fieldName}`,
      type: zod.type,
      optional: zod.optional,
      defaultValue: zod.defaultValue,
    });
    out.push(
      ...expandZodObject(
        `${prefix}.${fieldName}`,
        parsed[2] ?? "",
        schemas,
        depth + 1,
      ),
    );
  }
  return out;
}

/** Parses one zod type expression into its display form. */
function parseZodType(expr: string): {
  type: string;
  optional: boolean;
  defaultValue: string;
} {
  let text = expr.trim();
  text = text.replace(/^z\s*\./u, "");
  const constructor = text.match(/^([a-zA-Z]+)\(/u);
  if (!constructor) {
    // A referenced schema with a modifier chain (`runtimeConfigSchema.default({})`):
    // the name is the type; the tail still carries optional/default info.
    const referenced = text.match(/^([A-Za-z][A-Za-z0-9]*)([\s\S]*)$/u);
    const type = (referenced?.[1] ?? text).replace(/\s+/gu, " ").trim();
    const parsed = parseZodModifiers(referenced?.[2] ?? "");
    return {
      type,
      optional: parsed.optional,
      defaultValue: parsed.defaultValue,
    };
  }
  const kind = constructor[1] ?? "";
  const start = (constructor.index ?? 0) + (constructor[0]?.length ?? 0);
  // The constructor's own opening paren counts as depth 1, so its closing
  // paren returns to 0 and ends the argument list.
  let depth = 1;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const args = splitTopLevel(end === -1 ? "" : text.slice(start, end).trim());
  const parsed = parseZodModifiers(text.slice((end ?? 0) + 1));
  const optional = parsed.optional;
  const defaultValue = parsed.defaultValue;
  switch (kind) {
    case "object": {
      return { type: "object", optional, defaultValue };
    }
    case "enum": {
      const values = args.map((arg) => arg.trim()).join(" | ");
      return { type: values || "enum", optional, defaultValue };
    }
    case "array": {
      return {
        type: `${args[0] ? parseZodType(args[0] ?? "").type : "unknown"}[]`,
        optional,
        defaultValue,
      };
    }
    case "record": {
      const value = args[1] ?? args[0] ?? "";
      const valueType = parseZodType(value).type;
      return {
        type: `Record<string, ${valueType || "unknown"}>`,
        optional,
        defaultValue,
      };
    }
    case "union": {
      const values = args.map((arg) => parseZodType(arg).type).join(" | ");
      return { type: values || "union", optional, defaultValue };
    }
    case "literal": {
      return { type: args[0]?.trim() || "literal", optional, defaultValue };
    }
    case "infer":
    case "input": {
      const target = args[0] ?? "";
      const name = target.match(/typeof\s+([A-Za-z][A-Za-z0-9]*)/u)?.[1];
      return { type: name ?? target, optional, defaultValue };
    }
    case "string":
    case "number":
    case "boolean":
    case "any":
    case "unknown":
    case "null":
    case "never":
    case "date":
    case "bigint":
      return { type: kind, optional, defaultValue };
    case "array": // unreachable, kept for clarity
      return { type: "unknown[]", optional, defaultValue };
    case "custom":
      return { type: "custom", optional, defaultValue };
    case "discriminatedUnion": {
      const target = args[0]?.trim() ?? "";
      return {
        type: target ? `discriminated by ${target}` : "discriminatedUnion",
        optional,
        defaultValue,
      };
    }
    case "intersection":
    case "record": // handled above
      return { type: "object", optional, defaultValue };
    default:
      return { type: kind, optional, defaultValue };
  }
}

/** Parses the `.optional()/.nullable()/.nullish()/.default(...)` modifier chain. */
function parseZodModifiers(tail: string): {
  optional: boolean;
  defaultValue: string;
} {
  let optional = false;
  let defaultValue = "";
  for (const modifier of tail.matchAll(
    /\.(\w+)(?:\((?:[^()]|\([^()]*\))*\))?/gu,
  )) {
    const mod = modifier[1] ?? "";
    if (mod === "optional" || mod === "nullish") optional = true;
    if (mod === "default") {
      const arg = (modifier[0] ?? "")
        .replace(/^\.default\(/u, "")
        .replace(/\)\s*$/u, "");
      defaultValue = arg.replace(/\s+/gu, " ").slice(0, 80);
    }
  }
  return { optional, defaultValue };
}

/** Every schema name referenced inside an expression. */
function zodReferences(expr: string): string[] {
  const out: string[] = [];
  for (const match of expr.matchAll(/\b([A-Za-z][A-Za-z0-9]*Schema)\b/gu))
    out.push(match[1] ?? "");
  return out;
}

function markdownTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const rule = widths.map((width) => "-".repeat(width));
  const line = (cells: string[]) =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(" | ")} |`;
  return [line(headers), line(rule), ...rows.map((row) => line(row))].join(
    "\n",
  );
}

export function renderGeneratedSections(): string {
  const groups = RUNTIME_CAPABILITY_GROUPS;
  const groupNames = Object.keys(groups) as Array<keyof typeof groups>;
  const optionalMembers = groupNames.flatMap((name) =>
    (groups[name] as readonly string[]).map(
      (member) => [name, member] as const,
    ),
  );
  const routes = Object.entries(RPC_ROUTE_MEMBERS) as Array<
    [string, keyof RuntimeClient | null]
  >;

  const deprecated = Object.entries(DEPRECATED_RUNTIME_MEMBERS);
  const lines = [
    `## Machine-derived reference`,
    ``,
    `> ${MARKER}`,
    ``,
    `### Protocol version`,
    ``,
    `- \`apiVersion\` = \`${API_VERSION}\` (\`API_VERSION\`).`,
    `- Stable required surface (\`API_STABLE_SURFACE.requiredMembers\`, ${REQUIRED_RUNTIME_MEMBERS.length} members):`,
    `  \`${REQUIRED_RUNTIME_MEMBERS.join("`, `")}\`.`,
    `- Deprecated members (\`DEPRECATED_RUNTIME_MEMBERS\`): ${
      deprecated.length === 0
        ? "none (mechanism in place, table empty)"
        : deprecated
            .map(
              ([name, meta]) =>
                `\`${name}\`${meta.replacement ? ` → \`${meta.replacement}\`` : ""}${meta.since !== undefined ? ` (since ${meta.since})` : ""}`,
            )
            .join("; ")
    }.`,
    ``,
    `### Capability groups (${groupNames.length} groups · ${optionalMembers.length} optional members)`,
    ``,
    markdownTable(
      ["Group", "Members (RuntimeClient names)"],
      groupNames.map((name) => [
        name,
        (groups[name] as readonly string[]).map((m) => `\`${m}\``).join(" · "),
      ]),
    ),
    ``,
    `### RPC route table (${routes.length} methods → members)`,
    ``,
    markdownTable(
      ["RPC method", "RuntimeClient member", "Capability group", "Write"],
      routes.map(([method, member]) => [
        `\`${method}\``,
        member === null ? "(availability route, no member)" : `\`${member}\``,
        member === null ? "—" : (capabilityGroupOf(member) ?? "required"),
        RPC_WRITE_METHODS.has(method) ? "write" : "read",
      ]),
    ),
    ``,
    `### Write surface (\`RPC_WRITE_METHODS\`, ${RPC_WRITE_METHODS.size} methods; read-only credentials get \`-32001 refused\`)`,
    ``,
    RPC_WRITE_METHODS.size === 0
      ? "(empty)"
      : [...RPC_WRITE_METHODS].map((method) => `- \`${method}\``).join("\n"),
    ``,
    `### Intentionally local members (\`RPC_INTENTIONALLY_LOCAL\`; reported as \`intentionally local\`)`,
    ``,
    markdownTable(
      ["Member", "Reason"],
      Object.entries(RPC_INTENTIONALLY_LOCAL).map(([member, reason]) => [
        `\`${member}\``,
        reason,
      ]),
    ),
    ``,
    `### Empty-until-writers queries (\`UNIMPLEMENTED_QUERIES\`: reachable, implemented, no production writer yet)`,
    ``,
    markdownTable(
      ["Member", "Why it answers empty"],
      (Object.entries(UNIMPLEMENTED_QUERIES) as Array<[string, string]>).map(
        ([member, reason]) => [`\`${member}\``, reason],
      ),
    ),
    ``,
    `### Failure codes (\`RUNTIME_RPC_ERROR_CODES\`)`,
    ``,
    markdownTable(
      ["Kind", "Code", "Meaning"],
      (
        Object.keys(RUNTIME_RPC_ERROR_CODES) as Array<
          keyof typeof RUNTIME_RPC_ERROR_CODES
        >
      ).map((kind) => [
        `\`${kind}\``,
        String(RUNTIME_RPC_ERROR_CODES[kind]),
        failureCodeMeanings().get(kind) ?? "",
      ]),
    ),
    ``,
    `### Value refusals (members that refuse with a value)`,
    ``,
    `> These members answer an ordinary outcome instead of an error: the refusal is a field of the result. The field is listed per member; the same call shape never switches between value and error depending on state.`,
    ``,
    markdownTable(
      ["Member", "Refusal expressed by", "Semantics"],
      valueRefusalDictionary().map((row) => [
        `\`${row.member}\``,
        `\`${row.expressedBy}\``,
        row.note,
      ]),
    ),
    ``,
    `### Events and projection (source scan)`,
    ``,
    `- Runtime event types (\`RuntimeEventData\` union): ${eventTypeCount()}.`,
    `- view-store projections (\`case\` labels in \`packages/hosts/view-store/src\`): ${projectedEventTypeCount()}.`,
    ``,
    `### SDK methods → RPC routes (source scan of \`packages/tooling/sdk/src/sdk.ts\`)`,
    ``,
    markdownTable(
      ["SDK method", "RPC method", "Params", "Return type"],
      sdkMethodReference().map((row) => [
        `\`${row.sdkMethod}\``,
        `\`${row.rpcMethod}\``,
        row.params || "—",
        row.returnType,
      ]),
    ),
    ``,
    `### Runtime event dictionary (source scan of \`packages/core/contracts/src/events.ts\`)`,
    ``,
    markdownTable(
      ["Event type", "Fields", "Trigger"],
      eventDictionary().map((row) => [
        `\`${row.type}\``,
        row.fields,
        row.trigger,
      ]),
    ),
  ];
  return lines.join("\n") + "\n";
}

/**
 * The generated block for `docs/types-reference.md`: the deep result type
 * dictionary, one row per type reachable from the SDK's parameters and
 * returns. Nested objects are expanded into dotted (`obj.field`) and indexed
 * (`arr[].field`) paths, so a consumer does not have to open the contracts.
 */
function renderTypesReferenceSections(): string {
  return (
    [
      `## Result type dictionary (deep expansion)`,
      ``,
      `> Nested objects are expanded into paths: \`obj.field\` for plain objects, \`arr[].field\` for array elements. A \`?\` suffix marks an optional field; \`?.field\` means the field exists only when its parent optional field is present. Unions are shown inline. The giant event union family is omitted here — see the event dictionary in the API reference.`,
      ``,
      markdownTable(
        ["Type", "Fields"],
        deepTypeDictionary().map((row) => [`\`${row.name}\``, row.fields]),
      ),
    ].join("\n") + "\n"
  );
}

/**
 * The generated block for `docs/config-reference.md`: the shape of
 * `.natalia/config.json` and every schema it reaches, parsed from the zod
 * schema export graph rooted at `packages/core/contracts/src/schemas.ts`. `?` marks optional fields;
 * the Default column shows the schema's declared default. `z.record(X)` keys
 * are arbitrary — the element type's fields are on its own rows.
 */
function renderConfigReferenceSections(): string {
  const rows = zodSchemaDictionary();
  return (
    [
      `## Config shape (source scan of the zod schema graph rooted at \`packages/core/contracts/src/schemas.ts\`)`,
      ``,
      markdownTable(
        ["Schema", "Field", "Type", "Optional", "Default"],
        rows.map((row) => [
          `\`${row.schema}\``,
          `\`${row.path}\``,
          row.type,
          row.optional ? "yes" : "",
          row.defaultValue,
        ]),
      ),
    ].join("\n") + "\n"
  );
}

/**
 * Replace every generated block in a document, not just the first.
 *
 * The reference documents carry the generated block twice — once in the English
 * section and once in the Chinese one — and a single `indexOf` pair rewrote only
 * the first. The second therefore froze at whatever the source looked like when
 * it was last written by hand, and no amount of regenerating brought it forward.
 * The gate could not see it either, because the gate runs this same writer.
 */
function replaceAllBlocks(full: string, block: string, path: string): string {
  let out = "";
  let cursor = 0;
  for (;;) {
    const start = full.indexOf(GEN_BEGIN, cursor);
    const end = full.indexOf(GEN_END, cursor);
    if (start === -1 && end === -1) break;
    if (start === -1 || end === -1 || end < start)
      throw new Error(
        `${path} has an unpaired generated-block marker (${GEN_BEGIN} … ${GEN_END})`,
      );
    out += full.slice(cursor, start) + block;
    cursor = end + GEN_END.length;
  }
  if (cursor === 0)
    throw new Error(
      `${path} is missing the generated-block markers (${GEN_BEGIN} … ${GEN_END})`,
    );
  return out + full.slice(cursor);
}

export function writeApiReference(): void {
  const block = `${GEN_BEGIN}\n${renderGeneratedSections()}${GEN_END}`;
  for (const path of [API_REFERENCE_PATH, API_REFERENCE_ZH_PATH]) {
    writeFileSync(
      path,
      replaceAllBlocks(readFileSync(path, "utf8"), block, path),
    );
  }
  const typesBlock = `${TYPES_GEN_BEGIN}\n${renderTypesReferenceSections()}${TYPES_GEN_END}`;
  for (const path of [TYPES_REFERENCE_PATH, TYPES_REFERENCE_ZH_PATH]) {
    const full = readFileSync(path, "utf8");
    const start = full.indexOf(TYPES_GEN_BEGIN);
    const end = full.indexOf(TYPES_GEN_END);
    if (start === -1 || end === -1 || end < start)
      throw new Error(
        `${path} is missing the generated-block markers (${TYPES_GEN_BEGIN} … ${TYPES_GEN_END})`,
      );
    writeFileSync(
      path,
      `${full.slice(0, start)}${typesBlock}${full.slice(end + TYPES_GEN_END.length)}`,
    );
  }
  const configBlock = `${CONFIG_GEN_BEGIN}\n${renderConfigReferenceSections()}${CONFIG_GEN_END}`;
  for (const path of [CONFIG_REFERENCE_PATH, CONFIG_REFERENCE_ZH_PATH]) {
    const full = readFileSync(path, "utf8");
    const start = full.indexOf(CONFIG_GEN_BEGIN);
    const end = full.indexOf(CONFIG_GEN_END);
    if (start === -1 || end === -1 || end < start)
      throw new Error(
        `${path} is missing the generated-block markers (${CONFIG_GEN_BEGIN} … ${CONFIG_GEN_END})`,
      );
    writeFileSync(
      path,
      `${full.slice(0, start)}${configBlock}${full.slice(end + CONFIG_GEN_END.length)}`,
    );
  }
}

if (!process.env.API_REFERENCE_WRITE) {
  test("docs/api-reference.md generated block matches the source tables", () => {
    const full = readFileSync(API_REFERENCE_PATH, "utf8");
    const block = `${GEN_BEGIN}\n${renderGeneratedSections()}${GEN_END}`;
    expect(full).toContain(block);
  });
  test("docs/api-reference.zh-CN.md embeds the same generated block", () => {
    const en = readFileSync(API_REFERENCE_PATH, "utf8");
    const zh = readFileSync(API_REFERENCE_ZH_PATH, "utf8");
    const start = en.indexOf(GEN_BEGIN);
    const end = en.indexOf(GEN_END);
    if (start === -1 || end === -1 || end < start)
      throw new Error(
        `${API_REFERENCE_PATH} is missing the generated-block markers`,
      );
    const block = en.slice(start, end + GEN_END.length);
    expect(zh).toContain(block);
  });
  test("docs/types-reference.md generated block matches the source tables", () => {
    const full = readFileSync(TYPES_REFERENCE_PATH, "utf8");
    const block = `${TYPES_GEN_BEGIN}\n${renderTypesReferenceSections()}${TYPES_GEN_END}`;
    expect(full).toContain(block);
  });
  test("docs/types-reference.zh-CN.md embeds the same generated block", () => {
    const en = readFileSync(TYPES_REFERENCE_PATH, "utf8");
    const zh = readFileSync(TYPES_REFERENCE_ZH_PATH, "utf8");
    const start = en.indexOf(TYPES_GEN_BEGIN);
    const end = en.indexOf(TYPES_GEN_END);
    if (start === -1 || end === -1 || end < start)
      throw new Error(
        `${TYPES_REFERENCE_PATH} is missing the generated-block markers`,
      );
    const block = en.slice(start, end + TYPES_GEN_END.length);
    expect(zh).toContain(block);
  });
  test("docs/config-reference.md generated block matches the source tables", () => {
    const full = readFileSync(CONFIG_REFERENCE_PATH, "utf8");
    const block = `${CONFIG_GEN_BEGIN}\n${renderConfigReferenceSections()}${CONFIG_GEN_END}`;
    expect(full).toContain(block);
  });
  test("docs/config-reference.zh-CN.md embeds the same generated block", () => {
    const en = readFileSync(CONFIG_REFERENCE_PATH, "utf8");
    const zh = readFileSync(CONFIG_REFERENCE_ZH_PATH, "utf8");
    const start = en.indexOf(CONFIG_GEN_BEGIN);
    const end = en.indexOf(CONFIG_GEN_END);
    if (start === -1 || end === -1 || end < start)
      throw new Error(
        `${CONFIG_REFERENCE_PATH} is missing the generated-block markers`,
      );
    const block = en.slice(start, end + CONFIG_GEN_END.length);
    expect(zh).toContain(block);
  });
  test("the config dictionary keeps fields that carry a doc comment", () => {
    // A comment above a field used to swallow it: its prose commas split the
    // object body, so the field never matched `name: type` and vanished from
    // the table even though the config accepts it.
    const documented = zodSchemaDictionary().map(
      (row) => `${row.schema}.${row.path}`,
    );
    expect(documented).toContain("pluginConfigSchema.settings");
    expect(documented).toContain("issueTargetConfigSchema.token");
    expect(documented).toContain("dataSourceConfigSchema.timestampField");
  });
}

if (process.env.API_REFERENCE_WRITE && import.meta.main) {
  writeApiReference();
  console.log(
    `updated ${API_REFERENCE_PATH}, ${API_REFERENCE_ZH_PATH}, ${TYPES_REFERENCE_PATH}, ${TYPES_REFERENCE_ZH_PATH}, ${CONFIG_REFERENCE_PATH}, ${CONFIG_REFERENCE_ZH_PATH}`,
  );
}
