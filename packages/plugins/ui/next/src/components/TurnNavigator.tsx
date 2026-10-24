import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
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
      const nextText = readMessageText(next).trim();
      const nextIsTrigger = includeSystemTurns
        ? isSubagentTriggerRow(next, nextText)
        : next.role === "user";
      if (nextIsTrigger) break;
      if (next.role === "assistant" && !next.thinking && nextText) {
        responseText = nextText;
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
  t: (key: string, params?: Record<string, unknown>) => string;
}

const TURN_SPACING_PX = 10;

export function TurnNavigator(props: TurnNavigatorProps) {
  const entries = createMemo(() =>
    deriveTurnRailEntries(props.messages(), props.includeSystemTurns),
  );
  const [hoveredTurn, setHoveredTurn] = createSignal<number | null>(null);
  const [activeTurn, setActiveTurn] = createSignal<number | null>(null);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewHeight, setViewHeight] = createSignal(0);
  let scrollerRef: HTMLDivElement | undefined;
  let pointerInside = false;

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
    if (current === null || pointerInside || !scrollerRef) return;
    const idx = entries().findIndex((item) => item.turn === current);
    if (idx < 0) return;
    const height = scrollerRef.clientHeight;
    if (height <= 0) return;
    const center = idx * TURN_SPACING_PX + 10;
    const currentTop = scrollerRef.scrollTop;
    if (center < currentTop + 24 || center > currentTop + height - 24) {
      scrollerRef.scrollTop = Math.max(0, center - height / 2);
      setScrollTop(scrollerRef.scrollTop);
    }
  });

  const hoveredEntry = createMemo(() => {
    const tNum = hoveredTurn();
    if (tNum === null) return undefined;
    return entries().find((item) => item.turn === tNum);
  });

  const hoveredCenterPx = createMemo(() => {
    const tNum = hoveredTurn();
    if (tNum === null) return 0;
    const idx = entries().findIndex((item) => item.turn === tNum);
    if (idx < 0) return 0;
    return idx * TURN_SPACING_PX + 10 - scrollTop();
  });

  const totalHeight = () => entries().length * TURN_SPACING_PX + 12;
  const fadeTop = () => scrollTop() > 1;
  const fadeBottom = () =>
    viewHeight() > 0 && scrollTop() < totalHeight() - viewHeight() - 1;

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
        aria-label={props.t("turnNav.label")}
        onPointerEnter={() => {
          pointerInside = true;
          if (scrollerRef) {
            setViewHeight(scrollerRef.clientHeight);
            setScrollTop(scrollerRef.scrollTop);
          }
        }}
        onPointerLeave={() => {
          pointerInside = false;
          setHoveredTurn(null);
        }}
      >
        <div
          ref={(el) => {
            scrollerRef = el;
            queueMicrotask(() => {
              setViewHeight(el.clientHeight);
              setScrollTop(el.scrollTop);
            });
          }}
          class={`${styles.scroller} ${fadeTop() ? styles.fadeTop : ""} ${fadeBottom() ? styles.fadeBottom : ""}`}
          onScroll={(e) => {
            setScrollTop(e.currentTarget.scrollTop);
            setViewHeight(e.currentTarget.clientHeight);
          }}
        >
          <div
            class={styles.marks}
            style={{
              height: `${totalHeight()}px`,
            }}
          >
            <For each={entries()}>
              {(entry, idx) => {
                const isActive = () => activeTurn() === entry.turn;
                const isPreview = () => hoveredTurn() === entry.turn;
                return (
                  <button
                    type="button"
                    class={styles.mark}
                    data-active={isActive()}
                    data-preview={isPreview()}
                    style={{
                      top: `${idx() * TURN_SPACING_PX + 6}px`,
                    }}
                    aria-label={props.t("turnNav.jumpToTurn", {
                      turn: entry.turn,
                    })}
                    onPointerEnter={() => setHoveredTurn(entry.turn)}
                    onPointerMove={() => setHoveredTurn(entry.turn)}
                    onFocus={() => setHoveredTurn(entry.turn)}
                    onBlur={() => setHoveredTurn(null)}
                    onClick={() => handleJump(entry)}
                  />
                );
              }}
            </For>
          </div>
        </div>
        <Show when={hoveredEntry()}>
          {(entry) => (
            <div
              role="tooltip"
              class={styles.preview}
              style={{
                "--turn-preview-center": `${hoveredCenterPx()}px`,
              }}
            >
              <div class={styles.previewPrompt}>
                {entry().prompt ||
                  props.t("turnNav.turnFallback", { turn: entry().turn })}
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
