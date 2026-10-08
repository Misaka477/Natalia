/**
 * The interactive question tool family, as a separately packaged family.
 *
 * Depends on the framework only for the tool-authoring surface (`RuntimeTool`,
 * `ToolFamily`, the argument helpers) and knows nothing about the runtime, the
 * capability kernel or the host that loads it. The actual question channel is
 * the host's: this tool calls the interactive channel the host provides on the
 * tool context, and fails cleanly when none exists.
 */
import {
  optionalString,
  requireObject,
  requireString,
  type RuntimeTool,
  type ToolFamily,
} from "@anthelia/tools";
import type { Plugin, PluginManifest } from "@anthelia/plugin";

export const ASK_PLUGIN_ID = "natalia-tool-ask";

/** The Q&A facts: the question and choices from the call, the answers from the result. */
function askFacts(
  args: unknown,
  value: string,
): { question: string; options: string[]; answers: string[] } {
  const parsed =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const options = Array.isArray(parsed.options)
    ? parsed.options.map(String)
    : [];
  let answers: string[] = [];
  try {
    const decoded = JSON.parse(value) as { answers?: unknown };
    if (Array.isArray(decoded?.answers))
      answers = decoded.answers.map((answer) =>
        Array.isArray(answer) ? answer.map(String).join(", ") : String(answer),
      );
  } catch {
    // The envelope is the fallback text.
  }
  return { question: String(parsed.question ?? ""), options, answers };
}

function askUserTool(): RuntimeTool {
  return {
    name: "ask_user",
    description:
      "Ask the user a structured question and wait for their answer. " +
      "Use when a decision depends on the user's preference, intent, or approval; " +
      "do not guess on user-facing choices.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            'Short heading for the question, such as "Confirm" or "Choose Mode".',
        },
        question: {
          type: "string",
          description: "The specific question to put to the user.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            'The choices to offer. Put the recommended one first and append "(Recommended)" to its label.',
        },
        multiple: {
          type: "boolean",
          description:
            "Whether the user may select more than one option. Defaults to false.",
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          answers: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
          },
        },
        required: ["answers"],
        additionalProperties: false,
      },
      presentCall(args) {
        return {
          kind: "generic",
          title: requireObject(args).question as string,
          summary: "ask",
        };
      },
      presentationMeta(args, value) {
        return askFacts(args, value) as Record<string, unknown>;
      },
      presentResult(args, value, meta) {
        // The Q&A, composed HERE — the presenter already holds the call's
        // arguments (the question and the choices) and the result (the
        // answers), so the card is complete without the UI deriving
        // anything. The previous design pushed that composition into the
        // kit's keyed-card layer, which had to re-plumb the arguments
        // through the row model — the chain the user watched fail for a
        // day. One layer, one owner.
        //
        // R4: the Q&A rides as the card's STRUCTURED fields (dsh's
        // AskQuestionCard), so a client draws it rather than parsing a
        // transcript body. The transcript stays as the generic body for a
        // client that has not caught up — and the keyed kit card reads the
        // fields first.
        const facts = (meta ?? askFacts(args, value)) as {
          question: string;
          options: string[];
          answers: string[];
        };
        const transcript = [
          `Q: ${facts.question}`,
          ...(facts.options.length
            ? ["Options:", ...facts.options.map((option) => `  · ${option}`)]
            : []),
          facts.answers.length
            ? `A: ${facts.answers.join("; ")}`
            : "A: (no answer recorded)",
        ].join("\n");
        return {
          kind: "generic",
          title: facts.question,
          summary: "answered",
          // dsh's AskQuestionCard shape: the question on its own line, each
          // choice on ITS OWN line (the user's 2026-10-07 report — the old
          // `Options: a · b · c` spelling crammed five choices into one
          // unreadable line), and the answer last.
          question: facts.question,
          options: facts.options,
          answers: facts.answers,
          body: transcript,
        };
      },
    },
    async execute(input, context) {
      if (!context.askQuestion)
        throw new Error("interactive question channel unavailable");
      const args = requireObject(input);
      if (!Array.isArray(args.options))
        throw new Error("options must be an array");
      const options = args.options.map((item) => {
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          const label =
            record.label ??
            record.text ??
            record.value ??
            JSON.stringify(record);
          return { label: String(label) };
        }
        return { label: String(item) };
      });
      const answers = await context.askQuestion({
        title: optionalString(args.title) ?? "Question from Natalia",
        questions: [
          {
            id: "question_0",
            header: "Question",
            question: requireString(args.question, "question"),
            options,
            multiple: args.multiple === true,
            custom: true,
          },
        ],
      });
      return JSON.stringify({ answers }, null, 2);
    },
  };
}

export const askTools: RuntimeTool[] = [askUserTool()];

/**
 * Session scope: the question only makes sense for as long as the interactive
 * channel this session is attached to exists.
 */
export function askToolFamily(): ToolFamily {
  return {
    id: "ask",
    name: "Interactive Question Tools",
    version: "1.0.0",
    description: "Asking the user a structured question.",
    scope: "session",
    tools: askTools,
  };
}

export const ASK_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: ASK_PLUGIN_ID,
  version: "1.0.0",
  name: "Interactive Question Tools",
  description: "Asking the user a structured question.",
  entry: "index.js",
  scope: "session",
  provides: [],
  requires: [],
  optionalRequires: [],
  conflicts: [],
  dependencies: [],
  hooks: {},
  integrationPoints: ["tools"],
};

export function createAskPlugin(): Plugin {
  return {
    manifest: ASK_PLUGIN_MANIFEST,
    setup(api) {
      for (const tool of askTools) api.tools.register(tool);
    },
  };
}
