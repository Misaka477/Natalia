/**
 * The four permission rungs, as the one table both the selector and the
 * writer read.
 *
 * The user's model, in their words: there are exactly four rungs, and a rung is
 * a PAIR — the approval axis (who asks) and the sandbox scope (how far a write
 * may reach). The product already keeps those axes apart
 * (`agentModeSchema.approval`, `confinementConfigSchema.mode`), and
 * `sandbox-rung.ts` already names the same ladder for the model's benefit
 * ("1 read-only / 2 ask / 3 workspace-write / 4 full"). What was missing is a
 * selector that offers all four: the control listed the config's three agent
 * modes and wrote only the approval half, so "auto in the workspace" and "auto
 * everywhere" could not be told apart, let alone chosen.
 *
 *   read          approval read_only  + confinement read-only
 *                 nothing may be written anywhere; reading is unrestricted
 *   ask           approval ask        + confinement workspace-write
 *                 every write asks; inside the workspace the model may request
 *                 a wider sandbox, and one approval grants ONE action
 *   auto          approval auto       + confinement workspace-write
 *                 in-workspace writes are automatic, outside is refused
 *   auto-system   approval auto       + confinement danger-full-access
 *                 writes anywhere are automatic and nothing asks
 *
 * `ask` needs the `ask` agent mode and `auto` the `auto` one, so a config that
 * is missing a mode cannot offer that rung — the selector hides what it cannot
 * actually write rather than offering a lie (see `availableRungs`).
 */
import type { ConfinementMode } from "@anthelia/contracts";

export type PermissionRungID = "read" | "ask" | "auto" | "auto-system";

export type PermissionRung = {
  id: PermissionRungID;
  /** What the selector shows. */
  label: string;
  /** The agent mode the approval axis needs, by its config name. */
  agentMode: string;
  approval: "ask" | "auto" | "read_only";
  /** The sandbox scope the write axis gets. */
  confinement: ConfinementMode;
  /** One line the control can carry as a tooltip. */
  meaning: string;
};

export const PERMISSION_RUNGS: readonly PermissionRung[] = [
  {
    id: "read",
    label: "read",
    agentMode: "read_only",
    approval: "read_only",
    confinement: "read-only",
    meaning: "只读：全系统可读，任何写入都被拒（无沙箱）",
  },
  {
    id: "ask",
    label: "ask",
    agentMode: "ask",
    approval: "ask",
    confinement: "workspace-write",
    meaning: "工作区沙箱；每次写入都要问；模型可申请提权，同意一次只放行一次",
  },
  {
    id: "auto",
    label: "auto（工作区）",
    agentMode: "auto",
    approval: "auto",
    confinement: "workspace-write",
    meaning: "工作区内写入自动放行；区外一律拒绝",
  },
  {
    id: "auto-system",
    label: "auto（系统）",
    agentMode: "auto",
    approval: "auto",
    confinement: "danger-full-access",
    meaning: "任何位置写入都自动放行，无沙箱、不问",
  },
] as const;

/** The rung a pair of axes stands for, or undefined for a combination that is
 *  not one of the four (a hand-edited config, a legacy value). */
export function rungFor(input: {
  approval: "ask" | "auto" | "read_only";
  confinement: ConfinementMode;
}): PermissionRung | undefined {
  return PERMISSION_RUNGS.find(
    (rung) =>
      rung.approval === input.approval &&
      rung.confinement === input.confinement,
  );
}

/**
 * The rung the CONFIG stands for: the approval axis by its agent-mode name
 * (that is what `defaultAgentMode` holds) and the sandbox axis by the mode in
 * effect. `undefined` when the pair is not one of the four.
 *
 * The sandbox side is the deployment's — the composition profile's row wins
 * over the config inside the runtime, so a profile that pins a mode the config
 * does not mention makes this the config's view rather than the effective one
 * until the human moves the rung (which is session-scoped and always applied).
 */
export function rungForConfig(input: {
  agentMode?: string | undefined;
  confinement?: ConfinementMode | undefined;
}): PermissionRung | undefined {
  const mode = input.confinement ?? "workspace-write";
  return PERMISSION_RUNGS.find(
    (rung) => rung.agentMode === input.agentMode && rung.confinement === mode,
  );
}

/**
 * The rungs a config can actually be moved to: the rung's agent mode must
 * exist, or choosing it would write a mode the runtime cannot resolve.
 */
export function availableRungs(
  agentModes: Record<string, unknown> | undefined,
): PermissionRung[] {
  const names = new Set(Object.keys(agentModes ?? {}));
  return PERMISSION_RUNGS.filter((rung) => names.has(rung.agentMode));
}
