/**
 * PanelState: the eight states a region can be in, in one shape.
 *
 * A region is never just "empty" or "loaded" — it is empty, loading,
 * ready, errored, offline, partial, stale or forbidden, and each one
 * owes the reader a different answer. Rendering them through one
 * component is what keeps that promise: a region cannot forget the
 * state it is in, and the copy lives in the dictionary so it switches
 * language with the shell.
 *
 * The eight:
 *   empty     nothing here yet — say what would fill it
 *   loading   the first read is in flight — no spinner wall, just a line
 *   ready     data present — the region's own content, not this
 *   error     the read failed — say why and offer the retry
 *   offline   no connection — distinguish it from a failure
 *   partial   some data, some missing — name what is missing
 *   stale     the data predates a change — offer the refresh
 *   forbidden no permission — say what would grant it
 */

import { Match, Show, Switch } from "solid-js";

/** The eight states. */
export const PANEL_STATES = [
  "empty",
  "loading",
  "ready",
  "error",
  "offline",
  "partial",
  "stale",
  "forbidden",
] as const;

export type PanelStateKind = (typeof PANEL_STATES)[number];

export interface PanelStateProps {
  state: PanelStateKind;
  /** The region's own headline; the default is the state's. */
  title?: string;
  /** One line under the headline; the default is the state's. */
  description?: string;
  /** The verb that resolves the state (retry, refresh, reconnect). */
  actionLabel?: string;
  onAction?: () => void;
}

/** One icon per state, drawn from the same 24px grid. */
function StateIcon(props: { state: PanelStateKind }) {
  const common = {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.6,
    "stroke-linecap": "round" as const,
    "stroke-linejoin": "round" as const,
  };
  return (
    <switch>
      <Match when={props.state === "empty"}>
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18" />
        </svg>
      </Match>
      <Match when={props.state === "loading"}>
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </Match>
      <Match when={props.state === "error"}>
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16.5v.5" />
        </svg>
      </Match>
      <Match when={props.state === "offline"}>
        <svg {...common}>
          <path d="M4 4l16 16" />
          <path d="M8.5 15.5a5 5 0 017 0" />
          <path d="M5 12.5a9 9 0 013.5-2.6" />
          <path d="M19 12.5a9 9 0 00-3.5-2.6" />
        </svg>
      </Match>
      <Match when={props.state === "partial"}>
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18M9 9v11" />
        </svg>
      </Match>
      <Match when={props.state === "stale"}>
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
          <path d="M4 4l2 2M20 4l-2 2" />
        </svg>
      </Match>
      <Match when={props.state === "forbidden"}>
        <svg {...common}>
          <rect x="4" y="10" width="16" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 018 0v3" />
        </svg>
      </Match>
      <Match when={props.state === "ready"}>
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M8.5 12.5l2.5 2.5 4.5-5" />
        </svg>
      </Match>
    </switch>
  );
}

/** A region's state, in one shape: icon, headline, one line, one verb. */
export function PanelState(props: PanelStateProps) {
  return (
    <div class="panel-state" data-state={props.state} role="status">
      <div class="panel-state-icon">
        <StateIcon state={props.state} />
      </div>
      <div class="panel-state-title">{props.title}</div>
      <Show when={props.description}>
        <div class="panel-state-desc">{props.description}</div>
      </Show>
      <Show when={props.actionLabel && props.onAction}>
        <button
          type="button"
          class="panel-state-action"
          onClick={() => props.onAction?.()}
        >
          {props.actionLabel}
        </button>
      </Show>
    </div>
  );
}
