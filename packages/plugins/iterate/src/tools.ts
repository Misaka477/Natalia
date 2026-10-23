/**
 * The self-iteration tools.
 *
 * `iterate_branch` is the entry point: one call copies the product's
 * read-only baseline to a path the model chooses, opens a workspace there,
 * seeds a new session with THIS session's journal, moves the goal, and
 * starts the child working on the given prompt. It is deliberately NOT a
 * general "fork to another tree" primitive — the semantics are
 * load-bearing for self-iteration (the goal moves and is armed, the
 * permission travels, the baseline is never written), and a general tool
 * would let a session reach for them where they were never designed.
 *
 * The tool does no work itself: it asks, then delegates to the handoff
 * the host injected, which only the workspace manager can answer. A host
 * without one gets a named refusal.
 */
import {
  optionalString,
  requireObject,
  requireString,
  type RuntimeTool,
} from "@anthelia/tools";
import { createIteratePlugin, ITERATE_PLUGIN_ID } from "./plugin";

function iterateOutput(callSummary: string) {
  return {
    schema: { type: "object", properties: {} } as const,
    presentCall() {
      return { kind: "generic" as const, title: "iterate", summary: callSummary };
    },
    presentResult(_args: unknown, value: string) {
      return {
        kind: "generic" as const,
        title: "iterate",
        summary: callSummary,
        body: value,
      };
    },
  };
}

function iterateBranchTool(): RuntimeTool {
  return {
    name: "iterate_branch",
    description:
      "Self-iteration: copy this product's own source (a read-only baseline) to a path you " +
      "choose, open a workspace there, and start a NEW session carrying THIS session's " +
      "context, permission and goal — which begins working on your prompt immediately. Use " +
      "it when a change must touch the product's own code and the current workspace is not " +
      "the source. After it returns the work belongs to the new session: tell the user to " +
      "switch to it. Do NOT use it to work in another project — for that, use sandbox_create " +
      "in the current workspace.",
    requiresApproval: true,
    timeoutSec: 300,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Where the copy of the source lands. You decide. Must not be the baseline itself, inside it, or a non-empty directory (unless resume). A path under the natalia home is reversible and the uninstaller removes it.",
        },
        prompt: {
          type: "string",
          description: "The first task, submitted into the new session immediately.",
        },
        resume: {
          type: "boolean",
          description: "Continue in an existing tree at `path` instead of copying the baseline.",
        },
        title: { type: "string" },
      },
      required: ["path", "prompt"],
      additionalProperties: false,
    },
    output: iterateOutput("iterate_branch"),
    async execute(input, context) {
      const args = requireObject(input);
      const path = requireString(args.path, "path");
      const prompt = requireString(args.prompt, "prompt");
      const resume = args.resume === true;
      const title = optionalString(args.title);
      const handoff = context.iterateBranch;
      if (!handoff)
        throw new Error(
          "iterate_branch is unavailable in this host: it needs the workspace manager, " +
            "which only a served runtime has (the Natalia Desktop app or `natalia serve`).",
        );

      const result = await handoff(undefined, {
        path,
        prompt,
        ...(resume ? { resume } : {}),
        ...(title ? { title } : {}),
        parentSessionID: context.sessionID ?? "",
        goalContinuation: true,
      });
      return JSON.stringify(
        {
          ok: true,
          sessionID: result.sessionID,
          workspaceID: result.workspaceID,
          workspaceRoot: result.workspaceRoot,
          registered: result.registered,
          ...(result.copiedFrom ? { copiedFrom: result.copiedFrom } : {}),
          goal: result.goal.kind,
          goalArmed: result.goalArmed,
          boundary:
            `the work now belongs to session ${result.sessionID} in workspace ` +
            `${result.workspaceRoot}. YOUR tools operate on the workspace you are in ` +
            `now — do not continue the work here. Tell the user to switch to that ` +
            `session to watch it.`,
          notice: result.notice,
        },
        null,
        2,
      );
    },
  };
}

export const iterateTools: RuntimeTool[] = [iterateBranchTool()];

export function createIterateToolFamily() {
  return {
    id: "iterate",
    name: "Iterate Tools",
    version: "1.0.0",
    description:
      "Self-iteration: copy the product's read-only source to a workspace the model chooses and continue the session's work there.",
    scope: "session" as const,
    tools: iterateTools,
  };
}

export { createIteratePlugin, ITERATE_PLUGIN_ID };
export default createIteratePlugin;
