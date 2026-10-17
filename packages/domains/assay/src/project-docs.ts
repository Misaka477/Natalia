/**
 * Project document loading — runtime/project-docs.ts.
 *
 * The 文档 authoring face (EI §3.8 P-1.d): the user's project instructions
 * (`AGENTS.md`) and constitution (`.natalia/constitution.md`) are the highest
 * user-tier input the agent sees. They are loaded and injected as a
 * `<runtime_context source="project" authority="user">` block — never in the
 * static system prompt, because they are workspace state (ADR D1/D2).
 *
 * Two rules from the ADR:
 *
 * 1. **Nearest-wins override**: an `.natalia/` constitution overrides the
 *    workspace-root one for the subtree it applies to; the load is anchored at
 *    the workspace root with a hash so a document edit is detected.
 * 2. **Hash-based change detection**: the injected block carries the loaded
 *    content's hash; when a document changes, the runtime context is
 *    re-derived and re-appended (append on change, never mutate — D3).
 */
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  LoadedProjectDocument,
  ProjectDocumentSnapshot,
} from "@anthelia/runtime-services";
import {
  parseConstitutionDocument,
  type ConstitutionDocRule,
} from "./constitution-doc";

export type { LoadedProjectDocument, ProjectDocumentSnapshot };

/** The parsed constitution/AGENTS rules across a snapshot's documents. */
export function projectDocumentRules(
  snapshot: ProjectDocumentSnapshot,
): ConstitutionDocRule[] {
  return snapshot.documents.flatMap((document) =>
    parseConstitutionDocument(document.content, document.source),
  );
}

function hashContent(content: string): string {
  return createHash("sha256")
    .update(content, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function readOptionalSync(
  path: string,
): { content: string; hash: string } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const content = readFileSync(path, "utf8");
    return { content, hash: hashContent(content) };
  } catch {
    return undefined;
  }
}

/**
 * A per-root memoized snapshot (EI §8.5 就近覆盖/hash 变更): the documents
 * are re-read when the aggregate hash changes, so a document edit is picked
 * up without a restart and an unchanged workspace pays no per-turn read.
 */
const syncCache = new Map<
  string,
  { hash: string; snapshot: ProjectDocumentSnapshot | undefined }
>();

/** Reads a document if present; a missing or unreadable document is not an error. */
async function readOptional(
  path: string,
): Promise<{ content: string; hash: string } | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const content = await readFile(path, "utf8");
    return { content, hash: hashContent(content) };
  } catch {
    return undefined;
  }
}

/** Attaches the parsed constitution/AGENTS rules to a loaded document. */
function withRules(document: {
  source: "constitution" | "agents";
  path: string;
  content: string;
  hash: string;
}): LoadedProjectDocument {
  return {
    ...document,
    rules: parseConstitutionDocument(document.content, document.source),
  };
}

/**
 * Loads the project documents for a workspace root (EI §8.5): the workspace
 * `AGENTS.md` and the `.natalia/constitution.md`. A `.natalia/constitution.md`
 * nearest to the root overrides; the constitution is the runtime-executable
 * tier of the same vocabulary as the seeded rules.
 */
export async function loadProjectDocuments(
  workspaceRoot: string,
): Promise<ProjectDocumentSnapshot> {
  const documents: LoadedProjectDocument[] = [];
  const constitution = await readOptional(
    join(workspaceRoot, ".natalia", "constitution.md"),
  );
  if (constitution)
    documents.push(
      withRules({
        source: "constitution",
        path: ".natalia/constitution.md",
        ...constitution,
      }),
    );
  const agents = await readOptional(join(workspaceRoot, "AGENTS.md"));
  if (agents)
    documents.push(
      withRules({ source: "agents", path: "AGENTS.md", ...agents }),
    );
  return {
    documents,
    hash: documents
      .map((document) => `${document.source}:${document.hash}`)
      .join("|"),
  };
}

/**
 * The synchronous variant used by the provider runner's per-turn context
 * assembly (EI §8.5): memoized by root + aggregate hash so the per-turn read
 * is a stat, and a document edit is detected by hash rather than by polling.
 */
export function loadProjectDocumentsSync(
  workspaceRoot: string,
): ProjectDocumentSnapshot | undefined {
  const cached = syncCache.get(workspaceRoot);
  const constitution = readOptionalSync(
    join(workspaceRoot, ".natalia", "constitution.md"),
  );
  const agents = readOptionalSync(join(workspaceRoot, "AGENTS.md"));
  const hash = [
    constitution ? `constitution:${constitution.hash}` : "",
    agents ? `agents:${agents.hash}` : "",
  ]
    .filter(Boolean)
    .join("|");
  if (cached && cached.hash === hash) return cached.snapshot;
  const documents: LoadedProjectDocument[] = [];
  if (constitution)
    documents.push(
      withRules({
        source: "constitution",
        path: ".natalia/constitution.md",
        ...constitution,
      }),
    );
  if (agents)
    documents.push(
      withRules({ source: "agents", path: "AGENTS.md", ...agents }),
    );
  const snapshot: ProjectDocumentSnapshot | undefined = documents.length
    ? { documents, hash }
    : undefined;
  syncCache.set(workspaceRoot, { hash, snapshot });
  return snapshot;
}

/**
 * Renders the project documents as a `<runtime_context source="project">`
 * block (ADR D2): user-tier authority, injected before the turn's request.
 * The block carries the aggregate hash so a document edit changes the block
 * and the runtime re-appends on change (D5/D6).
 *
 * EI §3.8 P-1.c: each document is also parsed into its rules, and the block
 * states each rule's enforcement explicitly — a prose section is a warn-level
 * soft rule, an `<!-- enforcement -->`-annotated section is a hard rule with
 * its `appliesTo` anchor. The raw content stays for grounding; the structured
 * `<constitution_rules>` list is what makes enforcement machine-visible.
 */
export function renderProjectDocumentsBlock(
  snapshot: ProjectDocumentSnapshot,
): string | undefined {
  if (!snapshot.documents.length) return undefined;
  const body = snapshot.documents
    .map((document) => {
      const tag =
        document.source === "constitution" ? "constitution" : "agents";
      const ruleLines = document.rules
        .map((rule) => {
          const anchor = rule.appliesTo
            ? ` (appliesTo: ${JSON.stringify(rule.appliesTo)})`
            : "";
          const oneLine = rule.statement.replace(/\s+/gu, " ").trim();
          return `[${rule.enforcement}] ${oneLine}${anchor}`;
        })
        .join("\n");
      const rulesBlock = ruleLines
        ? `\n<constitution_rules>\n${ruleLines}\n</constitution_rules>`
        : "";
      return (
        `<${tag} source="${document.path}">\n${document.content}\n</${tag}>` +
        rulesBlock
      );
    })
    .join("\n\n");
  return `<runtime_context source="project" authority="user" trust="runtime" revision="1" hash="${snapshot.hash}">\n${body}\n</runtime_context>`;
}
