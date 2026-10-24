import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { Message, TranscriptHandle } from "@natalia/ui-kit";
import styles from "../styles/turn-navigator.module.css";

function readMessageText(msg: Message): string {
  return msg.contentLive ? msg.contentLive() : msg.content;
}

export interface TurnRailEntry {
  turn: number;
  messageIndex: number;
  messageID: string;
  prompt: string;
  response: string;
}

function cleanPreviewText(raw: string, maxChars = 180): string {
  const compact = raw
    .replace(/```[\s\S]*?```/gu, " [code] ")
    .replace(/\s+/gu, " ")
    .trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}…`;
}

const NOISE_SYSTEM_PREFIXES = [
  "(internal",
  "shell_switch:",
  "config_reload:",
  "sandbox_rung:",
  "cancelled:",
];

function isSubagentTriggerRow(msg: Message, text: string): boolean {
  if (msg.role === "user") return true;
  if (msg.role !== "system") return false;
  if (NOISE_SYSTEM_PREFIXES.some((prefix) => text.startsWith(prefix)))
    return false;
  return true;
}

export function deriveTurnRailEntries(
  messages: Message[],
  includeSystemTurns = false,
): TurnRailEntry[] {
  const out: TurnRailEntry[] = [];
  let turnCounter = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "user" && (!includeSystemTurns || msg.role !== "system")) {
      continue;
    }
    const rawPrompt = readMessageText(msg).trim();
    if (!rawPrompt || rawPrompt.startsWith("(internal")) continue;
    const isTrigger = includeSystemTurns
      ? isSubagentTriggerRow(msg, rawPrompt)
      : msg.role === "user";
    if (!isTrigger) continue;
    turnCounter += 1;
    let responseText = "";
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j]!;
      if (
        next.role === "user" ||
        (includeSystemTurns &&
          next.role === "system" &&
          isSubagentTriggerRow(next, readMessageText(next).trim()))
      ) {
        break;
      }
      if (next.role === "assistant" && !next.thinking) {
        const nextText = readMessageText(next).trim();
        if (nextText) responseText = nextText;
      }
    }
    out.push({
      turn: turnCounter,
      messageIndex: i,
      messageID: msg.id,
      prompt: cleanPreviewText(rawPrompt, 120),
      response: cleanPreviewText(responseText, 220),
    });
  }
  return out;
}

export interface TurnNavigatorProps {
  messages: () => Message[];
  getApi: () => TranscriptHandle | undefined;
  activeMessageID?: () => string | undefined;
  /** When true (Subagent/Team pane), also treat Natalia->Subagent task/system dispatches as turn triggers. */
  includeSystemTurns?: boolean;
  hasOlder?: boolean;
  onLoadOlder?: () => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}

/** Fixed pitch between neighbouring marks; overflow scrolls inside the frame. */
const TURN_SPACING_PX = 10;
/** Rail padding above the first mark and below the last one, per end. */
const RAIL_INSET_PX = 6;
/** Fade band the mask reserves at a scrollable end. */
const FADE_PX = 24;

function itemAtPointer(
  items: TurnRailEntry[],
  frame: HTMLElement,
  scrollTop: number,
  clientY: number,
): TurnRailEntry | undefined {
  if (items.length === 0) return undefined;
  const offset =
    clientY - frame.getBoundingClientRect().top + scrollTop - RAIL_INSET_PX;
  const index = Math.max(
    0,
    Math.min(items.length - 1, Math.round(offset / TURN_SPACING_PX)),
  );
  return items[index];
}

export function TurnNavigator(props: TurnNavigatorProps) {
  let cachedSignature = "";
  let cachedEntries: TurnRailEntry[] = [];

  const entries = createMemo<TurnRailEntry[]>(() => {
    const msgs = props.messages();
    const firstId = msgs[0]?.id ?? "";
    const lastMsg = msgs.at(-1);
    const lastId = lastMsg?.id ?? "";
    const lastLen = lastMsg ? readMessageText(lastMsg).length : 0;
    const sig = `${msgs.length}:${firstId}:${lastId}:${lastLen}:${Boolean(props.includeSystemTurns)}`;
    if (sig === cachedSignature) return cachedEntries;
    cachedSignature = sig;
    cachedEntries = deriveTurnRailEntries(msgs, props.includeSystemTurns);
    return cachedEntries;
  });

  const [hoveredTurn, setHoveredTurn] = createSignal<number | null>(null);
  const [activeTurn, setActiveTurn] = createSignal<number | null>(null);
  const [scrollState, setScrollState] = createSignal({
    top: 0,
    canScrollUp: false,
    canScrollDown: false,
  });
  let scrollerRef: HTMLDivElement | undefined;
  let pointerInside = false;

  const syncScrollState = () => {
    if (!scrollerRef) return;
    const top = scrollerRef.scrollTop;
    const canScrollUp = top > 1;
    const canScrollDown =
      top < scrollerRef.scrollHeight - scrollerRef.clientHeight - 1;
    setScrollState((prev) =>
      prev.top === top &&
      prev.canScrollUp === canScrollUp &&
      prev.canScrollDown === canScrollDown
        ? prev
        : { top, canScrollUp, canScrollDown },
    );
  };

  onMount(() => {
    if (!scrollerRef || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => syncScrollState());
    observer.observe(scrollerRef);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    entries().length;
    queueMicrotask(syncScrollState);
  });

  createEffect(() => {
    const list = entries();
    if (list.length === 0) {
      setActiveTurn(null);
      return;
    }
    const activeID = props.activeMessageID?.();
    if (activeID) {
      const allMsgs = props.messages();
      const activeIdx = allMsgs.findIndex((m) => m.id === activeID);
      if (activeIdx >= 0) {
        let matched = list[0]!.turn;
        for (const item of list) {
          if (item.messageIndex <= activeIdx) matched = item.turn;
          else break;
        }
        setActiveTurn(matched);
        return;
      }
    }
    setActiveTurn(list.at(-1)?.turn ?? null);
  });

  // Auto-scroll the rail to keep the active mark visible when pointer is outside
  createEffect(() => {
    const current = activeTurn();
    const list = entries();
    if (current === null || pointerInside || !scrollerRef) return;
    const idx = list.findIndex((item) => item.turn === current);
    if (idx < 0) return;
    const viewHeight = scrollerRef.clientHeight;
    const viewTop = scrollerRef.scrollTop;
    const markTop = idx * TURN_SPACING_PX + RAIL_INSET_PX;
    if (
      viewHeight <= 0 ||
      (markTop >= viewTop + FADE_PX &&
        markTop <= viewTop + viewHeight - FADE_PX)
    ) {
      return;
    }
    const target = Math.max(0, markTop - viewHeight / 2);
    if (typeof scrollerRef.scrollTo === "function") {
      scrollerRef.scrollTo({ top: target, behavior: "smooth" });
    } else {
      scrollerRef.scrollTop = target;
    }
    syncScrollState();
  });

  const hoveredIndex = createMemo(() => {
    const tNum = hoveredTurn();
    if (tNum === null) return -1;
    return entries().findIndex((item) => item.turn === tNum);
  });

  const hoveredEntry = createMemo(() => {
    const idx = hoveredIndex();
    return idx < 0 ? undefined : entries()[idx];
  });

  const naturalHeight = () =>
    Math.max(0, (entries().length - 1) * TURN_SPACING_PX + 2 * RAIL_INSET_PX);

  const handleJump = (entry: TurnRailEntry) => {
    setActiveTurn(entry.turn);
    const api = props.getApi();
    api?.scrollToIndex(entry.messageIndex, {
      align: "start",
      behavior: "smooth",
    });
  };

  return (
    <Show when={entries().length >= 2}>
      <nav
        class={styles.frame}
        style={{
          "--turn-natural-height": `${naturalHeight()}px`,
          "--turn-rail-inset": `${RAIL_INSET_PX}px`,
          "--turn-scroll-top": `${scrollState().top}px`,
        }}
        aria-label={props.t("turnNav.label")}
        onPointerEnter={() => {
          pointerInside = true;
          syncScrollState();
        }}
        onPointerMove={(e) => {
          const item = itemAtPointer(
            entries(),
            e.currentTarget,
            scrollerRef?.scrollTop ?? 0,
            e.clientY,
          );
          if (item) setHoveredTurn(item.turn);
        }}
        onClick={(e) => {
          const item = itemAtPointer(
            entries(),
            e.currentTarget,
            scrollerRef?.scrollTop ?? 0,
            e.clientY,
          );
          if (item) handleJump(item);
        }}
        onPointerLeave={() => {
          pointerInside = false;
          setHoveredTurn(null);
        }}
      >
        <div
          ref={(el) => {
            scrollerRef = el;
            queueMicrotask(syncScrollState);
          }}
          class={`${styles.scroller} ${scrollState().canScrollUp ? styles.fadeTop : ""} ${scrollState().canScrollDown ? styles.fadeBottom : ""}`}
          onScroll={() => {
            syncScrollState();
            if (
              pointerInside &&
              scrollerRef &&
              scrollerRef.scrollTop <= 8 &&
              props.hasOlder
            ) {
              props.onLoadOlder?.();
            }
          }}
        >
          <div class={styles.marks}>
            <For each={entries()}>
              {(entry, index) => (
                <div
                  class={styles.markPosition}
                  style={{
                    "--turn-natural-position": `${index() * TURN_SPACING_PX}px`,
                  }}
                >
                  <button
                    type="button"
                    class={styles.mark}
                    data-active={
                      activeTurn() === entry.turn ? "true" : undefined
                    }
                    data-preview={
                      hoveredTurn() === entry.turn ? "true" : undefined
                    }
                    aria-label={props.t("turnNav.jump", { turn: entry.turn })}
                    onPointerEnter={() => setHoveredTurn(entry.turn)}
                    onFocus={() => setHoveredTurn(entry.turn)}
                    onBlur={() => setHoveredTurn(null)}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleJump(entry);
                    }}
                  />
                </div>
              )}
            </For>
          </div>
        </div>
        <Show when={hoveredEntry()}>
          {(entry) => (
            <div
              role="tooltip"
              class={styles.preview}
              style={{
                "--turn-preview-pos": `${hoveredIndex() * TURN_SPACING_PX}px`,
              }}
            >
              <div class={styles.previewPrompt}>
                {entry().prompt ||
                  props.t("turnNav.turn", { turn: entry().turn })}
              </div>
              <Show when={entry().response}>
                <div class={styles.previewResponse}>{entry().response}</div>
              </Show>
            </div>
          )}
        </Show>
      </nav>
    </Show>
  );
}
