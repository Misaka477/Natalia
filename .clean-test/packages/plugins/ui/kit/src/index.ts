export { ContextMenu, contextMenuStyles } from "./context-menu";
export type { ContextMenuItem, ContextMenuProps } from "./context-menu";
export {
  Transcript,
  MessageRow,
  estimateMessageHeight,
  fixedRowHeight,
} from "./transcript";
export type { TranscriptHandle, TranscriptProps } from "./transcript";
export { ContextMeter } from "./context-meter";
export type { ContextUsageView } from "./context-meter";
export {
  dedupeVirtualItems,
  duplicateValues,
  duplicateVirtualIndexes,
} from "./virtual-items";
export { TailScrollController } from "./scroll-controller";
export { PagedTranscriptController } from "./paged-transcript";
export type {
  PagedTranscriptCursor,
  PagedTranscriptOptions,
  PagedTranscriptPage,
  PagedTranscriptPageDirection,
  PagedTranscriptSource,
  PagedTranscriptState,
} from "./paged-transcript";
export type {
  OlderScrollAnchor,
  TailScrollAlignment,
  TailScrollControllerOptions,
} from "./scroll-controller";
export type { Attachment, Message, MessageAction, ToolCall } from "./message";

export { applyUiSkin, defineUiLayoutProfile, defineUiSkin } from "./skin";
export type {
  UiLayoutProfile,
  UiRegionId,
  UiRegionLayout,
  UiSkin,
} from "./skin";

export { defineUiShellLayoutPlugin } from "./skin";
export type {
  UiShellLayoutContext,
  UiShellLayoutPlugin,
  UiShellSlotId,
  UiShellSlots,
} from "./skin";

export { cssVar } from "./css-vars";
export {
  PendingBadge,
  PendingDetail,
  PendingList,
  PendingPanel,
} from "./pending";
export {
  ensurePendingBadgeStyles,
  PENDING_BADGE_STYLES,
} from "./pending-styles";
export { renderMarkdownHtml } from "./markdown";
export {
  evaluateTailScroll,
  initialTailScrollState,
} from "./tail-scroll-machine";
export type {
  TailScrollAnchor,
  TailScrollEffect,
  TailScrollInput,
  TailScrollState,
} from "./tail-scroll-machine";
