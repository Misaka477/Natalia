/**
 * The fork handoff: what the child is told, and what moves.
 *
 * A fork is a HANDOFF, not a copy. The reference libraries each got one
 * half of it right and the other half wrong for our purpose:
 *
 *   - one inherits the goal but leaves the parent running, so two
 *     sessions pursue the same objective and can take the same action
 *     twice;
 *   - the other inherits the goal but starts the child disarmed, so the
 *     child sits waiting for a human message — which is exactly the
 *     "fork 过去就自动开做" this exists to avoid.
 *
 * So: the goal MOVES. The child is seeded with the parent's view, armed
 * explicitly, and the parent's is closed with a reason. Because `arm`
 * overrides the seed's disarmed default, the human's consent has to cover
 * it — the ask names the move, and the answer records it.
 *
 * Everything here is pure: the plan is computed from facts (is there a
 * goal, is the fork a continuation) and the notice is text. The runtime
 * wiring and the goal service calls are the only impure parts, and they
 * consume this.
 *
 * What the runtime already provides, so this does not re-implement it
 * (each verified in the manager and the contracts):
 *
 *   - N workspaces, each its own runtime client and session store
 *     (`workspace-manager.ts`, one `createRealRuntimeClient` per root);
 *   - session → owning workspace routing (`findWorkspaceForSession`);
 *   - `sessionNew({ workspaceID })` on the RuntimeClient surface.
 *
 * What does NOT exist and is the one new primitive here: seeding a session
 * in ANOTHER workspace's store with this session's events. The target
 * store has no record of the parent, and the client surface has no import.
 */

/** The parent's goal as the handoff sees it. */
export type ForkGoalInput = {
  goalID: string;
  title: string;
  phase: "active" | "paused" | "blocked" | "complete";
  /** Rounds already started, so the child inherits the budget's history. */
  roundsStarted: number;
  revision: number;
};

/** What the handoff does with the goal. */
export type ForkGoalPlan =
  | { kind: "none"; reason: "parent has no goal" }
  | { kind: "move"; goal: ForkGoalInput; parentReason: "handed_off" }
  | {
      kind: "supersede";
      goal: ForkGoalInput;
      parentReason: "superseded_by_fork";
    };

export type ForkPlanInput = {
  /** The parent's live goal, when it has one. */
  goal?: ForkGoalInput;
  /**
   * Whether the fork continues the goal rather than starting a different
   * task. A prompt that is absent, or that the caller marks as the goal's
   * next step, is a continuation; anything else is a different task and
   * the goal must not follow it.
   */
  continuation: boolean;
};

/**
 * Decide what happens to the goal.
 *
 * A complete goal has nothing to move — it is history, not authority. A
 * paused or blocked one still owns the objective, so it moves with the
 * work (the child can resume it); an active one moves and is armed.
 */
export function planGoalMove(input: ForkPlanInput): ForkGoalPlan {
  const goal = input.goal;
  if (!goal) return { kind: "none", reason: "parent has no goal" };
  if (goal.phase === "complete")
    return { kind: "none", reason: "parent has no goal" };
  if (!input.continuation)
    return { kind: "supersede", goal, parentReason: "superseded_by_fork" };
  return { kind: "move", goal, parentReason: "handed_off" };
}

/** Whether the child's goal starts armed (pursued without a human nudge). */
export function childGoalArmed(plan: ForkGoalPlan): boolean {
  return plan.kind === "move";
}

export type ForkNoticeInput = {
  /** The session the child was forked from. */
  parentSessionID: string;
  /** The workspace the parent was in — the tree the transcript describes. */
  parentWorkspace: string;
  /** The workspace the child now runs in. */
  childWorkspace: string;
  /** Where the transcript was cut, as a human-readable marker. */
  cutAt: string;
  /** Whether the cut left a tool call whose outcome the child cannot know. */
  unresolvedToolCall?: string;
  goal?: { title: string; moved: boolean };
};

/**
 * The first message the child receives.
 *
 * Four facts, in the order a reader needs them:
 *
 *   1. **where it came from** — so it can reason about its own history;
 *   2. **that the tree changed** — the transcript's file paths describe
 *      the OLD workspace. This is the notice a same-workspace fork does
 *      not need and a cross-workspace one cannot do without: `packages/**`
 *      exists in both trees, so a wrong path is not a missing file, it is
 *      a file with different content — the hardest kind of wrong to see;
 *   3. **the goal's status** — moved and armed, or closed as superseded,
 *      so the child never assumes authority it does not have;
 *   4. **the unresolved tail** — when the cut landed mid-tool-call, the
 *      outcome is unknowable from here, and retrying blindly is how a
 *      side effect happens twice.
 */
export function buildForkNotice(input: ForkNoticeInput): string {
  const lines = [
    "<fork-notice>",
    `This session was forked from ${input.parentSessionID} at ${input.cutAt}.`,
    `Everything above this notice is inherited context: it describes the work as it stood in workspace ${input.parentWorkspace}.`,
  ];
  if (input.parentWorkspace !== input.childWorkspace)
    lines.push(
      `YOU ARE NOW IN A DIFFERENT WORKSPACE: ${input.childWorkspace}. ` +
        `File paths in the inherited context refer to ${input.parentWorkspace}. ` +
        `The same path may exist here with different content — read before you ` +
        `write, and never assume a file is in the state the transcript last saw ` +
        `it in.`,
    );
  if (input.goal?.moved)
    lines.push(
      `The goal "${input.goal.title}" moved here from the parent session and is ` +
        `now ARMED: pursue it without waiting for a human message. The parent ` +
        `session's goal was closed as handed off — do not expect it to continue ` +
        `the work.`,
    );
  else if (input.goal)
    lines.push(
      `The parent session's goal "${input.goal.title}" was closed as superseded ` +
        `by this fork. It did NOT move here; your task is the prompt you were ` +
        `given, not that goal.`,
    );
  if (input.unresolvedToolCall)
    lines.push(
      `The inherited history records a tool call (${input.unresolvedToolCall}) ` +
        `whose outcome is not in this session's log: the parent may have ` +
        `completed it after the fork point. Decide whether to retry from the ` +
        `tool's own semantics — retry only if it is read-only or idempotent; if ` +
        `it may have side effects, verify the external state first or ask the ` +
        `user. Do not retry blindly.`,
    );
  lines.push("</fork-notice>");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * The spawn request — the contract between the tool and the manager
 * ------------------------------------------------------------------ */

/**
 * Where the child runs.
 *
 * A path is resolved against the manager's registry and REGISTERED when
 * absent, so the caller names a tree it knows rather than an id it has to
 * look up. An id is passed through.
 */
export type SessionSpawnTarget =
  | { kind: "path"; path: string; title?: string }
  | { kind: "workspaceID"; workspaceID: string };

/**
 * What the child inherits from the parent, beyond the transcript.
 *
 * The permission fields are the parent's OWN settings, carried explicitly
 * rather than read from the target workspace: the human consented to this
 * work with this authority, so the consent has to travel with the work.
 * A workspace's own settings are a posture for a tree, not for a handoff.
 */
export type SessionSpawnInherit = {
  permissionMode?: "ask" | "auto" | "read_only";
  permissionProfile?: string;
};

export type SessionSpawnRequest = {
  target: SessionSpawnTarget;
  /** The inherited context, cut at a stable turn. */
  seed: {
    /** The parent's events, in order, up to the cut. */
    events: unknown[];
    /** Where the cut was, as a marker the notice can quote. */
    cutAt: string;
    /** A tool call whose outcome the parent's log does not contain. */
    unresolvedToolCall?: string;
  };
  inherit: SessionSpawnInherit;
  /** The first turn, submitted immediately so the child starts unprompted. */
  prompt: string;
  title?: string;
  goal?: ForkGoalInput;
  /** Whether the prompt continues the goal (see planGoalMove). */
  goalContinuation: boolean;
  parent: {
    sessionID: string;
    workspaceRoot: string;
  };
};

export type SessionSpawnResult = {
  sessionID: string;
  workspaceID: string;
  workspaceRoot: string;
  /** Whether the target had to be registered. */
  registered: boolean;
  /** The goal's fate, so the caller can report it without re-deriving it. */
  goal: ForkGoalPlan;
  /** The notice the child received as its first message. */
  notice: string;
  /** The authority the child runs under, inherited from the parent. */
  inherited: SessionSpawnInherit;
  /** Whether the child's goal was armed. */
  goalArmed: boolean;
};
