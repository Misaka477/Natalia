import { Show, For, onCleanup, onMount } from "solid-js";

const shortcuts = [
  { keys: ["Ctrl", "B"], description: "切换左侧栏" },
  { keys: ["Ctrl", "J"], description: "切换右侧栏" },
  { keys: ["Ctrl", "K"], description: "打开命令面板" },
  { keys: ["Ctrl", "/"], description: "打开设置" },
  { keys: ["Ctrl", "Shift", "P"], description: "搜索工作区" },
];

const sections = [
  {
    title: "Main Agent",
    text: "处理实际工作区任务，可执行工具、读写文件、运行命令。",
  },
  { title: "Navi Chat", text: "用于规划、审查和提问，不直接操作工作区。" },
  { title: "右侧工具栏", text: "审阅 Diff / 终端 / 文件 / 浏览器。" },
  {
    title: "会话与 Checkpoint",
    text: "左侧会话管理支持新建、Fork、快照、回滚。",
  },
];

export function HelpPanel(props: { open: boolean; onClose: () => void }) {
  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", handleKeydown);
    onCleanup(() => window.removeEventListener("keydown", handleKeydown));
  });

  return (
    <Show when={props.open}>
      <div class="neu-settings-backdrop" onClick={props.onClose}>
        <div
          class="neu-help-window"
          onClick={(event) => event.stopPropagation()}
        >
          <div class="neu-settings-header">
            <span class="neu-settings-title">帮助</span>
            <button
              type="button"
              class="neu-settings-close"
              onClick={props.onClose}
              aria-label="关闭帮助"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 3l10 10M13 3L3 13"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>
          <div class="neu-help-body">
            <div class="neu-help-section-title">快速开始</div>
            <For each={sections}>
              {(section) => (
                <div class="neu-help-item">
                  <span class="neu-help-item-title">{section.title}</span>
                  <span class="neu-help-item-text">{section.text}</span>
                </div>
              )}
            </For>
            <div class="neu-help-section-title">快捷键</div>
            <For each={shortcuts}>
              {(shortcut) => (
                <div class="neu-help-shortcut">
                  <span class="neu-help-shortcut-keys">
                    {shortcut.keys.join(" + ")}
                  </span>
                  <span class="neu-help-shortcut-desc">
                    {shortcut.description}
                  </span>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
}
