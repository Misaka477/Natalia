/**
 * The skill lifecycle's runtime face: the protected set's switch and the
 * garbage collector's dry run.
 *
 * The GC's law lives in the Assay domain
 * (`skillGcReport` — pure, unit-tested); what lives here is the wiring it
 * was built waiting for: the usage facts. `skill.activated` events are
 * journaled by the runtime (plugin-assembly.ts), so this face folds them
 * across the workspace's sessions, merges them with the catalog's file
 * facts (bytes, age) and the user's protected set, and hands the assembled
 * entries to the law. The eviction itself stays a human act — this face
 * APPLIES NOTHING.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import type { SessionID } from "@anthelia/contracts";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  skillGcReport,
  skillUsageFromEvents,
  type SkillGcReport,
} from "@natalia/assay";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import { skillService } from "@anthelia/runtime-services";
import { sessionStoreController } from "@anthelia/session-store";

/** One history page's worth of events; the paging bound per session. */
const PAGE_LIMIT = 2000;

type SkillsLifecycleOptions = Pick<RealRuntimeClientOptions, never>;

export function createSkillsLifecycleSurface(
  ctx: RuntimeContext,
  _options: SkillsLifecycleOptions,
) {
  return {
    async skillSetPinned(input: {
      name: string;
      pinned: boolean;
      workspaceID?: string;
    }) {
      await ctx.ports.getReady();
      const services = ctx.state.serviceDirectory.getOptional(skillService);
      if (!services) throw new Error("skill service is unavailable");
      return await services.setPinned(input.name, input.pinned);
    },

    async skillsGc(_input?: { workspaceID?: string }): Promise<SkillGcReport> {
      await ctx.ports.getReady();
      const services = ctx.state.serviceDirectory.getOptional(skillService);
      if (!services) throw new Error("skill service is unavailable");
      const usage = skillUsageFromEvents(await workspaceSkillEvents(ctx));
      const pinned = new Set(services.pinned());
      const entries = services.list().map((skill) => {
        const row = usage.get(skill.name);
        // The file facts: the skill's size (the cost term) and its age (the
        // cold-start clock). The mtime doubles as createdAt — an update
        // restarts the cold-start window, which errs toward keeping a skill
        // longer, never toward evicting one early.
        const stats = statSync(join(skill.root, "SKILL.md"), {
          throwIfNoEntry: false,
        });
        return {
          name: skill.name,
          uses: row?.uses ?? 0,
          successes: row?.successes ?? 0,
          lastUsedAt: row?.lastUsedAt,
          bytes: stats?.size ?? 0,
          createdAt: stats?.mtimeMs ?? Date.now(),
          protected: pinned.has(skill.name),
        };
      });
      return skillGcReport(entries, Date.now());
    },
  };
}

/**
 * Every durable event of the workspace's sessions, paged. The fold reads
 * the whole journal because a skill's usage history is exactly as long as
 * the workspace's memory of it — a window would silently forget the skill
 * that saved the quarter three months ago.
 */
async function workspaceSkillEvents(
  ctx: RuntimeContext,
): Promise<RuntimeEvent[]> {
  const store = ctx.state.serviceDirectory.getOptional(sessionStoreController);
  if (!store) return [];
  const events: RuntimeEvent[] = [];
  for (const session of await store.list()) {
    let after = 0;
    for (;;) {
      const page = await store.history(session.id as SessionID, [], {
        after,
        limit: PAGE_LIMIT,
      });
      for (const entry of page.events) events.push(entry.event);
      if (!page.hasMore || page.events.length === 0) break;
      after = page.events.at(-1)!.seq;
    }
  }
  return events;
}
