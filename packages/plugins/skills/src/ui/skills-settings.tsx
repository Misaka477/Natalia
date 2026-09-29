import { createSignal, For, Show, onCleanup, onMount } from "solid-js";
import type {
  RuntimeClient,
  RuntimeSkillCatalogEntry,
} from "@anthelia/contracts";
import type { UiEventBus } from "@natalia/ui-host";

/**
 * The skill panel: list, switch, remove.
 *
 * The switch and the remove are the workspace's own two write faces
 * (`skill.setEnabled` / `skill.remove`) — a disabled skill stays LISTED with its
 * switch off, because `resolve` refuses it (so the model can neither load nor
 * run it) while the panel must still be able to switch it back on. Removing is
 * refused for a source the workspace does not own (a plugin's skill ships with
 * the plugin; a remote one is pulled), and the refusal's reason is shown rather
 * than swallowed.
 */
export function SkillsSettings(props: {
  runtime: RuntimeClient;
  events: UiEventBus;
}) {
  const [skills, setSkills] = createSignal<RuntimeSkillCatalogEntry[]>([]);
  const [adding, setAdding] = createSignal(false);
  const [source, setSource] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [pending, setPending] = createSignal<string | undefined>();

  async function refresh() {
    const next = await props.runtime.skills?.();
    if (next) setSkills(next);
  }

  onMount(() => {
    void refresh();
    const off = props.events.subscribe((event) => {
      if (event.type === "content.done" || event.type === "turn.finished")
        void refresh();
    });
    onCleanup(off);
  });

  async function addSkill() {
    const input = source().trim();
    if (!input || busy()) return;
    setBusy(true);
    setStatus("");
    try {
      await props.runtime.commandExecute?.({
        name: "skill-install",
        raw: `/skill-install ${input}`,
        args: [input],
      });
      setSource("");
      setAdding(false);
      setStatus("已提交安装，技能安装完成后会自动刷新列表");
    } catch (error) {
      // The install is a command; a refusal names its reason.
      setStatus(
        `安装失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  async function toggle(skill: RuntimeSkillCatalogEntry) {
    if (busy()) return;
    setBusy(true);
    setPending(skill.name);
    setStatus("");
    try {
      await props.runtime.skillSetEnabled?.({
        name: skill.name,
        enabled: !skill.enabled,
      });
      // The registry reloaded behind the call, so re-read rather than flip
      // locally: the value must be the runtime's, not the panel's guess.
      await refresh();
    } catch (error) {
      setStatus(
        `${skill.name} 切换失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBusy(false);
      setPending(undefined);
    }
  }

  async function remove(skill: RuntimeSkillCatalogEntry) {
    if (busy()) return;
    setBusy(true);
    setPending(skill.name);
    setStatus("");
    try {
      await props.runtime.skillRemove?.({ name: skill.name });
      setStatus(`已删除 ${skill.name}`);
      await refresh();
    } catch (error) {
      // A plugin-sourced skill refuses: the reason is the answer, so show it.
      setStatus(
        `${skill.name} 删除失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBusy(false);
      setPending(undefined);
    }
  }

  return (
    <div>
      <div class="neu-settings-content-title">Skill 配置</div>
      <Show
        when={skills().length}
        fallback={
          <div class="neu-settings-item">
            <div class="neu-settings-item-main">
              <span class="neu-settings-item-label">暂无技能</span>
              <span class="neu-settings-item-description">
                点击下方添加技能
              </span>
            </div>
          </div>
        }
      >
        <For each={skills()}>
          {(skill) => (
            <div class="neu-extension-row" data-enabled={skill.enabled}>
              <span class="neu-extension-name">{skill.name}</span>
              <span class="neu-extension-description">
                {skill.description || skill.source}
              </span>
              {/* The switch: a real button, so a click is never swallowed. Its
                  state is the runtime's answer, and the label says both. */}
              <button
                type="button"
                class="neu-extension-switch"
                data-enabled={skill.enabled}
                role="switch"
                aria-checked={skill.enabled}
                aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.name}`}
                disabled={busy() && pending() === skill.name}
                onClick={() => void toggle(skill)}
              >
                <span class="neu-extension-switch-knob" />
                <span class="neu-extension-switch-text">
                  {pending() === skill.name && busy()
                    ? "…"
                    : skill.enabled
                      ? "已启用"
                      : "已停用"}
                </span>
              </button>
              <button
                type="button"
                class="neu-extension-btn neu-extension-remove"
                disabled={busy() && pending() === skill.name}
                onClick={() => void remove(skill)}
              >
                {pending() === skill.name && busy() ? "…" : "删除"}
              </button>
            </div>
          )}
        </For>
      </Show>

      <Show when={adding()}>
        <div class="neu-extension-form">
          <input
            class="neu-form-input"
            value={source()}
            placeholder="技能 URL 或本地路径"
            onInput={(event) => setSource(event.currentTarget.value)}
          />
          <div class="neu-extension-form-actions">
            <button
              type="button"
              class="neu-extension-btn"
              onClick={() => {
                setAdding(false);
                setSource("");
              }}
            >
              取消
            </button>
            <button
              type="button"
              class="neu-extension-btn neu-extension-primary-btn"
              disabled={busy()}
              onClick={() => void addSkill()}
            >
              {busy() ? "提交中…" : "添加"}
            </button>
          </div>
        </div>
      </Show>

      <Show when={status()}>
        <div class="neu-settings-item-description" style="margin-top:8px;">
          {status()}
        </div>
      </Show>

      <div class="neu-extension-actions">
        <button
          type="button"
          class="neu-extension-add"
          onClick={() => setAdding(!adding())}
        >
          添加技能
        </button>
      </div>
    </div>
  );
}
