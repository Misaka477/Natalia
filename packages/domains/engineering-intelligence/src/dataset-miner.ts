import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import { segmentTurns } from "./run-scorer";

/**
 * L2's dataset miner: turn a workspace's own session journal into an
 * evaluation dataset — (task, response) pairs a later optimization round
 * can score candidates against.
 *
 * Three disciplines, all of them load-bearing:
 *
 * 1. **Secret filtering happens at the ENTRY, not at the consumer.** Mining
 *    our own history is the richest data source we have and the easiest way
 *    to leak: a key pasted into a chat, a token in a stack trace, a password
 *    in a config dump. A pair whose task OR response matches is DROPPED and
 *    counted — never redacted-and-kept, because a dataset full of
 *    `[REDACTED]` teaches whatever reads it to expect redactions.
 * 2. **The read is a pure fold over events.** No I/O, no daemon, no live
 *    session cache: the caller hands over a journal (the same replay the
 *    run scorer reads), so the miner cannot touch a running session and
 *    cannot be surprised by one.
 * 3. **Everything is bounded.** Task text is capped, response text is
 *    capped, and the counts of what was dropped ride the answer — a miner
 *    that silently discards half the journal is a miner nobody can trust.
 */

/**
 * The entry filter. One combined pattern per family so a match names the
 * family; `redactSecrets` and `looksSecret` read the same table, so a test
 * proves both halves at once.
 *
 * The false-positive side matters as much as the detection side: prose that
 * mentions "key", a short assignment value, code that discusses tokens —
 * none of those are secrets, and a filter that drops them throws away the
 * ordinary conversations that make the dataset worth mining.
 */
const SECRET_FAMILIES: Array<{ name: string; pattern: RegExp }> = [
  // Vendor key formats (prefix + length is what makes them recognizable).
  { name: "anthropic_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/gu },
  { name: "openrouter_key", pattern: /\bsk-or-v1-[A-Za-z0-9_-]{8,}/gu },
  { name: "openai_style_key", pattern: /\bsk-[A-Za-z0-9]{20,}/gu },
  { name: "github_pat", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/gu },
  {
    name: "github_fine_grained_pat",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/gu,
  },
  { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/gu },
  { name: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu },
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{20,}/gu },
  // Bearer tokens and PEM blocks: the shapes that survive a copy-paste.
  { name: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gu },
  {
    name: "private_key_block",
    pattern:
      /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE\s+KEY-----/gu,
  },
  // Assignment shapes: a long value after a secret-ish name is the leak;
  // a short one is usually a placeholder or prose (see the false-positive
  // tests — `password: ok` must survive). No leading word boundary on the
  // name: `my_secret = …` is exactly as leaky as `secret = …`, and a `\b`
  // there misses every prefixed variable name.
  {
    name: "assigned_secret",
    pattern:
      /(?:api[_-]?key|apikey|secret|token|password|passwd|credential)s?\s*[:=]\s*["']?[^\s"']{12,}/giu,
  },
];

/** The families' names, for a report that says WHAT was filtered. */
export const SECRET_FAMILY_NAMES = SECRET_FAMILIES.map(
  (family) => family.name,
) as readonly string[];

export type SecretMatch = { family: string; at: number };

/**
 * Every secret-shaped span in the text, with its family and offset. Pure:
 * the miner, the CLI and the tests all read this one answer.
 */
export function findSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const family of SECRET_FAMILIES) {
    // A fresh regex per call: the shared instances carry /g state, and a
    // lastIndex left behind by one caller would make the next caller's
    // scan start mid-text.
    const pattern = new RegExp(family.pattern.source, family.pattern.flags);
    for (const match of text.matchAll(pattern))
      matches.push({ family: family.name, at: match.index ?? 0 });
  }
  return matches.sort((left, right) => left.at - right.at);
}

/** Whether the text carries anything secret-shaped (the entry's question). */
export function looksSecret(text: string): boolean {
  return findSecrets(text).length > 0;
}

/** Replace every secret-shaped span with a fixed marker (for a report). */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const family of SECRET_FAMILIES) {
    const pattern = new RegExp(family.pattern.source, family.pattern.flags);
    redacted = redacted.replace(pattern, `[${family.name}]`);
  }
  return redacted;
}

/** Bounds: a task is a question, a response is an answer. Neither is a log. */
export const DATASET_TASK_LIMIT = 2_000;
export const DATASET_RESPONSE_LIMIT = 4_000;

export type DatasetPair = {
  sessionID: string;
  turnID: string;
  /** The user's text for this turn (bounded). */
  task: string;
  /** The assistant's confirmed text for this turn (bounded). */
  response: string;
  /**
   * The human's rating on THIS answer, as `up`/`down` with their note —
   * the direction signal the mutator reads. Absent when nobody rated it
   * (the common case); a retracted rating leaves it absent too.
   */
  feedback?: string;
};

export type DatasetDropCounts = {
  /** Pairs dropped because a side matched the secret filter. */
  secrets: number;
  /** Turns with no assistant text (an errored or tool-only turn). */
  empty: number;
  /**
   * Turns with no visible admission: runtime choreography (an internal
   * wake, a goal round) or a window the journal paged in without its
   * prompt. Not a task anybody asked for.
   */
  internal: number;
};

export type MinedDataset = {
  pairs: DatasetPair[];
  dropped: DatasetDropCounts;
  /** Sessions the fold actually read (a bounded read, reported). */
  sessions: number;
};

/**
 * Mine one session's journal into pairs. Pure over the event list: the
 * caller owns the read, the miner owns the fold.
 */
/** One human rating as the reflection dataset reads it. */
export type FeedbackIndexEntry = {
  verdict: "up" | "down";
  note?: string;
};

/**
 * The session's human feedback, folded from its own events.
 *
 * A `feedback.recorded` event indexes its message; a `feedback.retracted`
 * event removes the record it names (the journal is append-only, so the
 * withdrawal is its own fact and the index follows it). The result is what
 * a pair's `feedback` field carries: the human's own words about that
 * answer — the direction signal the mutator reads, which until now was
 * collected, journaled, projected, and then read by nobody.
 */
export function foldFeedbackIndex(
  events: readonly RuntimeEvent[],
): Map<string, FeedbackIndexEntry> {
  const byMessage = new Map<string, FeedbackIndexEntry>();
  const recordToMessage = new Map<string, string>();
  for (const event of events) {
    if (event.type === "feedback.recorded") {
      const messageID = (event as { messageID?: string }).messageID;
      if (!messageID) continue;
      const verdict = (event as { verdict?: "up" | "down" }).verdict;
      if (verdict !== "up" && verdict !== "down") continue;
      const note = (event as { note?: string }).note;
      byMessage.set(messageID, {
        verdict,
        ...(note ? { note } : {}),
      });
      recordToMessage.set((event as { id?: string }).id ?? "", messageID);
      continue;
    }
    if (event.type === "feedback.retracted") {
      const messageID = recordToMessage.get(
        (event as { recordID?: string }).recordID ?? "",
      );
      if (messageID) byMessage.delete(messageID);
    }
  }
  return byMessage;
}

/**
 * The feedback that belongs to one turn: the rating on the turn's own
 * assistant message. Message ids are `<turnID>:assistant` (the transcript's
 * convention), so the match is the turn's own block — never another
 * turn's, and never the session's latest.
 */
function feedbackForTurn(
  index: ReadonlyMap<string, FeedbackIndexEntry>,
  turnID: string,
): string | undefined {
  for (const [messageID, entry] of index) {
    if (messageID !== turnID && !messageID.startsWith(`${turnID}:`)) continue;
    return entry.note ? `${entry.verdict}: ${entry.note}` : entry.verdict;
  }
  return undefined;
}

export function mineSessionPairs(
  sessionID: string,
  events: readonly RuntimeEvent[],
): { pairs: DatasetPair[]; dropped: DatasetDropCounts } {
  const pairs: DatasetPair[] = [];
  const dropped: DatasetDropCounts = { secrets: 0, empty: 0, internal: 0 };
  const feedback = foldFeedbackIndex(events);
  for (const window of segmentTurns(events)) {
    const submitted = window.submitted;
    if (!submitted) {
      // No visible admission: runtime choreography (an internal wake, a
      // goal round's own turn) or a window the journal paged in without
      // its prompt. Either way there is no task to learn from, and the
      // count says so rather than the miner inventing one.
      dropped.internal += 1;
      continue;
    }
    if (submitted.internal === true) {
      // A runtime-generated wake boundary: never human-authored input, so
      // never a task.
      dropped.internal += 1;
      continue;
    }
    const task = submitted.text.trim().slice(0, DATASET_TASK_LIMIT);
    const response = assistantText(window.events)
      .trim()
      .slice(0, DATASET_RESPONSE_LIMIT);
    if (!response) {
      // An errored, cancelled or tool-only turn has no answer to learn from.
      dropped.empty += 1;
      continue;
    }
    // The entry filter, on BOTH sides, before anything is kept.
    if (looksSecret(task) || looksSecret(response)) {
      dropped.secrets += 1;
      continue;
    }
    pairs.push({
      sessionID,
      turnID: window.turnID,
      task,
      response,
      // The human's judgment on THIS answer, when they gave one: the
      // reflection dataset's Feedback field finally has a source.
      ...(feedbackForTurn(feedback, window.turnID)
        ? { feedback: feedbackForTurn(feedback, window.turnID) }
        : {}),
    });
  }
  return { pairs, dropped };
}

/** The assistant's confirmed text inside one turn window. */
function assistantText(events: readonly RuntimeEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "content.delta") text += event.text;
    // `content.done` carries the confirmed whole when a stream produced none
    // (a replayed or non-streamed turn) — take it rather than mine nothing.
    else if (event.type === "content.done" && !text) text = event.text ?? "";
  }
  return text;
}

/**
 * The deterministic split: train 50 / val 25 / holdout 25, keyed by a stable
 * hash of the pair's identity so re-mining the same journal produces the
 * SAME assignment. A split that churns between runs makes the holdout leak
 * into the training set over time — the one thing the holdout exists to
 * prevent.
 */
export type DatasetSplit = "train" | "val" | "holdout";

export function splitForPair(pair: DatasetPair): DatasetSplit {
  let hash = 0;
  for (const character of `${pair.sessionID}:${pair.turnID}`) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  const bucket = Math.abs(hash) % 4;
  if (bucket === 3) return "holdout";
  if (bucket === 2) return "val";
  return "train";
}

/** Group mined pairs into the three splits, each keeping journal order. */
export function splitDataset(pairs: readonly DatasetPair[]): {
  train: DatasetPair[];
  val: DatasetPair[];
  holdout: DatasetPair[];
} {
  const grouped: Record<DatasetSplit, DatasetPair[]> = {
    train: [],
    val: [],
    holdout: [],
  };
  for (const pair of pairs) grouped[splitForPair(pair)].push(pair);
  return grouped;
}

/** One JSONL document per split (a line per pair, stable field order). */
export function datasetSplitLines(pairs: readonly DatasetPair[]): string {
  return pairs
    .map((pair) =>
      JSON.stringify({
        sessionID: pair.sessionID,
        turnID: pair.turnID,
        task: pair.task,
        response: pair.response,
        ...(pair.feedback ? { feedback: pair.feedback } : {}),
      }),
    )
    .join("\n")
    .concat(pairs.length ? "\n" : "");
}

/**
 * Where a target's dataset lives: the workspace's own evolution directory,
 * one subdirectory per target, one file per split. The workspace owns its
 * datasets exactly as it owns its skills — a dataset is project state, not
 * a global cache.
 */
export function datasetDir(workspaceRoot: string, target: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(target))
    throw new Error(`invalid dataset target: ${target}`);
  return join(
    resolve(workspaceRoot),
    ".natalia",
    "evolution",
    "datasets",
    target,
  );
}

/**
 * Write the three splits as JSONL, atomically per file (a half-written
 * dataset is a corrupt evaluation set — the same discipline the skills
 * disabled-set write uses). A split with no pairs still writes its file:
 * an empty holdout is a fact the next reader must see, not a missing file
 * it has to interpret.
 */
export async function writeDataset(input: {
  workspaceRoot: string;
  target: string;
  pairs: readonly DatasetPair[];
}): Promise<{ dir: string; train: number; val: number; holdout: number }> {
  const dir = datasetDir(input.workspaceRoot, input.target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const grouped = splitDataset(input.pairs);
  const counts = { train: 0, val: 0, holdout: 0 };
  for (const split of ["train", "val", "holdout"] as const) {
    const path = join(dir, `${split}.jsonl`);
    const body = datasetSplitLines(grouped[split]);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, path);
    counts[split] = grouped[split].length;
  }
  return { dir, ...counts };
}

/** The dataset files a target has on disk (for a report or a re-read). */
export function datasetFiles(
  workspaceRoot: string,
  target: string,
): Array<{ split: DatasetSplit; path: string }> {
  const dir = datasetDir(workspaceRoot, target);
  return (["train", "val", "holdout"] as const).map((split) => ({
    split,
    path: join(dir, `${split}.jsonl`),
  }));
}

/** Read one split back (the round-trip a consumer test proves). */
export async function readDatasetSplit(
  workspaceRoot: string,
  target: string,
  split: DatasetSplit,
): Promise<DatasetPair[]> {
  const path = join(datasetDir(workspaceRoot, target), `${split}.jsonl`);
  const body = await readFile(path, "utf8");
  return body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DatasetPair);
}

/**
 * Read a target's dataset back: the three splits, plus the visible pool
 * (train + val) an evaluation face may be built over. The holdout is
 * returned separately and SEALED — a caller that builds an evaluation face
 * hands it to the constructor, never to the pool.
 *
 * A missing dataset answers undefined rather than an empty one: "you never
 * mined this" and "you mined nothing" are different facts, and the CLI
 * says the first one out loud.
 */
export async function readDataset(
  workspaceRoot: string,
  target: string,
): Promise<
  | {
      dir: string;
      train: DatasetPair[];
      val: DatasetPair[];
      holdout: DatasetPair[];
      visible: DatasetPair[];
    }
  | undefined
> {
  const dir = datasetDir(workspaceRoot, target);
  const trainPath = join(dir, "train.jsonl");
  if (!(await readFile(trainPath, "utf8").catch(() => undefined)))
    return undefined;
  const [train, val, holdout] = await Promise.all([
    readSplit(trainPath),
    readSplit(join(dir, "val.jsonl")),
    readSplit(join(dir, "holdout.jsonl")),
  ]);
  return { dir, train, val, holdout, visible: [...train, ...val] };
}

async function readSplit(path: string): Promise<DatasetPair[]> {
  const body = await readFile(path, "utf8").catch(() => "");
  return body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DatasetPair);
}
