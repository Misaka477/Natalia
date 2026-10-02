import type { SessionID } from "@anthelia/contracts";
import {
  mcpService,
  sandboxService,
  terminalController,
  type SandboxService,
  type TerminalController,
} from "@anthelia/runtime-services";
import type { RuntimeContext } from "@anthelia/substrate";

export function createPluginLifecycle(ctx: RuntimeContext) {
  async function runPluginLifecyclePostReconcile(
    selectedSkills: Map<SessionID, string> = new Map(),
  ) {
    const terminal = ctx.state.serviceDirectory.getOptional(terminalController);
    const sandbox = ctx.state.serviceDirectory.getOptional(sandboxService);
    const mcp = ctx.state.serviceDirectory.getOptional(mcpService);
    await mcp?.reload();
    await terminal?.init();
    terminal?.setActiveSession(ctx.ports.getSessionID());
    await sandbox?.init();

    const skills = ctx.ports.skillService();
    for (const [id, exec] of ctx.ports.getExecutionBySession()) {
      const qualifiedName = selectedSkills.get(id);
      if (!qualifiedName || !skills) {
        exec.activeSkill = undefined;
        continue;
      }
      try {
        exec.activeSkill = skills.resolve(qualifiedName);
      } catch {
        exec.activeSkill = undefined;
      }
    }
    ctx.ports.setActiveSkill(ctx.ports.getActiveExec()?.activeSkill);
  }

  return { runPluginLifecyclePostReconcile };
}
