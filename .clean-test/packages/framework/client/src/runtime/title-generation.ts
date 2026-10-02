/**
 * Automatic session titles — runtime/title-generation module.
 *
 * Owns the title-generation task map and the five functions that feed, defer,
 * cancel, apply, and generate a session title. Reads everything it needs from
 * `RuntimeContext` at call time.
 */
import { sessionRunCoordinator } from "@anthelia/session";
import { withProviderConcurrency } from "@anthelia/runtime";
import { sessionStoreController as sessionStoreControllerToken } from "@anthelia/session-store";
import type { SessionID } from "@anthelia/contracts";
import {
  fallbackSessionTitle,
  generateSessionTitle,
  isInvalidGeneratedSessionTitle,
  sanitizeSessionTitleInput,
} from "../session-title";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionStoreController } from "@anthelia/session-store";

export function createTitleGeneration(ctx: RuntimeContext) {
  return {
    rememberTitleInput,
    scheduleTitleGeneration,
    cancelTitleGeneration,
    generateTitleForSession,
  };

  function rememberTitleInput(id: SessionID, text: string) {
    const { titleGenerationTasks } = ctx.state;
    const sanitized = sanitizeSessionTitleInput(text);
    if (sanitized.replace(/\[redacted\]|\[home path\]/gu, "").trim().length < 3)
      return;
    if (!titleGenerationTasks.has(id))
      titleGenerationTasks.set(id, { input: text });
  }

  function scheduleTitleGeneration(id: SessionID) {
    const { titleGenerationTasks } = ctx.state;
    const { isDisposed } = ctx.ports;
    const task = titleGenerationTasks.get(id);
    if (!task || task.timer || task.promise || isDisposed()) return;
    task.timer = setTimeout(() => {
      task.timer = undefined;
      if (isDisposed() || titleGenerationTasks.get(id) !== task) return;
      if (sessionRunCoordinator(id).active) {
        scheduleTitleGeneration(id);
        return;
      }
      const controller = new AbortController();
      task.controller = controller;
      task.promise = generateTitleForSession(id, task.input, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          if (titleGenerationTasks.get(id) === task)
            titleGenerationTasks.delete(id);
        });
    }, 100);
  }

  async function cancelTitleGeneration(id: SessionID) {
    const { titleGenerationTasks } = ctx.state;
    const task = titleGenerationTasks.get(id);
    if (!task) return;
    titleGenerationTasks.delete(id);
    if (task.timer) clearTimeout(task.timer);
    task.controller?.abort(new Error("session title generation cancelled"));
    await task.promise?.catch(() => undefined);
  }

  function applyGeneratedTitle(
    id: SessionID,
    updated: { title: string },
    source: "generated" | "fallback",
  ) {
    const { publishForSession, getExecutionBySession } = ctx.ports;
    const exec = getExecutionBySession().get(id);
    if (exec) {
      exec.session.title = updated.title;
      exec.session.metadata = {
        ...exec.session.metadata,
        titleSource: source,
      };
    }
    publishForSession(exec, {
      type: "session.title.updated",
      sessionID: id,
      title: updated.title,
    });
  }

  async function generateTitleForSession(
    id: SessionID,
    text: string,
    signal: AbortSignal,
  ) {
    const {
      getSessionPersistence,
      getProviderConcurrencyLimiter,
      getExecutionBySession,
    } = ctx.ports;
    const sanitized = sanitizeSessionTitleInput(text);
    if (sanitized.replace(/\[redacted\]|\[home path\]/gu, "").trim().length < 3)
      return;
    const sessionStoreController = ctx.state.serviceDirectory.get(
      sessionStoreControllerToken,
    );
    const loadCurrent = async () =>
      (await sessionStoreController.load(id)).session;
    try {
      await getSessionPersistence();
      const current = await loadCurrent();
      if (
        !current ||
        (current.title !== "New session" &&
          !isInvalidGeneratedSessionTitle(current.title)) ||
        current.metadata?.titleSource === "manual"
      )
        return;
      const titleProvider = getExecutionBySession().get(id)?.provider;
      const titleLimiter = getProviderConcurrencyLimiter();
      const generated = titleProvider
        ? await generateSessionTitle(titleProvider, sanitized, {
            signal,
            stream: (request) =>
              withProviderConcurrency(
                titleLimiter,
                titleProvider.provider,
                () => titleProvider.stream(request),
                request.signal,
              ),
          })
        : "";
      if (signal.aborted) return;
      const title = generated || fallbackSessionTitle(sanitized);
      const source = generated ? "generated" : "fallback";
      const updated = await sessionStoreController.setAutoTitle(
        id,
        title,
        source,
      );
      const committed = await loadCurrent();
      if (
        updated.title === title &&
        committed?.title === title &&
        committed.metadata?.titleSource === source
      )
        applyGeneratedTitle(id, updated, source);
    } catch {
      if (signal.aborted) return;
      const fallback = fallbackSessionTitle(sanitized);
      const updated = await sessionStoreController
        .setAutoTitle(id, fallback, "fallback")
        .catch(() => undefined);
      const committed = await loadCurrent().catch(() => undefined);
      if (
        updated?.title === fallback &&
        committed?.title === fallback &&
        committed.metadata?.titleSource === "fallback"
      )
        applyGeneratedTitle(id, updated, "fallback");
    }
  }
}
