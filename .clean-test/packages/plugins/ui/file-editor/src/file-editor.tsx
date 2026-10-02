import {
  createMemo,
  createSignal,
  For,
  Show,
  onCleanup,
  onMount,
} from "solid-js";
import type { UiProjection, UiTransport } from "@natalia/ui-host";
import type { RuntimeClient } from "@anthelia/contracts";
import {
  ContextMenu,
  cssVar,
  renderMarkdownHtml,
  type ContextMenuItem,
} from "@natalia/ui-kit";
import { Compartment } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { basicSetup } from "codemirror";
import {
  StreamLanguage,
  syntaxHighlighting,
  HighlightStyle,
  foldGutter,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { autocompletion } from "@codemirror/autocomplete";
import { search, highlightSelectionMatches } from "@codemirror/search";
import { lintGutter } from "@codemirror/lint";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import type { Extension } from "@codemirror/state";

type FileNode = {
  name: string;
  path: string;
  type: "dir" | "file";
  status?: "M" | "A" | null;
  children?: FileNode[];
};

type VisibleRow = {
  node: FileNode;
  rowPath: string;
  depth: number;
};

const initialTree: FileNode[] = [];

const initialContents: Record<string, string> = {};

function buildTree(
  entries: Array<{ path: string; type: "file" | "directory" }>,
  nodeMap: Map<string, FileNode>,
): FileNode[] {
  const root: FileNode = { name: ".", path: ".", type: "dir", children: [] };
  const resetDirectories = new Set<FileNode>();
  for (const entry of entries) {
    const parts = entry.path.replace(/^\.\//u, "").split("/").filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      const path = parts.slice(0, index + 1).join("/");
      const isFile = index === parts.length - 1 && entry.type === "file";
      let child = node.children?.find((candidate) => candidate.path === path);
      if (!child) {
        child = getOrCreateNode(nodeMap, path, part, isFile ? "file" : "dir");
        node.children?.push(child);
      }
      child.name = part;
      child.type = isFile ? "file" : "dir";
      if (child.type === "dir") {
        if (!resetDirectories.has(child)) {
          child.children = [];
          resetDirectories.add(child);
        }
      } else {
        child.children = undefined;
      }
      node = child;
    }
  }
  return root.children ?? [];
}

function getOrCreateNode(
  nodeMap: Map<string, FileNode>,
  path: string,
  name: string,
  type: "file" | "dir",
): FileNode {
  const existing = nodeMap.get(path);
  if (existing) {
    existing.name = name;
    existing.type = type;
    return existing;
  }
  const node: FileNode = {
    name,
    path,
    type,
    ...(type === "dir" ? { children: [] } : {}),
  };
  nodeMap.set(path, node);
  return node;
}

function workspaceKey(state?: {
  activeWorkspaceID?: string;
  sessionID?: string;
}) {
  return `${state?.activeWorkspaceID ?? ""}:${state?.sessionID ?? ""}`;
}

const neuLightTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "transparent",
      color: "var(--neu-text)",
    },
    ".cm-content": {
      caretColor: "var(--neu-text)",
      fontFamily: "var(--neu-font-mono)",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--neu-muted)",
      border: "none",
    },
    ".cm-activeLine": {
      backgroundColor: cssVar("--neu-accent-soft", "rgba(143,183,176,0.08)"),
    },
    ".cm-activeLineGutter": {
      backgroundColor: cssVar("--neu-accent-soft", "rgba(143,183,176,0.08)"),
    },
    ".cm-selectionBackground": {
      backgroundColor:
        cssVar("--neu-accent-soft", "rgba(143,183,176,0.22)") + " !important",
    },
    ".cm-cursor": {
      borderLeftColor: "var(--neu-accent)",
    },
  },
  { dark: false },
);

const neuLightHighlight = HighlightStyle.define([
  { tag: tags.comment, color: "var(--neu-muted)", fontStyle: "italic" },
  {
    tag: [tags.keyword, tags.operatorKeyword],
    color: cssVar("--neu-code-keyword", "#b85e9c"),
    fontWeight: "600",
  },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: cssVar("--neu-code-string", "#2e8b57"),
  },
  {
    tag: [tags.number, tags.bool, tags.null],
    color: cssVar("--neu-code-number", "#b06e2c"),
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: cssVar("--neu-code-function", "#2a7ab0"),
  },
  {
    tag: [tags.className, tags.typeName],
    color: cssVar("--neu-code-class", "#7a4bb5"),
  },
  {
    tag: [tags.propertyName, tags.attributeName],
    color: cssVar("--neu-code-function", "#2a7ab0"),
  },
  {
    tag: [tags.definition(tags.variableName), tags.variableName],
    color: "var(--neu-text)",
  },
]);

function languageForPath(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext))
    return javascript({ typescript: ext.includes("ts") });
  if (["json", "jsonc"].includes(ext)) return json();
  if (["html", "htm", "vue", "svelte"].includes(ext)) return html();
  if (["css", "scss", "less"].includes(ext)) return css();
  if (["c", "h", "cpp", "cc", "cxx", "hpp", "hh"].includes(ext)) return cpp();
  if (["rs"].includes(ext)) return rust();
  if (["go"].includes(ext)) return go();
  if (["sql"].includes(ext)) return sql();
  if (["yml", "yaml"].includes(ext)) return yaml();
  if (["md", "markdown"].includes(ext)) return markdown();
  if (["py"].includes(ext)) return python();
  if (["sh", "bash", "zsh"].includes(ext)) return StreamLanguage.define(shell);
  if (["cmake", "txt"].includes(ext) && path.toLowerCase().includes("cmake"))
    return StreamLanguage.define(cmake);
  return [];
}

export function FileEditor(props: {
  transport?: UiTransport;
  runtime?: RuntimeClient;
  projection?: UiProjection;
}) {
  const [contents, setContents] = createSignal<Record<string, string>>({});
  const [selectedPath, setSelectedPath] = createSignal<string>("");
  const [openTabs, setOpenTabs] = createSignal<Array<{ path: string }>>([]);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(["."]));
  const [preview, setPreview] = createSignal(false);
  const [fileWidth, setFileWidth] = createSignal(140);
  const [tree, setTree] = createSignal<FileNode[]>(initialTree);
  const [entries, setEntries] = createSignal<
    Array<{ path: string; type: "file" | "directory" }>
  >([]);
  const nodeMap = new Map<string, FileNode>();
  const rowCache = new Map<string, VisibleRow>();
  let lastWorkspaceKey: string | undefined;

  const visibleRows = createMemo<VisibleRow[]>(() => {
    const rows: VisibleRow[] = [];
    const visit = (nodes: FileNode[], depth: number) => {
      for (const node of nodes) {
        const rowPath = node.type === "dir" ? `${node.path}/` : node.path;
        let row = rowCache.get(rowPath);
        if (!row) {
          row = { node, rowPath, depth };
          rowCache.set(rowPath, row);
        } else {
          row.node = node;
          row.depth = depth;
        }
        rows.push(row);
        if (node.type === "dir" && expanded().has(node.path) && node.children) {
          visit(node.children, depth + 1);
        }
      }
    };
    visit(tree(), 0);
    return rows;
  });
  const [loadedDirs, setLoadedDirs] = createSignal<Set<string>>(new Set());
  const [dialog, setDialog] = createSignal<{
    mode: "new-file" | "new-folder" | "rename";
    path?: string;
  } | null>(null);
  const [dialogValue, setDialogValue] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
    path: string;
  } | null>(null);
  let cmContainer: HTMLDivElement | undefined;
  let cmView: EditorView | undefined;
  let pendingJump: { path: string; line: number } | undefined;
  const languageCompartment = new Compartment();

  function jumpToLine(line: number) {
    if (!cmView) return false;
    const target = Math.min(Math.max(1, line), cmView.state.doc.lines);
    const info = cmView.state.doc.line(target);
    cmView.dispatch({
      selection: { anchor: info.from },
      scrollIntoView: true,
    });
    cmView.focus();
    return true;
  }

  function attachEditor(element: HTMLDivElement) {
    cmContainer = element;
    if (cmView) {
      element.replaceChildren(cmView.dom);
      updateEditor(selectedPath(), selectedContent());
      cmView.requestMeasure();
      if (pendingJump && pendingJump.path === selectedPath()) {
        const line = pendingJump.line;
        pendingJump = undefined;
        jumpToLine(line);
      }
      return;
    }
    cmView = new EditorView({
      doc: selectedContent(),
      extensions: [
        basicSetup,
        lineNumbers(),
        highlightActiveLine(),
        autocompletion(),
        search({ top: true }),
        highlightSelectionMatches(),
        lintGutter(),
        foldGutter(),
        neuLightTheme,
        syntaxHighlighting(neuLightHighlight),
        languageCompartment.of(languageForPath(selectedPath())),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const text = update.state.doc.toString();
            const path = selectedPath();
            if (path) setContents((prev) => ({ ...prev, [path]: text }));
          }
        }),
        EditorView.domEventHandlers({
          blur: () => {
            void saveCurrentFile();
          },
        }),
      ],
      parent: element,
    });
    if (pendingJump && pendingJump.path === selectedPath()) {
      const line = pendingJump.line;
      pendingJump = undefined;
      jumpToLine(line);
    }
  }
  onCleanup(() => {
    cmView?.destroy();
    cmView = undefined;
  });

  function openPathAt(path: string, line?: number) {
    selectFile(path);
    setPreview(false);
    pendingJump = line ? { path, line } : undefined;
    if (line && cmView) {
      pendingJump = undefined;
      jumpToLine(line);
    }
  }

  async function reloadWorkspace() {
    const page = await props.runtime?.workspaceList?.();
    if (!page) return;
    nodeMap.clear();
    rowCache.clear();
    setEntries(page.entries);
    setTree(buildTree(page.entries, nodeMap));
    setExpanded(new Set(["."]));
    setLoadedDirs(new Set<string>());
    setOpenTabs([]);
    setSelectedPath("");
    setContents({});
    setPreview(false);
    if (cmView)
      cmView.dispatch({
        changes: { from: 0, to: cmView.state.doc.length, insert: "" },
      });
    const firstFile = page.entries.find(
      (entry) => entry.type === "file" && !entry.path.endsWith("/"),
    );
    if (firstFile) selectFile(firstFile.path);
  }

  onMount(() => {
    const handleOpenFile = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; line?: number }>)
        .detail;
      if (!detail?.path) return;
      openPathAt(detail.path, detail.line);
    };
    window.addEventListener("natalia:open-file", handleOpenFile);
    onCleanup(() =>
      window.removeEventListener("natalia:open-file", handleOpenFile),
    );
    lastWorkspaceKey = workspaceKey(props.projection?.getState());
    void reloadWorkspace();
    const unsubscribe = props.projection?.subscribe((state) => {
      const key = workspaceKey(state);
      if (key === lastWorkspaceKey) return;
      lastWorkspaceKey = key;
      void reloadWorkspace();
    });
    onCleanup(() => unsubscribe?.());
  });

  async function toggle(path: string) {
    const next = new Set(expanded());
    if (next.has(path)) {
      next.delete(path);
      setExpanded(next);
      return;
    }
    next.add(path);
    setExpanded(next);
    if (!loadedDirs().has(path)) {
      const loaded = new Set(loadedDirs());
      loaded.add(path);
      setLoadedDirs(loaded);
      try {
        const page = await props.runtime?.workspaceList?.({ path });
        if (page?.entries?.length) {
          const merged = new Map(entries().map((entry) => [entry.path, entry]));
          for (const entry of page.entries) merged.set(entry.path, entry);
          const nextEntries = [...merged.values()];
          setEntries(nextEntries);
          setTree(buildTree(nextEntries, nodeMap));
        }
      } catch {
        // Keep the directory expanded even when listing fails; the tree will
        // simply show no children instead of pretending content exists.
      }
    }
  }

  function startFileResize(event: PointerEvent) {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startWidth = fileWidth();
    const move = (next: PointerEvent) =>
      setFileWidth(
        Math.max(120, Math.min(190, startWidth + next.clientX - startX)),
      );
    const finish = (next: PointerEvent) => {
      target.releasePointerCapture?.(next.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  }

  function selectedContent() {
    return contents()[selectedPath()] ?? "";
  }

  function closeTab(path: string) {
    const nextTabs = openTabs().filter((tab) => tab.path !== path);
    setOpenTabs(nextTabs);
    if (selectedPath() === path) {
      if (nextTabs.length) {
        const next = nextTabs[nextTabs.length - 1]!.path;
        selectFile(next);
      } else {
        setSelectedPath("");
        setPreview(false);
        if (cmView) {
          cmView.dispatch({
            changes: {
              from: 0,
              to: cmView.state.doc.length,
              insert: "",
            },
          });
        }
      }
    }
  }

  function selectFile(path: string) {
    if (!openTabs().some((tab) => tab.path === path)) {
      setOpenTabs([...openTabs(), { path }]);
    }
    setSelectedPath(path);
    setPreview(path.endsWith(".md") || path.endsWith(".markdown"));
    if (props.transport) {
      void props.transport.readFile(path).then(
        (bytes) => {
          const text = new TextDecoder().decode(bytes);
          setContents((prev) => ({ ...prev, [path]: text }));
          updateEditor(path, text);
        },
        () => undefined,
      );
    }
    void props.runtime?.workspaceRead?.({ path }).then(
      (result) => {
        if (!result) return;
        const text =
          result.encoding === "base64"
            ? new TextDecoder().decode(
                Uint8Array.from(atob(result.content), (ch) => ch.charCodeAt(0)),
              )
            : result.content;
        setContents((prev) => ({ ...prev, [path]: text }));
        updateEditor(path, text);
      },
      () => undefined,
    );
  }

  function renderMarkdown(markdown: string): string {
    // GFM (tables, nested lists, fenced code) instead of the old regex subset.
    return `<div class="neu-markdown-body">${renderMarkdownHtml(markdown)}</div>`;
  }

  function updateEditor(path: string, text: string) {
    if (!cmView) return;
    cmView.dispatch({
      effects: languageCompartment.reconfigure(languageForPath(path)),
    });
    cmView.dispatch({
      changes: {
        from: 0,
        to: cmView.state.doc.length,
        insert: text,
      },
    });
  }

  async function saveCurrentFile() {
    const path = selectedPath();
    if (!path) return;
    if (!props.runtime?.workspaceWrite) {
      props.runtime?.diagnostic?.("当前 runtime 不支持文件保存", "warning");
      return;
    }
    try {
      await props.runtime.workspaceWrite({
        path,
        content: contents()[path] ?? "",
        encoding: "utf8",
      });
      props.runtime.diagnostic?.("已保存", "info");
    } catch (error) {
      props.runtime.diagnostic?.(
        `保存失败：${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  function sameEntries(
    left: Array<{ path: string; type: "file" | "directory" }>,
    right: Array<{ path: string; type: "file" | "directory" }>,
  ) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (
        left[index]!.path !== right[index]!.path ||
        left[index]!.type !== right[index]!.type
      )
        return false;
    }
    return true;
  }

  async function refreshTree() {
    try {
      const page = await props.runtime?.workspaceList?.();
      if (page) {
        const currentRootEntries = entries().filter(
          (entry) => !entry.path.includes("/"),
        );
        if (!sameEntries(page.entries, currentRootEntries)) {
          setEntries(page.entries);
          setTree(buildTree(page.entries, nodeMap));
        }
      }
      const expandedDirs = [...expanded()];
      for (const directory of expandedDirs) {
        if (directory === ".") continue;
        const childPage = await props.runtime?.workspaceList?.({
          path: directory,
        });
        if (!childPage) continue;
        const merged = new Map(entries().map((entry) => [entry.path, entry]));
        for (const entry of childPage.entries) merged.set(entry.path, entry);
        const nextEntries = [...merged.values()];
        if (!sameEntries(nextEntries, entries())) {
          setEntries(nextEntries);
          setTree(buildTree(nextEntries, nodeMap));
        }
      }
    } catch {
      // A transient listing failure should not break the file editor.
    }
  }

  function currentDirectory(): string {
    const path = selectedPath();
    if (!path) return "";
    if (path.endsWith("/")) return path.replace(/\/$/u, "");
    if (path.includes("/")) return path.split("/").slice(0, -1).join("/");
    return "";
  }

  function normalizeName(value: string) {
    return value.trim().replace(/^\/+|\/+$/gu, "");
  }

  function openNewFile() {
    setDialogValue("");
    setDialog({ mode: "new-file" });
  }

  function openNewFolder() {
    setDialogValue("");
    setDialog({ mode: "new-folder" });
  }

  function openRename(path: string) {
    const name = path.endsWith("/")
      ? (path.slice(0, -1).split("/").at(-1) ?? path)
      : (path.split("/").at(-1) ?? path);
    setDialogValue(name);
    setDialog({ mode: "rename", path });
  }

  async function submitDialog() {
    const current = dialog();
    const value = normalizeName(dialogValue());
    if (!current || !value) return;
    const dir = currentDirectory();
    try {
      if (current.mode === "new-file") {
        const nextPath = dir ? `${dir}/${value}` : value;
        await props.runtime?.workspaceCreate?.({
          path: nextPath,
          content: "",
        });
        setSelectedPath(nextPath);
        await refreshTree();
        selectFile(nextPath);
      } else if (current.mode === "new-folder") {
        const nextPath = dir ? `${dir}/${value}` : value;
        await props.runtime?.workspaceCreate?.({
          path: nextPath,
          directory: true,
        });
        setSelectedPath(nextPath);
        await refreshTree();
      } else if (current.mode === "rename" && current.path) {
        const oldPath = current.path;
        const parent = oldPath.endsWith("/")
          ? oldPath.slice(0, -1).split("/").slice(0, -1).join("/")
          : oldPath.includes("/")
            ? oldPath.split("/").slice(0, -1).join("/")
            : "";
        const nextPath = parent ? `${parent}/${value}` : value;
        await props.runtime?.workspaceRename?.({
          path: oldPath,
          newPath: nextPath,
        });
        setSelectedPath(nextPath);
        await refreshTree();
        if (!nextPath.endsWith("/")) selectFile(nextPath);
      }
      setDialog(null);
    } catch (error) {
      props.runtime?.diagnostic?.(
        `操作失败：${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  async function deleteSelected() {
    const path = selectedPath();
    if (!path) return;
    if (!window.confirm(`确定删除 ${path}？文件将移入系统回收站。`)) return;
    try {
      const result = await props.runtime?.workspaceDelete?.({ path });
      if (!result?.deleted) {
        props.runtime?.diagnostic?.("删除失败：未收到删除确认", "error");
        return;
      }
      setSelectedPath("");
      await refreshTree();
      props.runtime?.diagnostic?.(`已移入回收站：${path}`, "info");
    } catch (error) {
      props.runtime?.diagnostic?.(
        `删除失败：${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  async function deletePath(path: string) {
    if (!window.confirm(`确定删除 ${path}？文件将移入系统回收站。`)) return;
    try {
      const result = await props.runtime?.workspaceDelete?.({ path });
      if (!result?.deleted) {
        props.runtime?.diagnostic?.("删除失败：未收到删除确认", "error");
        return;
      }
      if (selectedPath() === path) setSelectedPath("");
      await refreshTree();
      props.runtime?.diagnostic?.(`已移入回收站：${path}`, "info");
    } catch (error) {
      props.runtime?.diagnostic?.(
        `删除失败：${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  function selectEntry(path: string) {
    setSelectedPath(path);
    if (!path.endsWith("/")) selectFile(path.replace(/\/$/u, ""));
  }

  function openContextMenu(event: MouseEvent, path: string) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, path });
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  function contextDirectory(path: string): string {
    return path.endsWith("/") ? path.replace(/\/$/u, "") : currentDirectory();
  }

  function selectContextDirectory(path: string) {
    const dir = path.endsWith("/")
      ? path.replace(/\/$/u, "")
      : path.includes("/")
        ? path.split("/").slice(0, -1).join("/")
        : "";
    setSelectedPath(dir ? `${dir}/` : "");
  }

  function buildContextMenu(path: string): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      {
        type: "item",
        label: "新建文件",
        onClick() {
          selectContextDirectory(path);
          openNewFile();
        },
      },
      {
        type: "item",
        label: "新建文件夹",
        onClick() {
          selectContextDirectory(path);
          openNewFolder();
        },
      },
    ];
    if (path) {
      items.push(
        { type: "separator" },
        {
          type: "item",
          label: "重命名",
          onClick() {
            openRename(path);
          },
        },
        {
          type: "item",
          label: "删除",
          danger: true,
          onClick() {
            void deletePath(path);
          },
        },
      );
    }
    return items;
  }

  function renderTree(nodes: FileNode[], depth: number) {
    return (
      <For each={nodes}>
        {(node) => {
          const rowPath = node.type === "dir" ? `${node.path}/` : node.path;
          return (
            <div
              class="file-tree-row"
              data-active={selectedPath() === rowPath}
              onContextMenu={(event) => openContextMenu(event, rowPath)}
            >
              <button
                type="button"
                class="file-tree-item"
                style={{ "padding-left": `${depth * 16 + 6}px` }}
                onClick={() => selectEntry(rowPath)}
              >
                {node.type === "dir" ? (
                  <span
                    class="file-tree-chevron-slot"
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggle(node.path);
                    }}
                  >
                    <svg
                      class="file-tree-chevron"
                      data-expanded={expanded().has(node.path)}
                      viewBox="0 0 16 16"
                      fill="none"
                    >
                      <path
                        d="M6 4L10 8L6 12"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </span>
                ) : (
                  <span class="file-tree-chevron-slot" />
                )}
                {node.type === "dir" ? (
                  <svg class="file-tree-icon" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M2 4C2 2.89543 2.89543 2 4 2H7.5L9.5 4H12C13.1046 4 14 4.89543 14 6V12C14 13.1046 13.1046 14 12 14H4C2.89543 14 2 13.1046 2 12V4Z"
                      stroke="currentColor"
                      stroke-width="1.2"
                    />
                  </svg>
                ) : (
                  <svg
                    class="file-tree-icon file-tree-file-icon"
                    viewBox="0 0 16 16"
                    fill="none"
                  >
                    <path
                      d="M4 2C4 1.44772 4.44772 1 5 1H10L12 3V14C12 14.5523 11.5523 15 11 15H5C4.44772 15 4 14.5523 4 14V2Z"
                      stroke="currentColor"
                      stroke-width="1.2"
                    />
                    <path
                      d="M10 1V3H12"
                      stroke="currentColor"
                      stroke-width="1.2"
                      stroke-linecap="round"
                    />
                  </svg>
                )}
                <span class="file-tree-name">{node.name}</span>
                {node.status && (
                  <span
                    class={`file-tree-status ${node.status === "M" ? "status-modified" : "status-added"}`}
                  >
                    {node.status}
                  </span>
                )}
              </button>
              {node.type === "dir" ? (
                <Show when={expanded().has(node.path)}>
                  {node.children ? renderTree(node.children, depth + 1) : null}
                </Show>
              ) : null}
            </div>
          );
        }}
      </For>
    );
  }

  const parts = () => selectedPath().split("/");
  const breadcrumbs = () => {
    const p = parts();
    return p.map((part, index) => p.slice(0, index + 1).join("/"));
  };

  return (
    <div class="neu-file-pane">
      <div class="neu-top-row">
        <div class="neu-file-header">
          <span>资源管理器</span>
        </div>
        <Show when={openTabs().length}>
          <div class="neu-file-tabs-scroll">
            <div
              class="neu-file-editor-tabs"
              onWheel={(event) => {
                if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                  event.currentTarget.scrollLeft += event.deltaY;
                  event.preventDefault();
                }
              }}
            >
              <Show
                when={
                  selectedPath().endsWith(".md") ||
                  selectedPath().endsWith(".markdown")
                }
              >
                <button
                  type="button"
                  class="neu-file-editor-tab"
                  data-active={!preview()}
                  onClick={() => setPreview(false)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  class="neu-file-editor-tab"
                  data-active={preview()}
                  onClick={() => setPreview(true)}
                >
                  预览
                </button>
              </Show>
              <For each={openTabs()}>
                {(tab) => (
                  <div
                    class="neu-file-editor-tab"
                    data-active={selectedPath() === tab.path}
                    onClick={() => {
                      selectFile(tab.path);
                      setPreview(false);
                    }}
                  >
                    <svg
                      class="file-tree-icon file-tree-file-icon"
                      viewBox="0 0 16 16"
                      fill="none"
                    >
                      <path
                        d="M4 2C4 1.44772 4.44772 1 5 1H10L12 3V14C12 14.5523 11.5523 15 11 15H5C4.44772 15 4 14.5523 4 14V2Z"
                        stroke="currentColor"
                        stroke-width="1.2"
                      />
                      <path
                        d="M10 1V3H12"
                        stroke="currentColor"
                        stroke-width="1.2"
                        stroke-linecap="round"
                      />
                    </svg>
                    <span class="neu-file-editor-tab-label">
                      {tab.path.split("/").pop()}
                    </span>
                    <span class="neu-tab-dirty" />
                    <button
                      type="button"
                      class="neu-tab-close"
                      aria-label="关闭文件"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(tab.path);
                      }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                      >
                        <path
                          d="M3.5 3.5l7 7M10.5 3.5l-7 7"
                          stroke="currentColor"
                          stroke-width="1.2"
                          stroke-linecap="round"
                        />
                      </svg>
                    </button>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
      <div class="neu-file-body">
        <div class="neu-file-tree-shell" style={{ width: `${fileWidth()}px` }}>
          <div
            class="file-tree neu-file-tree"
            onContextMenu={(event) => openContextMenu(event, "")}
          >
            {renderTree(tree(), 0)}
          </div>
        </div>
        <div
          class="file-pane-resizer"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startFileResize}
        />
        <div class="neu-file-editor">
          <Show when={openTabs().length}>
            <div class="neu-file-breadcrumbs">
              <For each={breadcrumbs()}>
                {(part, index) => (
                  <>
                    <button
                      type="button"
                      class="neu-file-breadcrumb"
                      disabled={index() === breadcrumbs().length - 1}
                      onClick={() => void toggle(part)}
                    >
                      {part.split("/").pop()}
                    </button>
                    <Show when={index() < breadcrumbs().length - 1}>
                      <span class="neu-file-breadcrumb-separator">›</span>
                    </Show>
                  </>
                )}
              </For>
            </div>
          </Show>
          <div
            class="neu-file-editor-area"
            classList={{
              "neu-file-editor-area-preview":
                preview() &&
                (selectedPath().endsWith(".md") ||
                  selectedPath().endsWith(".markdown")),
            }}
          >
            {preview() &&
            (selectedPath().endsWith(".md") ||
              selectedPath().endsWith(".markdown")) ? (
              <div
                class="neu-markdown-preview"
                innerHTML={renderMarkdown(selectedContent())}
              />
            ) : (
              <div class="neu-file-codemirror" ref={attachEditor} />
            )}
          </div>
        </div>
      </div>
      <Show when={dialog()}>
        <div class="neu-file-dialog-backdrop" onClick={() => setDialog(null)}>
          <div
            class="neu-file-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="neu-file-dialog-title">
              {dialog()?.mode === "new-file"
                ? "新建文件"
                : dialog()?.mode === "new-folder"
                  ? "新建文件夹"
                  : "重命名"}
            </div>
            <input
              class="neu-file-dialog-input"
              value={dialogValue()}
              onInput={(event) => setDialogValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitDialog();
                if (event.key === "Escape") setDialog(null);
              }}
              autofocus
            />
            <div class="neu-file-dialog-actions">
              <button
                type="button"
                class="neu-file-dialog-button"
                onClick={() => setDialog(null)}
              >
                取消
              </button>
              <button
                type="button"
                class="neu-file-dialog-button neu-file-dialog-primary"
                onClick={() => void submitDialog()}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      </Show>
      <Show when={contextMenu()}>
        <ContextMenu
          x={contextMenu()!.x}
          y={contextMenu()!.y}
          items={buildContextMenu(contextMenu()!.path)}
          onClose={closeContextMenu}
        />
      </Show>
    </div>
  );
}

export default FileEditor;
