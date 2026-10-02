export { buildSplitRows, SplitDiffView } from "./components/SplitDiffView";
export { UnifiedDiffView } from "./components/UnifiedDiffView";
export {
  computeDiffInWorker,
  computeDiffInWorkerStream,
} from "./components/diff-client";
export {
  createWebWorkerPool,
  defaultWorkerPoolSize,
} from "./components/worker-pool";
export {
  highlightInWorker,
  highlightInWorkerBatch,
} from "./components/syntax-client";
export type { SyntaxPart } from "./components/syntax";
export { diffLines, languageFromPath, structuredRows } from "./diff-utils";
export type { DiffItem, DiffRow, SplitRow } from "./types";
