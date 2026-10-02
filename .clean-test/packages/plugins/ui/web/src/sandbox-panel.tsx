import { createSignal, Show, onCleanup, onMount, For } from "solid-js";
import type { SandboxView } from "@natalia/view-store";
import type { RuntimeClient, RuntimeSandbox } from "@anthelia/contracts";

export function SandboxPanel(props: {
  open: boolean;
  onClose: () => void;
  sandboxes: Record<string, SandboxView>;
  sessionID?: string;
  runtime?: Pick<
    RuntimeClient,
    | "sandboxMerge"
    | "sandboxDelete"
    | "sandboxList"
    | "sandboxDiff"
    | "sandboxResources"
  >;
}) {
  const [selected, setSelected] = createSignal<SandboxView | null>(null);
  const [list, setList] = createSignal<RuntimeSandbox[] | undefined>(undefined);

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", handleKeydown);
    onCleanup(() => window.removeEventListener("keydown", handleKeydown));
    void props.runtime?.sandboxList?.(props.sessionID).then((value) => {
      if (value) setList(value);
    });
  });

  const rows = () =>
    list()?.map((sandbox) => ({
      id: sandbox.id,
      isolationLevel: sandbox.isolationLevel,
      changedFiles: sandbox.changedFiles,
      runningResources: sandbox.runningResources,
    })) ??
    Object.values(props.sandboxes).map((sandbox) => ({
      id: sandbox.id,
      isolationLevel: sandbox.isolationLevel,
      changedFiles: sandbox.changedFiles,
      runningResources: sandbox.runningResources,
    }));

  return (
    <Show when={props.open}>
      <div class="neu-settings-backdrop" onClick={props.onClose}>
        <div
          class="neu-sandbox-window"
          onClick={(event) => event.stopPropagation()}
        >
          <div class="neu-settings-header">
            <span class="neu-settings-title">沙箱管理</span>
            <button
              type="button"
              class="neu-settings-close"
              onClick={props.onClose}
              aria-label="关闭沙箱管理"
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
          <div class="neu-sandbox-body">
            <Show when={!selected()}>
              <For each={rows()}>
                {(sandbox) => (
                  <button
                    type="button"
                    class="neu-flow-card"
                    onClick={() => setSelected(sandbox as SandboxView)}
                  >
                    <span class="neu-flow-card-title">{sandbox.id}</span>
                    <span class="neu-flow-card-meta">
                      {sandbox.isolationLevel} · {sandbox.changedFiles} changes
                      · {sandbox.runningResources} resources
                    </span>
                  </button>
                )}
              </For>
              <div class="neu-extension-actions">
                <button type="button" class="neu-extension-add">
                  新建沙箱
                </button>
              </div>
            </Show>
            <Show when={selected()}>
              <button
                type="button"
                class="neu-flow-back"
                onClick={() => setSelected(null)}
              >
                ← 返回
              </button>
              <div class="neu-flow-detail-title">{selected()?.id}</div>
              <div class="neu-flow-detail-field">
                {selected()?.isolationLevel} isolation ·{" "}
                {selected()?.changedFiles} pending changes
              </div>
              <div class="neu-flow-section-title">Changes</div>
              <Show when={selected()?.changedFiles ?? 0 > 0}>
                <div class="neu-sandbox-change">3 个待合并变更</div>
              </Show>
              <div class="neu-flow-section-title">Resources</div>
              <div class="neu-flow-detail-field">
                {selected()?.runningResources ?? 0} running resources
              </div>
              <div class="neu-form-actions">
                <button
                  type="button"
                  class="neu-form-btn neu-form-cancel"
                  onClick={() =>
                    props.runtime?.sandboxMerge?.(
                      selected()!.id,
                      props.sessionID,
                    )
                  }
                >
                  合并变更
                </button>
                <button type="button" class="neu-form-btn neu-form-cancel">
                  停止资源
                </button>
                <button
                  type="button"
                  class="neu-form-btn neu-form-primary"
                  onClick={() =>
                    props.runtime?.sandboxDelete?.(
                      selected()!.id,
                      props.sessionID,
                    )
                  }
                >
                  删除沙箱
                </button>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
