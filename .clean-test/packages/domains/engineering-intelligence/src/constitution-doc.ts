/**
 * Constitution / AGENTS document parser — runtime/constitution-doc.ts.
 *
 * The 文档 authoring face (EI §3.8 P-1.c / §8.3): the workspace `AGENTS.md`
 * and `.natalia/constitution.md` are the highest user-tier input, and they are
 * also the seed of the executable constitution. A section is either:
 *
 * - **prose (soft)** — no annotation. It is a warn-level runtime-context rule:
 *   the model is told to respect it, but nothing intercepts a tool call for it.
 * - **annotated (hard)** — carries `<!-- enforcement: deny|approval|warn -->`
 *   and optionally `<!-- appliesTo: { tools: [], paths: [], commandPattern } -->`.
 *   It can be promoted to a journal `constitution.rule_added` (a user action,
 *   no gate) and then executed by the runtime matcher.
 *
 * The parser is a pure function of the document text so it can be unit-tested
 * and re-run on every document edit (hash change) without a restart. It never
 * writes: promotion is a separate, user-initiated step.
 */

import type {
  ConstitutionDocAppliesTo,
  ConstitutionDocEnforcement,
  ConstitutionDocRule,
} from "@anthelia/runtime-services";

export type {
  ConstitutionDocAppliesTo,
  ConstitutionDocEnforcement,
  ConstitutionDocRule,
};

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/u;
const ENFORCEMENT_ANNOTATION =
  /<!--\s*enforcement\s*:\s*(deny|approval|warn)\s*-->/iu;
const APPLIESTO_ANNOTATION = /<!--\s*appliesTo\s*:\s*(\{[\s\S]*?\})\s*-->/iu;
const ANY_HTML_COMMENT = /<!--[\s\S]*?-->/gu;

/** A stable, filesystem-ish slug for a section heading. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return slug || "section";
}

/** Parses a bracket list body (`"a", "b"`) into trimmed, unquoted entries. */
function parseListBody(body: string): string[] {
  return body
    .split(",")
    .map((entry) =>
      entry
        .trim()
        .replace(/^["']|["']$/gu, "")
        .trim(),
    )
    .filter((entry) => entry.length > 0);
}

/**
 * Lenient parse of an `appliesTo` annotation body. The plan's form
 * (`{ tools: [], paths: [], commandPattern: "" }`) is not valid JSON (unquoted
 * keys), so try JSON first and fall back to field extraction. Only non-empty
 * anchors are kept so an empty `{}` reads as "no structured anchor".
 */
function parseAppliesTo(raw: string): ConstitutionDocAppliesTo | undefined {
  const body = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const anchor: ConstitutionDocAppliesTo = {};
  const readList = (value: unknown): string[] | undefined =>
    Array.isArray(value)
      ? value
          .map((entry) => String(entry).trim())
          .filter((entry) => entry.length > 0)
      : undefined;
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const tools = readList(record.tools);
    const paths = readList(record.paths);
    const commandPattern =
      typeof record.commandPattern === "string" && record.commandPattern.trim()
        ? record.commandPattern.trim()
        : undefined;
    if (tools?.length) anchor.tools = tools;
    if (paths?.length) anchor.paths = paths;
    if (commandPattern) anchor.commandPattern = commandPattern;
  } else {
    const tools = body.match(/tools\s*:\s*\[([^\]]*)\]/iu);
    const paths = body.match(/paths\s*:\s*\[([^\]]*)\]/iu);
    const commandPattern = body.match(
      /commandPattern\s*:\s*["']([^"']*)["']/iu,
    );
    const toolList = tools ? parseListBody(tools[1]!) : [];
    const pathList = paths ? parseListBody(paths[1]!) : [];
    if (toolList.length) anchor.tools = toolList;
    if (pathList.length) anchor.paths = pathList;
    if (commandPattern?.[1]?.trim())
      anchor.commandPattern = commandPattern[1].trim();
  }
  return anchor.tools?.length || anchor.paths?.length || anchor.commandPattern
    ? anchor
    : undefined;
}

/**
 * Parses a constitution / AGENTS markdown document into its rules (EI §3.8
 * P-1.c). Sections are delimited by ATX headings; a section's prose is its
 * statement, its HTML-comment annotations set enforcement / appliesTo. A
 * section with neither prose nor an annotation is skipped.
 */
export function parseConstitutionDocument(
  content: string,
  source: "constitution" | "agents",
): ConstitutionDocRule[] {
  const rules: ConstitutionDocRule[] = [];
  let ordinal = 0;
  for (const section of splitConstitutionSections(content)) {
    const derived = sectionToRule(section, source, ordinal);
    if (derived) {
      ordinal = derived.ordinal;
      rules.push(derived.rule);
    }
  }
  return rules;
}

/** A raw document section: its heading, body lines and line range (EI §3.8). */
export type ConstitutionDocSection = {
  /** The heading text ("" for content before the first heading). */
  heading: string;
  /** The original heading line ("" for content before the first heading). */
  headingLine: string;
  /** Body lines (prose + annotations) between this heading and the next. */
  body: string[];
  /** Inclusive start line (the heading line) in the normalized line array. */
  startLine: number;
  /** Inclusive end line (last line before the next heading) in that array. */
  endLine: number;
};

/**
 * Splits a document into its ATX sections with line ranges (EI §3.8 P-1.c).
 * Line numbers index the CRLF-normalized line array, so an edit can splice a
 * rewritten section back in. Content before the first heading is one section
 * with an empty heading — matching how the parser treats it (a `rule N`).
 */
export function splitConstitutionSections(
  content: string,
): ConstitutionDocSection[] {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const sections: ConstitutionDocSection[] = [];
  let current: ConstitutionDocSection = {
    heading: "",
    headingLine: "",
    body: [],
    startLine: 0,
    endLine: 0,
  };
  const flush = (endLine: number) => {
    sections.push({ ...current, endLine });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const heading = line.match(HEADING);
    if (heading) {
      flush(index - 1);
      current = {
        heading: heading[2]!.trim(),
        headingLine: line,
        body: [],
        startLine: index,
        endLine: index,
      };
      continue;
    }
    current.body.push(line);
  }
  flush(lines.length - 1);
  return sections;
}

/** Derives a section's rule (or nothing, when it has no statement/annotation). */
function sectionToRule(
  section: ConstitutionDocSection,
  source: "constitution" | "agents",
  ordinal: number,
): { rule: ConstitutionDocRule; ordinal: number } | undefined {
  const raw = section.body.join("\n");
  const enforcementMatch = raw.match(ENFORCEMENT_ANNOTATION);
  const appliesToMatch = raw.match(APPLIESTO_ANNOTATION);
  const statement = raw
    .replace(ANY_HTML_COMMENT, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
  if (!statement && !enforcementMatch) return undefined;
  const nextOrdinal = ordinal + 1;
  const enforcement: ConstitutionDocEnforcement =
    (enforcementMatch?.[1]?.toLowerCase() as ConstitutionDocEnforcement) ??
    "warn";
  const appliesTo = appliesToMatch
    ? parseAppliesTo(appliesToMatch[1]!)
    : undefined;
  const heading = section.heading || `rule ${nextOrdinal}`;
  return {
    ordinal: nextOrdinal,
    rule: {
      id: `${source}:${slugify(heading)}:${nextOrdinal}`,
      source,
      section: heading,
      statement: statement || heading,
      enforcement,
      annotated: Boolean(enforcementMatch),
      ...(appliesTo ? { appliesTo } : {}),
    },
  };
}

/** Whether an appliesTo anchor carries at least one executable field. */
function hasAnchor(
  appliesTo: ConstitutionDocAppliesTo | undefined,
): appliesTo is ConstitutionDocAppliesTo {
  return Boolean(
    appliesTo &&
      (appliesTo.tools?.length ||
        appliesTo.paths?.length ||
        appliesTo.commandPattern),
  );
}

/** Serializes an appliesTo anchor back to the documented annotation body. */
function renderAppliesTo(appliesTo: ConstitutionDocAppliesTo): string {
  const parts: string[] = [];
  if (appliesTo.tools?.length)
    parts.push(
      `tools: [${appliesTo.tools.map((t) => JSON.stringify(t)).join(", ")}]`,
    );
  if (appliesTo.paths?.length)
    parts.push(
      `paths: [${appliesTo.paths.map((p) => JSON.stringify(p)).join(", ")}]`,
    );
  if (appliesTo.commandPattern)
    parts.push(`commandPattern: ${JSON.stringify(appliesTo.commandPattern)}`);
  return `{ ${parts.join(", ")} }`;
}

/**
 * The desired state of a document rule after an edit (EI §3.8 P-1.c): the prose
 * statement plus its enforcement tier and structured anchor. A warn rule with
 * no anchor stays prose (no annotation); anything else is written with
 * `<!-- enforcement -->` / `<!-- appliesTo -->` comments so the parser reads it
 * back as a hard rule.
 */
export type ConstitutionDocEdit = {
  statement: string;
  enforcement: ConstitutionDocEnforcement;
  appliesTo?: ConstitutionDocAppliesTo;
};

/**
 * Rewrites one document section in place and returns the new document (EI §3.8
 * P-1.c 软规则编辑): the statement prose is replaced and the enforcement /
 * appliesTo HTML-comment annotations are synced to the requested tier. The
 * section is located by its stable rule id, so other sections (and their ids)
 * are untouched. Pure — the caller writes the returned content to disk.
 *
 * A deny/approval rule must carry a non-empty appliesTo anchor (the same hard
 * invariant the promote path enforces); an unknown id is reported, not thrown.
 */
export function applyConstitutionDocEdit(
  content: string,
  source: "constitution" | "agents",
  ruleId: string,
  next: ConstitutionDocEdit,
): { ok: true; content: string } | { ok: false; reason: string } {
  const anchor = hasAnchor(next.appliesTo);
  if (next.enforcement !== "warn" && !anchor)
    return {
      ok: false,
      reason: "a deny/approval rule requires a non-empty appliesTo anchor",
    };

  const sections = splitConstitutionSections(content);
  let ordinal = 0;
  let target: ConstitutionDocSection | undefined;
  for (const section of sections) {
    const derived = sectionToRule(section, source, ordinal);
    if (!derived) continue;
    ordinal = derived.ordinal;
    if (derived.rule.id === ruleId) {
      target = section;
      break;
    }
  }
  if (!target) return { ok: false, reason: "unknown document rule id" };

  const annotated = next.enforcement !== "warn" || anchor;
  const body: string[] = [];
  const prose = next.statement
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  body.push(...prose);
  if (annotated) {
    if (body.length) body.push("");
    body.push(`<!-- enforcement: ${next.enforcement} -->`);
    if (anchor)
      body.push(`<!-- appliesTo: ${renderAppliesTo(next.appliesTo!)} -->`);
  }
  const headingLine = target.headingLine || `## ${target.heading}`;
  const replacement = headingLine ? [headingLine, "", ...body] : body;

  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const updated = [
    ...lines.slice(0, target.startLine),
    ...replacement,
    ...lines.slice(target.endLine + 1),
  ].join("\n");
  return { ok: true, content: updated };
}
