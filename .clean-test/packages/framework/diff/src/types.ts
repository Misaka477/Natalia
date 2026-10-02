import type { RuntimeStructuredDiff } from "@anthelia/contracts";
import type { StructuredDiffResult } from "@anthelia/diff-wasm";

export type DiffItem = {
  id: string;
  path: string;
  operation: "added" | "modified" | "deleted" | "renamed";
  additions?: number;
  deletions?: number;
  patch?: string;
  before?: string;
  after?: string;
  oldPath?: string;
  structured?: RuntimeStructuredDiff;
};

export type DiffRow = {
  type: string;
  sign: string;
  text: string;
  oldNo?: number | string;
  newNo?: number | string;
  highlights?: Array<{ start: number; end: number; kind: "added" | "deleted" }>;
  syntax?: Array<{ text: string; cls: string }>;
};

export type SplitRow = {
  type: "context" | "add" | "delete" | "modify" | "empty";
  oldText: string;
  newText: string;
  oldNo?: number | string;
  newNo?: number | string;
  oldHighlights?: Array<{ start: number; end: number }>;
  newHighlights?: Array<{ start: number; end: number }>;
  oldSyntax?: Array<{ text: string; cls: string }>;
  newSyntax?: Array<{ text: string; cls: string }>;
};

export type StructuredDiffResultLike = StructuredDiffResult;
