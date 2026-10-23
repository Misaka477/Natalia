import { createSignal, onCleanup } from "solid-js";

export const zh = {
  "files.explorer": "资源管理器",
  "files.edit": "编辑",
  "files.preview": "预览",
  "files.closeFile": "关闭文件",
  "files.loadingMedia": "读取中…",
  "files.listErrorTitle": "工作区列表读取失败",
  "files.listErrorDefault": "无法读取工作区文件列表",
  "files.retry": "重试",
  "files.newFile": "新建文件",
  "files.newFolder": "新建文件夹",
  "files.pasteMove": "粘贴（移动）",
  "files.pasteCopy": "粘贴（复制）",
  "files.copy": "复制",
  "files.cut": "剪切",
  "files.copyRelPath": "复制相对路径",
  "files.copyAbsPath": "复制绝对路径",
  "files.rename": "重命名",
  "files.delete": "删除",
  "files.cancel": "取消",
  "files.ok": "确定",
  "files.saveUnsupported": "当前 runtime 不支持文件保存",
  "files.saved": "已保存",
  "files.saveFailed": "保存失败：{error}",
  "files.mediaReadFailed": "读不到媒体文件：{path}",
  "files.opFailed": "操作失败：{error}",
  "files.confirmDelete": "确定删除 {path}？文件将移入系统回收站。",
  "files.deleteUnconfirmed": "删除失败：未收到删除确认",
  "files.movedToTrash": "已移入回收站：{path}",
  "files.deleteFailed": "删除失败：{error}",
  "files.clipboardDenied": "剪贴板写入被拒绝，请手动复制：{text}",
  "files.sameTarget": "目标与源相同，未做任何事",
  "files.moved": "已移动：{from} → {to}",
  "files.copyReadFailed": "复制失败：读不到源文件",
  "files.copiedTo": "已复制到：{to}",
  "files.pasteFailed": "粘贴失败：{error}",
  "files.copied": "已复制：{path}",
  "files.cutDone": "已剪切：{path}",
  "files.copiedRel": "已复制相对路径：{path}",
  "files.copiedAbs": "已复制绝对路径：{path}",
} satisfies Record<string, string>;

export type FileEditorLocaleKey = keyof typeof zh;

export const en: Record<FileEditorLocaleKey, string> = {
  "files.explorer": "Explorer",
  "files.edit": "Edit",
  "files.preview": "Preview",
  "files.closeFile": "Close file",
  "files.loadingMedia": "Loading…",
  "files.listErrorTitle": "Failed to load workspace files",
  "files.listErrorDefault": "Unable to read workspace file list",
  "files.retry": "Retry",
  "files.newFile": "New file",
  "files.newFolder": "New folder",
  "files.pasteMove": "Paste (move)",
  "files.pasteCopy": "Paste (copy)",
  "files.copy": "Copy",
  "files.cut": "Cut",
  "files.copyRelPath": "Copy relative path",
  "files.copyAbsPath": "Copy absolute path",
  "files.rename": "Rename",
  "files.delete": "Delete",
  "files.cancel": "Cancel",
  "files.ok": "OK",
  "files.saveUnsupported": "This runtime does not support saving files",
  "files.saved": "Saved",
  "files.saveFailed": "Save failed: {error}",
  "files.mediaReadFailed": "Unable to read media file: {path}",
  "files.opFailed": "Operation failed: {error}",
  "files.confirmDelete":
    "Delete {path}? The file will be moved to the system trash.",
  "files.deleteUnconfirmed": "Delete failed: no confirmation received",
  "files.movedToTrash": "Moved to trash: {path}",
  "files.deleteFailed": "Delete failed: {error}",
  "files.clipboardDenied": "Clipboard write denied; copy manually: {text}",
  "files.sameTarget": "Target and source are identical; nothing changed",
  "files.moved": "Moved: {from} → {to}",
  "files.copyReadFailed": "Copy failed: unable to read source file",
  "files.copiedTo": "Copied to: {to}",
  "files.pasteFailed": "Paste failed: {error}",
  "files.copied": "Copied: {path}",
  "files.cutDone": "Cut: {path}",
  "files.copiedRel": "Copied relative path: {path}",
  "files.copiedAbs": "Copied absolute path: {path}",
};

export const FILE_EDITOR_LOCALES: Record<string, Record<string, string>> = {
  "zh-CN": zh,
  en,
};

interface HostLocaleLike {
  getLocale?: () => { active: string };
  subscribe?: (listener: () => void) => () => void;
  ensureRegistered?: (
    ns: string,
    dicts: Record<string, Record<string, string>>,
  ) => void;
  register?: (
    ns: string,
    dicts: Record<string, Record<string, string>>,
  ) => () => void;
  bind?: (
    ns: string,
  ) => (key: string, params?: Record<string, unknown>) => string;
}

export function bindFileEditorLocale(extra?: unknown) {
  const hostLocale = (extra as { locale?: HostLocaleLike } | undefined)?.locale;
  if (hostLocale?.ensureRegistered) {
    hostLocale.ensureRegistered("file-editor", FILE_EDITOR_LOCALES);
  } else if (hostLocale?.register) {
    try {
      hostLocale.register("file-editor", FILE_EDITOR_LOCALES);
    } catch {
      // already registered
    }
  }
  const [tick, setTick] = createSignal(0);
  if (hostLocale?.subscribe) {
    const off = hostLocale.subscribe(() => setTick((n) => n + 1));
    onCleanup(off);
  }
  if (typeof window !== "undefined") {
    const onEvent = () => setTick((n) => n + 1);
    window.addEventListener("natalia:locale-change", onEvent);
    onCleanup(() =>
      window.removeEventListener("natalia:locale-change", onEvent),
    );
  }
  const bound = hostLocale?.bind?.("file-editor");
  return (
    key: FileEditorLocaleKey,
    params?: Record<string, unknown>,
  ): string => {
    tick();
    if (bound) return bound(key, params);
    const active =
      hostLocale?.getLocale?.().active ??
      (typeof document !== "undefined" && document.documentElement.lang === "en"
        ? "en"
        : "zh-CN");
    const dict = FILE_EDITOR_LOCALES[active] ?? zh;
    const template = dict[key] ?? zh[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/gu, (m, name: string) =>
      name in params ? String(params[name]) : m,
    );
  };
}
