/**
 * The project-document snapshot contract (EI §8.5 / ADR D2): the workspace
 * `AGENTS.md` and `.natalia/constitution.md` loaded for a session. The runtime
 * face is just the shape; the client loads the files and injects the rendered
 * `<runtime_context source="project">` block. Declared here so the runner and
 * the client share one type without a client dependency in the contract.
 */

/** The enforcement tier a constitution/AGENTS section carries (EI §3.8 P-1.c). */
export type ConstitutionDocEnforcement = "deny" | "approval" | "warn";

/** The structured anchor a hard rule executes against. */
export type ConstitutionDocAppliesTo = {
  tools?: string[];
  paths?: string[];
  commandPattern?: string;
};

/**
 * A rule parsed from a constitution/AGENTS document (EI §3.8 P-1.c): a prose
 * section is a warn-level soft rule; a section annotated with
 * `<!-- enforcement -->` is a hard rule carrying its `appliesTo` anchor and
 * can be promoted to a journal `constitution.rule_added`.
 */
export type ConstitutionDocRule = {
  id: string;
  source: "constitution" | "agents";
  section: string;
  statement: string;
  enforcement: ConstitutionDocEnforcement;
  annotated: boolean;
  appliesTo?: ConstitutionDocAppliesTo;
};

export type LoadedProjectDocument = {
  source: "constitution" | "agents";
  path: string;
  content: string;
  hash: string;
  /** Sections parsed into rules (EI §3.8 P-1.c): prose → warn, annotated → hard. */
  rules: ConstitutionDocRule[];
};

export type ProjectDocumentSnapshot = {
  documents: LoadedProjectDocument[];
  hash: string;
};
