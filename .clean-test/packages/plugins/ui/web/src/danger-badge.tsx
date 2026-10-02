import { Show } from "solid-js";
import type { RuntimeEvent } from "@anthelia/contracts";

/**
 * The session's danger indicator (sandbox study §6b①, the UI chrome layer):
 * a persistent, pre-attentive badge in the app chrome — never injected into
 * the PTY byte stream (that would break full-screen programs), never
 * dismissible by a stray click. It reads the session snapshot's confinement
 * posture, which is journal-derived: the mode this session runs under plus
 * the last `confinement.escalated` fact. The indicator and the audit trail
 * share that one source; this module adds no second state.
 */

export type DangerBadgeInput = {
  mode: "read-only" | "workspace-write" | "danger-full-access";
  escalatedTo?: "read-only" | "workspace-write" | "danger-full-access";
  justification?: string;
  escalatedAt?: string;
};

export type DangerBadgeView = {
  /** Whether the badge renders at all: a confined session with no escalation shows nothing. */
  visible: boolean;
  /** The full-danger styling (the session runs unconfined). */
  danger: boolean;
  label: string;
  /** The hover title: the mode, and the escalation's reason and time. */
  title: string;
};

/**
 * The badge's view from the posture. A confined session that never
 * escalated is invisible — the indicator marks the exception, not the
 * norm. A danger-full-access session (the config's explicit choice) is
 * always marked; a confined session that escalated carries the
 * escalation's reason and time.
 */
export function dangerBadgeView(
  confinement: DangerBadgeInput | undefined,
): DangerBadgeView {
  if (!confinement)
    return { visible: false, danger: false, label: "", title: "" };
  const danger = confinement.mode === "danger-full-access";
  const escalated = confinement.escalatedTo !== undefined;
  if (!danger && !escalated)
    return { visible: false, danger: false, label: "", title: "" };
  const label = danger ? "DANGER" : "ESCALATED";
  const title = [
    `文件影响模式：${confinement.mode}`,
    ...(escalated
      ? [
          `本会话曾升级到 ${confinement.escalatedTo}（${confinement.escalatedAt ?? "时间未知"}）`,
          ...(confinement.justification
            ? [`理由：${confinement.justification}`]
            : []),
        ]
      : []),
  ].join("\n");
  return { visible: true, danger, label, title };
}

/** The badge element: colored, persistent, outside every PTY stream. */
export function DangerBadge(props: {
  confinement: DangerBadgeInput | undefined;
}) {
  const view = () => dangerBadgeView(props.confinement);
  return (
    <Show when={view().visible}>
      <span
        class="neu-danger-badge"
        data-danger={view().danger ? "true" : undefined}
        title={view().title}
      >
        {view().label}
      </span>
    </Show>
  );
}

/** The posture from the view-store's snapshot event, if one has arrived. */
export function postureFromSnapshot(
  snapshot: Extract<RuntimeEvent, { type: "session.snapshot" }> | undefined,
): DangerBadgeInput | undefined {
  return snapshot?.confinement;
}
