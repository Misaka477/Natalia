import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  RuntimeEvent,
  RuntimeNativeTerminalSession,
} from "@anthelia/contracts";
import {
  NativeTerminalRegistry,
  createWezTermHost,
  reclaimStaleMuxRuntimeDirs,
  startNativeInputBroker,
  writeWezTermNativeDomainConfig,
  type NativeInputBroker,
} from "./native-terminal";
import type { TerminalController } from "@anthelia/runtime-services";

export type { TerminalControllerInput } from "@anthelia/runtime-services";

/**
 * The native terminal resource controller — cut of the resource controllers
 * split (mainline plan §15). It owns an internally created
 * `NativeTerminalRegistry` and input broker, including the WezTerm host
 * bootstrap, one-shot recovery when the mux server or runtime dirs disappear,
 * and teardown. An externally provided registry (the host's own
 * `options.nativeTerminal`) is borrowed as-is and never rebuilt or disposed.
 *
 * Multi-session shape (plan §41.9): the registry is reached by accessor;
 * when sessions become per-session panes (TERM-M I3), only this module's
 * init changes.
 */
export function createTerminalController(input: {
  workspaceRoot: string;
  publish(event: RuntimeEvent): void;
  onPerformance(name: string, durationMs: number): void;
  runtimeID(): string;
  userRuntimeHome(): string | undefined;
  /** How foreground terminal starts relate to the human window (§TERM-9). */
  windowMode(): "auto" | "windowless" | "window";
  external?: NativeTerminalRegistry;
}): TerminalController {
  let nativeTerminal: NativeTerminalRegistry | undefined = input.external;
  let nativeInputBroker: NativeInputBroker | undefined;
  let closed = false;

  function broker() {
    const runtimeHome = input.userRuntimeHome();
    const nativeRuntimeDir = runtimeHome
      ? join(runtimeHome, "natalia")
      : join(input.workspaceRoot, ".natalia", "native-input");
    const nativeMuxRuntimeDir = join(
      nativeRuntimeDir,
      "wezterm-runtime",
      input.runtimeID(),
    );
    const nativeMuxSocket = join(nativeMuxRuntimeDir, "wezterm", "sock");
    return { nativeRuntimeDir, nativeMuxRuntimeDir, nativeMuxSocket };
  }

  async function installRegistry(
    nativeRuntimeDir: string,
    nativeMuxRuntimeDir: string,
    nativeMuxSocket: string,
    nativeDomain: Awaited<ReturnType<typeof writeWezTermNativeDomainConfig>>,
  ) {
    nativeTerminal = new NativeTerminalRegistry(
      createWezTermHost({
        // The GUI, CLI, and mux server must share this socket. Otherwise
        // Open terminal can attach a real window to the user's unrelated
        // default mux while Natalia controls a different pane.
        environment: { WEZTERM_UNIX_SOCKET: nativeMuxSocket },
        // Every `wezterm cli` invocation then runs with --no-auto-start
        // --prefer-mux --class <className>: a cli spawn must never auto-start
        // its own GUI (which would show a first window that later empties
        // when the pane is moved, i.e. duplicate windows), and every command
        // must target the private mux rather than whatever instance is last.
        className: `natalia-${input.runtimeID()}`,
        muxRuntimeDir: nativeMuxRuntimeDir,
        nativeDomain,
        onPerformance: input.onPerformance,
      }),
      {
        onAudit: (event) => {
          input.publish({
            type: "terminal.action",
            id: event.id,
            ...(event.sessionID
              ? { sessionID: event.sessionID as RuntimeEvent["sessionID"] }
              : {}),
            action: event.action,
            redacted: event.redacted,
            target: { kind: "host", cwd: event.cwd },
          });
          input.publish({
            type: "terminal.timeline",
            id: event.id,
            ...(event.sessionID
              ? { sessionID: event.sessionID as RuntimeEvent["sessionID"] }
              : {}),
            actor: event.actor === "human" ? "user" : event.actor,
            action: event.action,
            status: "executed",
            summary:
              event.action === "request_human"
                ? (event.detail ?? "native terminal requests human attention")
                : event.action === "started"
                  ? "native terminal started in the background; open it with Open terminal"
                  : event.action === "write"
                    ? "native terminal input accepted"
                    : event.action === "secure_input"
                      ? "native terminal secure input state changed"
                      : `native terminal ${event.action} executed`,
            at: event.at,
          });
        },
        windowMode: input.windowMode(),
        persistPath: join(nativeMuxRuntimeDir, "native-terminal-sessions.json"),
      },
    );
    nativeInputBroker = await startNativeInputBroker({
      registry: nativeTerminal,
      runtimeDir: nativeRuntimeDir,
      daemonID: randomUUID(),
      onInput: ({ terminalID, paneID, kind, byteLength }) => {
        const sessionID = nativeTerminal?.session(terminalID).sessionID;
        const summary = `native human input claim accepted: terminal=${terminalID} pane=${paneID} kind=${kind} bytes=${byteLength}`;
        input.publish({
          type: "diagnostic",
          ...(sessionID
            ? { sessionID: sessionID as RuntimeEvent["sessionID"] }
            : {}),
          level: "info",
          message: summary,
        });
        input.publish({
          type: "terminal.timeline",
          id: terminalID,
          ...(sessionID
            ? { sessionID: sessionID as RuntimeEvent["sessionID"] }
            : {}),
          actor: "user",
          action: "write",
          status: "executed",
          summary,
          at: new Date().toISOString(),
        });
      },
      onDenied: ({ terminalID, paneID, tokenAccepted, paneAccepted }) => {
        const sessionID = nativeTerminal?.session(terminalID).sessionID;
        input.publish({
          type: "diagnostic",
          ...(sessionID
            ? { sessionID: sessionID as RuntimeEvent["sessionID"] }
            : {}),
          level: "warning",
          message: `native input claim denied: terminal=${terminalID} pane=${paneID} token=${tokenAccepted} paneKnown=${paneAccepted}`,
        });
      },
    });
    nativeTerminal.setHumanInputBridge(nativeInputBroker);
  }

  async function init() {
    if (closed) throw new Error("terminal controller is closed");
    if (nativeTerminal) return;
    const { nativeRuntimeDir, nativeMuxRuntimeDir, nativeMuxSocket } = broker();
    let nativeDomain: Awaited<
      ReturnType<typeof writeWezTermNativeDomainConfig>
    >;
    try {
      await mkdir(nativeRuntimeDir, { recursive: true, mode: 0o700 });
      await mkdir(nativeMuxRuntimeDir, { recursive: true, mode: 0o700 });
      // Each runtime owns one of these directories and removes it on dispose,
      // so anything left from a runtime that was killed accumulates for as
      // long as the host stays up. Reclaiming is best effort and must not
      // delay or fail startup.
      void reclaimStaleMuxRuntimeDirs({
        root: join(nativeRuntimeDir, "wezterm-runtime"),
        keep: input.runtimeID(),
      }).catch(() => undefined);
      nativeDomain = await writeWezTermNativeDomainConfig({
        directory: nativeMuxRuntimeDir,
        socketPath: nativeMuxSocket,
      });
      await installRegistry(
        nativeRuntimeDir,
        nativeMuxRuntimeDir,
        nativeMuxSocket,
        nativeDomain,
      );
    } catch {
      // Native Terminal recovery: if the mux server was killed or runtime
      // dirs were deleted (e.g. by rm -rf), recreate dirs and retry once.
      input.publish({
        type: "diagnostic",
        level: "info",
        message: "native terminal first init failed; attempting recovery",
      });
      try {
        await mkdir(nativeRuntimeDir, { recursive: true, mode: 0o700 });
        await mkdir(nativeMuxRuntimeDir, { recursive: true, mode: 0o700 });
        nativeDomain = await writeWezTermNativeDomainConfig({
          directory: nativeMuxRuntimeDir,
          socketPath: nativeMuxSocket,
        });
        await installRegistry(
          nativeRuntimeDir,
          nativeMuxRuntimeDir,
          nativeMuxSocket,
          nativeDomain,
        );
      } catch {
        // Recovery failed; native terminal remains unavailable for this
        // session. Its canonical tools report an actionable error when
        // invoked.
      }
    }
  }

  function requireTerminal() {
    if (!nativeTerminal) throw new Error("Native Terminal Host is unavailable");
    return nativeTerminal;
  }

  function publicSession(
    session: ReturnType<NativeTerminalRegistry["session"]>,
  ): RuntimeNativeTerminalSession {
    return {
      id: session.id,
      host: session.host,
      paneID: session.paneID,
      windowID: session.windowID,
      muxWindowID: session.muxWindowID,
      tabID: session.tabID,
      command: session.command,
      cwd: session.cwd,
      status: session.status,
      inputOwner: session.inputOwner,
      geometryOwner: session.geometryOwner,
      secureInput: session.secureInput,
      rows: session.rows,
      cols: session.cols,
      startedAt: session.startedAt,
      attached: session.attached,
      mayWaitForHuman: session.mayWaitForHuman,
      ...(session.sessionID ? { sessionID: session.sessionID } : {}),
      ...(session.agentID ? { agentID: session.agentID } : {}),
    };
  }

  async function reconcile() {
    return (await requireTerminal().reconcile()).map(publicSession);
  }

  async function list(_sessionID?: string) {
    return nativeTerminal ? await reconcile() : [];
  }

  async function read(
    id: string,
    options?: { maxLines?: number; sessionID?: string },
  ) {
    return await requireTerminal().read(id, options);
  }

  async function openHub() {
    const hub = await requireTerminal().openHub();
    return { muxWindowID: hub.muxWindowID };
  }

  function releaseHumanControl(id: string, sessionID?: string) {
    return publicSession(requireTerminal().releaseHumanControl(id, sessionID));
  }

  async function claimHumanInput(id: string, sessionID?: string) {
    return publicSession(
      await requireTerminal().claimHumanInput(id, sessionID),
    );
  }

  function beginSecureInput(id: string, sessionID?: string) {
    return publicSession(requireTerminal().beginSecureInput(id, sessionID));
  }

  function endSecureInput(id: string, sessionID?: string) {
    return publicSession(requireTerminal().endSecureInput(id, sessionID));
  }

  async function stop(
    id: string,
    actor: "model" | "human" | "system",
    sessionID?: string,
  ) {
    return publicSession(await requireTerminal().stop(id, actor, sessionID));
  }

  async function start(input: {
    command: string;
    cwd: string;
    id?: string;
    sessionID?: string;
    agentID?: string;
  }) {
    return publicSession(await requireTerminal().start(input));
  }

  async function write(
    id: string,
    value: string,
    options?: { idempotencyKey?: string; sessionID?: string },
  ) {
    return await requireTerminal().write(id, value, options);
  }

  async function resize(
    id: string,
    rows: number,
    cols: number,
    actor: "model" | "human",
    sessionID?: string,
  ) {
    return publicSession(
      await requireTerminal().resize(id, rows, cols, actor, sessionID),
    );
  }

  async function ttyName(id: string) {
    return await nativeTerminal?.ttyName(id);
  }

  async function snapshot(id: string) {
    return await requireTerminal().snapshot(id);
  }

  async function observe(
    id: string,
    afterRevision: number,
    options?: { maxLines?: number; timeoutMs?: number },
  ) {
    return await requireTerminal().observe(id, afterRevision, options);
  }

  function session(id: string) {
    const { lastObservedText } = requireTerminal().session(id);
    return { lastObservedText };
  }

  function markObserved(id: string, text: string, revision: number) {
    requireTerminal().markObserved(id, text, revision);
  }

  function lastObservedRevision(id: string): number | undefined {
    return requireTerminal().lastObservedRevision(id);
  }

  async function requestHuman(id: string, reason: string, sessionID?: string) {
    return publicSession(
      await requireTerminal().requestHuman(id, reason, sessionID),
    );
  }

  /**
   * I3: the registry's model-visible surface addresses only the active
   * session's panes. Called when a session is established and again on attach.
   */
  function setActiveSession(sessionID: string | undefined) {
    nativeTerminal?.setActiveSession(sessionID);
  }

  async function stopForSession(sessionID: string) {
    await nativeTerminal?.stopForSession(sessionID);
  }

  async function close() {
    if (closed) return;
    closed = true;
    await nativeInputBroker?.stop();
    nativeInputBroker = undefined;
    if (!input.external) await nativeTerminal?.dispose();
    nativeTerminal = undefined;
  }

  return {
    init,
    list,
    reconcile,
    read,
    openHub,
    claimHumanInput,
    releaseHumanControl,
    beginSecureInput,
    endSecureInput,
    stop,
    start,
    write,
    resize,
    snapshot,
    observe,
    session,
    markObserved,
    lastObservedRevision,
    requestHuman,
    ttyName,
    setActiveSession,
    stopForSession,
    close,
  };
}
