/**
 * Steering a subagent from the session that spawned it.
 *
 * `send_message` is the only way a parent talks to a child it is already
 * running. Without it the parent's choices are to wait for the child to finish
 * or to kill it, neither of which is "go left instead of right".
 *
 * The three routings follow the Activation state of the target, because that is
 * what decides whether a message can be read soon, later, or not at all:
 *
 *   running          the child's driver is inside a step, so appending to its
 *                    ledger puts the message in front of the next request
 *   paused           the child is parked but its ledger is live, so the message
 *                    is appended and the child is resumed to read it
 *   no live runner   there is no ledger to append to, so the message is queued
 *                    on the record and delivered when the child next starts
 *
 * The queued case is the reason the record carries messages at all: dropping one
 * on the floor would leave the parent believing it had steered, and nothing
 * downstream would say otherwise.
 */

/** How a steer request was routed. */
export type SteerRoute = "delivered" | "resumed" | "queued";

/**
 * The model-visible content of one parent message.
 *
 * Framed so the child can tell who is speaking: the runtime states the delivery,
 * and the words are the parent's. Collapsing the two would let a child mistake a
 * parent's correction for its own earlier reasoning.
 */
export function parentMessageContent(
  senderID: string,
  agentId: string,
  message: string,
): string {
  return [
    `<runtime_context source="parent_message" trust="parent" agent_id="${agentId}">`,
    `Agent ${senderID} sent a message:`,
    message,
    "This is the agent that delegated your task. Treat it as a correction to " +
      "your current work, not as a new task, unless it says otherwise.",
    `</runtime_context>`,
  ].join("\n");
}

/**
 * Where a message goes, given the target's state.
 *
 * `running` and `paused` both need the child's live ledger; a target with none
 * is the queued case regardless of its recorded status, because a status alone
 * cannot say whether a runner is holding that ledger right now.
 */
export function steerRoute(input: {
  status: string;
  hasLiveLedger: boolean;
}): SteerRoute {
  if (!input.hasLiveLedger) return "queued";
  return input.status === "paused" ? "resumed" : "delivered";
}
