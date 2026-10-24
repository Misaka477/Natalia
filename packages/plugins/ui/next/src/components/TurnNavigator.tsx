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

export function deriveTurnRailEntries(messages: Message[]): TurnRailEntry[] {
  const out: TurnRailEntry[] = [];
  let turnCounter = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;
    const rawPrompt = readMessageText(msg).trim();
    if (!rawPrompt || rawPrompt.startsWith("(internal")) continue;
    turnCounter += 1;
    let responseText = "";
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j]!;
      if (next.role === "user") break;
      if (next.role === "assistant" && !next.thinking) {
        const text = readMessageText(next).trim();
        if (text) responseText = text;
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
  t: (key: string, params?: Record<string, unknown>) => string;
}

const TURN_SPACING_PX = 10;

export function TurnNavigator(props: TurnNavigatorProps) {
  const entries = createMemo(() => deriveTurnRailEntries(props.messages()));
  const [hoveredTurn, setHoveredTurn] = createSignal<number | null>(null);
  const [activeTurn, setActiveTurn] = createSignal<number | null>(null);
  let scrollerRef: HTMLDivElement | undefined;

  // Keep activeTurn synced when activeMessageID or entry count updates
  createEffect(() => {
    const list = entries();
    if (list.length === 0) {
      setActiveTurn(null);
      return;
    }
    const activeID = props.activeMessageID?.();
    if (activeID) {
      // Find the latest user turn at or before activeID
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
    if (activeTurn() === null || activeTurn()! > list.length) {
      setActiveTurn(list.at(-1)?.turn ?? null);
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
    const scrollTop = scrollerRef?.scrollTop ?? 0;
    return idx * TURN_SPACING_PX + 10 - scrollTop;
  });

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
        onPointerLeave={() => setHoveredTurn(null)}
      >
        <div ref={scrollerRef} class={styles.scroller}>
          <div
            class={styles.marks}
            style={{
              height: `${entries().length * TURN_SPACING_PX + 12}px`,
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
