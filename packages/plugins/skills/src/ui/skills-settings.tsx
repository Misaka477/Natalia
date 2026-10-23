import { createSignal, For, Show, onCleanup, onMount } from "solid-js";
import type {
  RuntimeClient,
  RuntimeSkillCatalogEntry,
} from "@anthelia/contracts";
import type { UiEventBus } from "@natalia/ui-host";
import { bindSkillsLocale, type SkillsLocaleKey } from "./locales";

/**
 * The skill panel: list, switch, remove.
 *
 * The switch and the remove are the workspace's own two write faces
 * (`skill.setEnabled` / `skill.remove`) — a disabled skill stays LISTED with its
 * switch off, because `resolve` refuses it (so the model can neither load nor
 * run it) while the panel must still be able to switch it back on.
 *
 * The REMOVE is offered only for a source the workspace owns (project /
 * user). A plugin's skill ships with the plugin and a remote one is pulled
 * into a cache: deleting either would be undone by the next reload (or would
 * corrupt the package), so the boundary refuses it — and a button that can
 * only ever produce a refusal is a button that trains people to ignore
 * refusals. Those rows carry a source badge instead, which also tells the
 * user WHY there is no delete. An operator who really wants an official
 * skill gone has the CLI (and the durable off-switch here).
 */

/** The sources whose skills the workspace owns and may delete. */
export function removableSource(source: string): boolean {
  return source === "project" || source === "user";
}

/** The badge a non-owned row carries where its delete button would be. */
export function sourceLabel(
  source: string,
  t?: (key: SkillsLocaleKey) => string,
): string {
  if (source === "plugin") return t ? t("skills.sourcePlugin") : "插件内置";
  if (source === "remote") return t ? t("skills.sourceRemote") : "远程索引";
  return source;
}
export function SkillsSettings(props: {
  runtime: RuntimeClient;
  events: UiEventBus;
  extra?: unknown;
}) {
  const t = bindSkillsLocale(props.extra);
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
      setStatus(t("skills.installSubmitted"));
    } catch (error) {
      // The install is a command; a refusal names its reason.
      setStatus(
        t("skills.installFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
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
        t("skills.toggleFailed", {
          name: skill.name,
          error: error instanceof Error ? error.message : String(error),
        }),
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
      setStatus(t("skills.removed", { name: skill.name }));
      await refresh();
    } catch (error) {
      // A plugin-sourced skill refuses: the reason is the answer, so show it.
      setStatus(
        t("skills.removeFailed", {
          name: skill.name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setBusy(false);
      setPending(undefined);
    }
  }

  return (
    <div>
      <div class="neu-settings-content-title">{t("skills.title")}</div>
      <Show
        when={skills().length}
        fallback={
          <div class="neu-settings-item">
            <div class="neu-settings-item-main">
              <span class="neu-settings-item-label">{t("skills.empty")}</span>
              <span class="neu-settings-item-description">
                {t("skills.emptyHint")}
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
                aria-label={`${skill.enabled ? t("skills.disable") : t("skills.enable")} ${skill.name}`}
                disabled={busy() && pending() === skill.name}
                onClick={() => void toggle(skill)}
              >
                <span class="neu-extension-switch-knob" />
                <span class="neu-extension-switch-text">
                  {pending() === skill.name && busy()
                    ? "…"
                    : skill.enabled
                      ? t("skills.enabled")
                      : t("skills.disabled")}
                </span>
              </button>
              {/* The remove is the workspace's own: a skill that ships
                  with a plugin or arrives from a remote index is not
                  theirs to delete, and the badge says so where the button
                  would have been. */}
              <Show
                when={removableSource(skill.source)}
                fallback={
                  <span class="neu-extension-source">
                    {sourceLabel(skill.source, t)}
                  </span>
                }
              >
                <button
                  type="button"
                  class="neu-extension-btn neu-extension-remove"
                  disabled={busy() && pending() === skill.name}
                  onClick={() => void remove(skill)}
                >
                  {pending() === skill.name && busy()
                    ? "…"
                    : t("skills.delete")}
                </button>
              </Show>
            </div>
          )}
        </For>
      </Show>

      <Show when={adding()}>
        <div class="neu-extension-form">
          <input
            class="neu-form-input"
            value={source()}
            placeholder={t("skills.sourcePlaceholder")}
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
              {t("skills.cancel")}
            </button>
            <button
              type="button"
              class="neu-extension-btn neu-extension-primary-btn"
              disabled={busy()}
              onClick={() => void addSkill()}
            >
              {busy() ? t("skills.submitting") : t("skills.add")}
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
          {t("skills.addSkill")}
        </button>
      </div>
    </div>
  );
}
