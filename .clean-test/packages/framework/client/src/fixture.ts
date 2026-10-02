import { createHash } from "node:crypto";
import type {
  ApprovalResponse,
  FakeBackend,
  QuestionResponse,
  RuntimeEvent,
  SessionID,
  SubmittedTurn,
} from "@anthelia/contracts";

export function createFakeBackend(): FakeBackend {
  const sessionID: SessionID = "ses_m0_spike";
  let sink: ((event: RuntimeEvent) => void) | undefined;
  let activeTurn: string | undefined;
  let submission: SubmittedTurn | undefined;
  const cancelled = new Set<string>();
  const publish = (event: RuntimeEvent) => sink?.(event);
  const checkActive = (id: string) => activeTurn === id;
  const publishStatusSnapshot = (detail = "fixture") =>
    publish({
      type: "status.snapshot",
      model: "gpt-5.5 fixture",
      provider: "fake",
      context: "12.5k/200k 6%",
      step: activeTurn ? "1/1000" : "idle",
      permissions: "read-only placeholder",
      cwd: process.cwd(),
      background: detail,
    });

  async function shortResponse(id: string) {
    const startedAt = Date.now();
    publish({
      type: "status.update",
      status: "thinking",
      detail: "streaming fixture",
    });
    for (const chunk of [
      "分析输入完整性",
      "，准备展示工具占位",
      "，生成最终内容。",
    ]) {
      await Bun.sleep(15);
      if (!checkActive(id)) return;
      publish({ type: "thinking.delta", id, text: chunk, visible: true });
    }
    publish({ type: "thinking.done", id });
    publishStatusSnapshot("thinking complete");
    publish({
      type: "tool.update",
      id,
      name: "fake_snapshot",
      callID: "snapshot_1",
      status: "receiving_arguments",
      summary: "collecting arguments",
      argumentsDelta: '{"path":"apps/tui","apiToken":"secret-value",',
      metadata: { kind: "generic" },
      startedAt,
    });
    await Bun.sleep(5);
    publish({
      type: "tool.update",
      id,
      name: "fake_snapshot",
      callID: "snapshot_1",
      status: "queued",
      summary: "queued after complete arguments",
      argumentsDelta: '"limit":20}',
      metadata: { kind: "generic" },
      startedAt,
    });
    await Bun.sleep(15);
    publish({
      type: "tool.update",
      id,
      name: "fake_snapshot",
      callID: "snapshot_1",
      status: "awaiting_approval",
      summary: "waiting for M7 approval modal",
      metadata: { kind: "generic" },
      startedAt,
    });
    publish({
      type: "approval.request",
      id: "apr_m0",
      title: "Approve workspace snapshot?",
      preview: "fake_snapshot would inspect workspace state",
      detail:
        "fake_snapshot\n- reads apps/tui/src\n- collects test metadata\n- never sends secrets\n\nThis is a M7 fixture detail pager.",
      keyArguments: ["path=apps/tui", "limit=20"],
      sensitive: false,
    });
    publish({
      type: "question.request",
      id: "q_m0",
      title: "Question fixture",
      questions: [
        {
          id: "format",
          header: "Format",
          question: "Choose response format",
          options: [
            { label: "继续", description: "Continue with markdown output" },
            { label: "取消", description: "Stop the fake fixture" },
          ],
          custom: true,
        },
        {
          id: "checks",
          header: "Checks",
          question: "Select validation checks",
          multiple: true,
          options: [
            { label: "format", description: "Run format check" },
            { label: "typecheck", description: "Run TypeScript check" },
            { label: "smoke", description: "Run terminal smoke" },
          ],
          custom: true,
        },
      ],
    });
    publish({
      type: "tool.update",
      id,
      name: "fake_snapshot",
      callID: "snapshot_1",
      status: "running",
      summary: "running after placeholder approval",
      metadata: { kind: "generic" },
      startedAt,
    });
    publish({
      type: "tool.update",
      id,
      name: "fake_snapshot",
      callID: "snapshot_1",
      status: "succeeded",
      summary: "snapshot fixture ready",
      result:
        "workspace: apps/tui\nfiles: src/context/state.tsx, src/routes/session/SessionRoute.tsx\n安全字段已脱敏。\n".repeat(
          12,
        ),
      metadata: { kind: "generic" },
      startedAt,
      endedAt: Date.now(),
    });
    for (const chunk of [
      "# Streaming final\n\n- 收到 ",
      `${submission!.byteLength} bytes`,
      "，SHA-256 已验证。\n\n```ts\nconst ok = ",
      "true;\n```\n\n这是 final content，包含 CJK、emoji 🙂 和 e\u0301。",
    ]) {
      publish({ type: "content.delta", id, text: chunk });
    }
    publish({ type: "content.done", id });
    publishStatusSnapshot("final streamed");
  }

  async function longResponse(id: string) {
    publish({
      type: "status.update",
      status: "thinking",
      detail: "generating long test output",
    });
    const thinkingParas = [
      "正在分析输入内容的结构和语义特征。",
      "检测到测试指令，将生成包含多段思考、多次工具调用和大量最终内容的输出。",
      "第一步：识别输入中的关键信息点。",
      "第二步：按优先级排序需要处理的任务。",
      "第三步：构建处理策略和工具调用序列。",
      "第四步：验证各步骤的前置条件和依赖关系。",
      "第五步：整体方案确认，开始执行。",
    ];
    for (const para of thinkingParas) {
      if (!checkActive(id)) return;
      publish({ type: "thinking.delta", id, text: para + "\n\n" });
      await Bun.sleep(40);
    }
    publish({ type: "thinking.done", id });

    for (let toolIndex = 0; toolIndex < 8; toolIndex++) {
      if (!checkActive(id)) return;
      const toolName = [
        "apply_edits",
        "todowrite",
        "run_shell",
        "background_process",
        "task",
        "pty_session",
        "sandbox_diff",
        "skill",
      ][toolIndex];
      const startedAt = Date.now();
      publish({
        type: "tool.update",
        id,
        name: toolName,
        callID: `${toolName}_${toolIndex}`,
        status: "receiving_arguments",
        summary: `receiving ${toolName} arguments`,
        argumentsDelta: JSON.stringify({
          target: "apps/tui",
          index: toolIndex,
        }),
        metadata: { kind: toolName },
        startedAt,
      });
      await Bun.sleep(10);
      publish({
        type: "tool.update",
        id,
        name: toolName,
        callID: `${toolName}_${toolIndex}`,
        status: "running",
        summary: `executing ${toolName} on workspace`,
        metadata: { kind: toolName },
        startedAt,
      });
      await Bun.sleep(30);
      publish({
        type: "tool.update",
        id,
        name: toolName,
        callID: `${toolName}_${toolIndex}`,
        status: "succeeded",
        summary: `${toolName} completed (${Math.floor(Math.random() * 50) + 10} results)`,
        result:
          toolName === "apply_edits"
            ? `--- a/apps/tui/src/routes/session/SessionRoute.tsx\n+++ b/apps/tui/src/routes/session/SessionRoute.tsx\n@@ -339,6 +339,10 @@\n function ToolBlockView(props: {\n   block: MessageBlock;\n-  toolDetails: TuiPreferences["toolDetails"];\n+  toolDetails: TuiPreferences["toolDetails"];\n+  diffStyle: TuiPreferences["diffStyle"];\n+  terminalWidth: number;\n }) {\n+  // Native split diff rendering follows terminal width.\n   const tool = () => props.block.tool!;\n`
            : `${toolName} result summary\n`.repeat(18),
        metadata: { kind: toolName },
        startedAt,
        endedAt: Date.now(),
      });
      await Bun.sleep(20);
    }

    publish({
      type: "approval.request",
      id: "apr_long",
      title: "Approve batch file edit?",
      preview: "This would modify 3 files in the workspace.",
      detail:
        "diff -- fake\n--- a/apps/tui/src/dialog/DialogLayer.tsx\n+++ b/apps/tui/src/dialog/DialogLayer.tsx\n@@\n+ modal framework fixture\n",
      keyArguments: ["files=3", "risk=medium"],
    });
    publish({
      type: "question.request",
      id: "q_long",
      title: "Select output format",
      options: ["plain text", "markdown", "json"],
    });

    publish({
      type: "status.update",
      status: "streaming",
      detail: "writing final output",
    });

    const line =
      "这是超长输出测试内容。OpenTUI 需要稳定处理持续流式内容，包含中文、English、emoji 🙂 和组合字符 e\u0301。";
    const paragraph = Array.from(
      { length: 8 },
      (_, i) => `第 ${i + 1} 段：${line}`,
    ).join("\n\n");
    const totalLines = 160;

    for (let lineIndex = 0; lineIndex < totalLines; lineIndex++) {
      if (!checkActive(id)) return;
      const chunk = `[${lineIndex + 1}/${totalLines}] ${paragraph}\n\n`;
      publish({ type: "content.delta", id, text: chunk });
      await Bun.sleep(lineIndex % 16 === 0 ? 12 : 2);
    }
    publish({ type: "content.done", id });

    publishStatusSnapshot("long final streamed");

    publish({
      type: "snapshot.created",
      id: "snap_long",
      files: [
        "apps/tui/src",
        "apps/tui/test",
        ".kilo/plans/execution/m05-shell-editor.zh-CN.md",
      ],
    });

    publish({
      type: "status.update",
      status: "ready",
      detail: `long output test complete (~${totalLines} blocks)`,
    });
  }

  async function retryResponse(id: string) {
    publish({
      type: "status.update",
      status: "thinking",
      detail: "retry fixture first attempt",
    });
    publish({
      type: "content.delta",
      id,
      attempt: 1,
      text: "# Retry demo\n\npartial duplicate",
    });
    const waitMs = 1200;
    publish({
      type: "step.retry",
      id,
      operation: "llm_step",
      step: 1,
      attempt: 2,
      maxAttempts: 3,
      reason: "timeout",
      waitMs,
    });
    await Bun.sleep(waitMs);
    publish({
      type: "content.delta",
      id,
      attempt: 2,
      text: "# Retry demo\n\npartial duplicate",
    });
    publish({
      type: "content.delta",
      id,
      attempt: 2,
      text: " content committed once.\n",
    });
    publish({ type: "content.done", id, attempt: 2 });
    publish({
      type: "step.retry.cleared",
      id,
      operation: "llm_step",
      step: 1,
      attempts: 2,
    });
  }

  async function compactResponse(id: string, text: string) {
    const instruction = text.replace(/^\/compact\s*/i, "").trim() || undefined;
    publish({
      type: "context.status",
      used: 172000,
      max: 200000,
      source: "pending_estimate",
      thresholdPercent: 85,
      reserved: 50000,
      trigger: instruction ? "manual" : "ratio",
    });
    publish({
      type: "compaction.begin",
      id: `cmp_${id}`,
      trigger: "manual",
      beforeTokens: 172000,
      maxTokens: 200000,
      thresholdPercent: 85,
      reservedTokens: 50000,
      instruction,
      attempt: 1,
      startedAt: new Date().toISOString(),
    });
    await Bun.sleep(100);
    publish({
      type: "step.retry",
      id: `cmp_${id}`,
      operation: "compaction",
      step: 0,
      attempt: 2,
      maxAttempts: 3,
      waitMs: 300,
      reason: "timeout",
    });
    await Bun.sleep(300);
    publish({
      type: "step.retry.cleared",
      id: `cmp_${id}`,
      operation: "compaction",
      step: 0,
      attempts: 2,
    });
    publish({
      type: "compaction.end",
      id: `cmp_${id}`,
      trigger: "manual",
      success: true,
      beforeTokens: 172000,
      afterTokens: 43000,
      durationMs: 400,
      attempts: 2,
    });
    publish({
      type: "context.status",
      used: 43000,
      max: 200000,
      source: "compaction_estimate",
      thresholdPercent: 85,
      reserved: 50000,
    });
    publish({
      type: "content.delta",
      id,
      text: "Compaction fixture complete.\n",
    });
    publish({ type: "content.done", id });
  }

  async function checkpointResponse(id: string, text: string) {
    const command = text.trim().toLowerCase();
    if (command.startsWith("/checkpoints")) {
      publish({
        type: "content.delta",
        id,
        text: "checkpoint_0 step=0 reason=baseline files=3 changes=0 tokens=128 complete\ncheckpoint_1 step=2 reason=manual files=4 changes=1 tokens=512 complete",
      });
      publish({ type: "content.done", id });
      return;
    }
    if (command.startsWith("/checkpoint")) {
      publish({
        type: "checkpoint.created",
        id: "checkpoint_1",
        reason: "manual",
        sequence: 1,
        complete: true,
        files: 4,
        changes: 1,
        contextJournalOffset: 6,
        step: 2,
        tokenEstimate: 512,
        diskUsageBytes: 4096,
      });
      publish({
        type: "content.delta",
        id,
        text: "Created checkpoint_1 with durable workspace + context snapshot.",
      });
      publish({ type: "content.done", id });
      return;
    }
    if (command.startsWith("/rollback")) {
      const dryRun = command.includes("--dry-run");
      const checkpointID = command.includes("last")
        ? "checkpoint_1"
        : "checkpoint_0";
      publish({
        type: "rollback.previewed",
        preview: {
          checkpointID,
          dryRun,
          changes: [{ kind: "delete", path: "test_example.py" }],
          context: {
            truncateMessages: 3,
            targetJournalOffset: 1,
            targetStep: 0,
            targetTokens: 128,
            compactionGeneration: 0,
          },
          resources: [
            {
              kind: "terminal",
              id: "terminal_m11",
              action: "stop",
              summary: "running terminal cannot time travel",
            },
            {
              kind: "workflow",
              id: "wf_fixture",
              action: "invalidate",
              summary: "pending workflow modal invalidated",
            },
          ],
          ignoredFiles: 1,
          diskUsageBytes: 4096,
          complete: true,
          warnings: [],
        },
      });
      if (!dryRun) {
        publish({
          type: "rollback.begin",
          checkpointID,
          safetyCheckpointID: "checkpoint_2",
        });
        publish({
          type: "rollback.end",
          checkpointID,
          safetyCheckpointID: "checkpoint_2",
          restoredFiles: 3,
          deletedFiles: 1,
          contextJournalOffset: 1,
          step: 0,
        });
      }
      publish({
        type: "content.delta",
        id,
        text: dryRun
          ? "Rollback dry-run preview rendered. No files changed."
          : "Rollback applied atomically with safety checkpoint checkpoint_2.",
      });
      publish({ type: "content.done", id });
    }
  }

  async function terminalResponse(id: string) {
    const target = {
      kind: "sandbox" as const,
      sandboxID: "box_m11",
      root: "/tmp/kilo/m11-box",
      isolationLevel: "workspace" as const,
    };
    publish({
      type: "terminal.action",
      id: "terminal_m11",
      action: "attach",
      target,
    });
    publish({
      type: "terminal.update",
      id: "terminal_m11",
      command: "bash --noprofile --norc",
      cwd: "/tmp/kilo/m11-box",
      status: "running",
      attached: true,
      rows: 24,
      cols: 80,
      prompt: "$",
      activity: "waiting",
      tail: "Natalia terminal smoke\n$",
      transcript: "Natalia terminal smoke\n$",
      lastAction: "attach",
      target,
    });
    publish({
      type: "terminal.action",
      id: "terminal_m11",
      action: "write",
      redacted: true,
      target,
    });
    publish({
      type: "terminal.update",
      id: "terminal_m11",
      command: "bash --noprofile --norc",
      cwd: "/tmp/kilo/m11-box",
      status: "running",
      attached: true,
      rows: 40,
      cols: 120,
      prompt: "$",
      activity: "waiting",
      tail: "Natalia terminal smoke\n[redacted]\n$",
      transcript: "Natalia terminal smoke\n[redacted]\n$",
      lastAction: "resize",
      target,
    });
    publish({
      type: "content.delta",
      id,
      text: "Terminal fixture complete.\n",
    });
    publish({ type: "content.done", id });
  }

  async function sandboxResponse(id: string) {
    const target = {
      kind: "sandbox" as const,
      sandboxID: "box_m11",
      root: "/tmp/kilo/m11-box",
      isolationLevel: "workspace" as const,
    };
    publish({
      type: "sandbox.update",
      id: "box_m11",
      status: "changed",
      root: "/tmp/kilo/m11-box",
      isolationLevel: "workspace",
      changedFiles: 5,
      runningResources: 1,
      target,
      resourcePolicy: "workspace isolation only; not container/VM security",
    });
    publish({
      type: "sandbox.diff",
      id: "box_m11",
      changes: [
        { kind: "add", path: "new.ts" },
        { kind: "modify", path: "src/app.ts" },
        { kind: "delete", path: "old.ts" },
        { kind: "rename", oldPath: "a.ts", path: "b.ts" },
        { kind: "mode", path: "script.sh", mode: "100755" },
      ],
    });
    publish({
      type: "sandbox.audit",
      id: "box_m11",
      action: "skill-script",
      target,
      approvalRequired: true,
      checkpointPolicy: "sandbox_manifest",
      message: "Skill/workflow activity in sandbox still requires approval.",
    });
    publish({ type: "content.delta", id, text: "Sandbox fixture complete.\n" });
    publish({ type: "content.done", id });
  }

  async function modalResponse(id: string) {
    publish({
      type: "status.update",
      status: "awaiting input",
      detail: "modal queue fixture",
    });
    publish({
      type: "question.request",
      id: "q_modal_first",
      title: "Queued question",
      options: ["alpha", "beta"],
    });
    publish({
      type: "approval.request",
      id: "apr_modal_priority",
      title: "Priority approval",
      preview: "Approval should appear before queued question.",
      detail:
        "This request has higher priority than questions and should be active first.",
      keyArguments: ["priority=approval", "queue=stable"],
    });
    publish({
      type: "question.request",
      id: "q_modal_multi",
      title: "Multi question",
      questions: [
        {
          id: "one",
          header: "One",
          question: "Pick one option",
          options: [{ label: "A" }, { label: "B" }],
          custom: true,
        },
        {
          id: "many",
          header: "Many",
          question: "Pick multiple options",
          options: [{ label: "X" }, { label: "Y" }],
          multiple: true,
          custom: true,
        },
      ],
    });
    publish({ type: "content.delta", id, text: "Modal fixture queued.\n" });
    publish({ type: "content.done", id });
  }

  return {
    async canReloadConfig() {
      return activeTurn
        ? { allowed: false, reason: "fixture turn is running" }
        : { allowed: true };
    },
    async reloadConfig() {
      // The precheck says "allowed" because nothing is running; the action says
      // "nothing to apply" because a fixture has no configuration on disk. Two
      // different answers, which is the point of reporting them separately.
      return {
        applied: false,
        reason: "the fixture runtime has no configuration on disk",
      };
    },
    start(onEvent) {
      sink = onEvent;
      publish({
        type: "session.created",
        sessionID,
        title: "M7 Natalia TUI modals",
      });
      publish({
        type: "status.update",
        status: "ready",
        detail: "fake backend connected",
      });
      publish({ type: "session.ready", sessionID });
      publishStatusSnapshot("boot ready");
    },
    async submitAndWait(input) {
      return await this.submit(
        typeof input === "string" ? input : (input.text ?? ""),
      );
    },
    async submit(text) {
      const id = `turn_${Date.now().toString(36)}`;
      activeTurn = id;
      submission = {
        type: "turn.submitted",
        id,
        text,
        byteLength: new TextEncoder().encode(text).byteLength,
        lineCount: text.length === 0 ? 1 : text.split("\n").length,
        sha256: createHash("sha256").update(text).digest("hex"),
      };
      publish(submission);
      if (text.trim().toLowerCase().startsWith("/modal")) {
        await modalResponse(id);
      } else if (text.trim().toLowerCase().startsWith("/terminal")) {
        await terminalResponse(id);
      } else if (text.trim().toLowerCase().startsWith("/sandbox")) {
        await sandboxResponse(id);
      } else if (text.trim().toLowerCase().startsWith("/compact")) {
        await compactResponse(id, text);
      } else if (text.trim().toLowerCase().startsWith("/checkpoint")) {
        await checkpointResponse(id, text);
      } else if (text.trim().toLowerCase().startsWith("/checkpoints")) {
        await checkpointResponse(id, text);
      } else if (text.trim().toLowerCase().startsWith("/rollback")) {
        await checkpointResponse(id, text);
      } else if (text.trim().toLowerCase().startsWith("/retry")) {
        await retryResponse(id);
      } else if (text.trim().toLowerCase().startsWith("/long")) {
        await longResponse(id);
      } else {
        await shortResponse(id);
      }
      if (!checkActive(id) || cancelled.has(id)) return submission;
      publish({
        type: "snapshot.created",
        id: "snap_m0",
        files: ["apps/tui", ".kilo/plans/execution/m05-shell-editor.zh-CN.md"],
      });
      publish({
        type: "status.update",
        status: "ready",
        detail: "fake turn finished",
      });
      publish({ type: "turn.finished", id, stopReason: "done" });
      activeTurn = undefined;
      return submission;
    },
    cancel(reason = "user cancel") {
      if (!activeTurn) return;
      const id = activeTurn;
      activeTurn = undefined;
      cancelled.add(id);
      publish({ type: "turn.cancelled", id, reason });
      publish({ type: "turn.finished", id, stopReason: "cancelled" });
      publish({ type: "status.update", status: "ready", detail: "cancelled" });
    },
    snapshot() {
      const event: RuntimeEvent = {
        type: "snapshot.created",
        id: `snap_${Date.now().toString(36)}`,
        files: ["apps/tui/src", "apps/tui/test"],
      };
      publish(event);
      return event;
    },
    diagnostic(message, level = "warning") {
      publish({ type: "diagnostic", level, message });
    },
    lastSubmission() {
      return submission;
    },
    respondApproval(response: ApprovalResponse) {
      publish({
        type: "approval.response",
        id: response.requestID,
        decision: response.decision,
        feedback: response.feedback,
      });
      // The fixture keeps no register of pending requests, so it accepts whatever
      // it is handed. Saying so is the point: a scripted backend that reported
      // refusals it cannot detect would be inventing them.
      return { accepted: true };
    },
    respondQuestion(response: QuestionResponse) {
      publish({
        type: "question.response",
        id: response.requestID,
        answers: response.answers,
        rejected: response.rejected,
      });
      return { accepted: true };
    },
  };
}
