import type { Plugin, PluginManifest } from "@anthelia/plugin";
import {
  createSkillLoadTool,
  discoverSkills,
  installSkill,
  type Skill,
} from "./skills";
import type { ToolExecutionContext } from "@anthelia/tools";
import { skillService } from "@anthelia/runtime-services";
import type { SessionID } from "@anthelia/contracts";
import { join } from "node:path";

export const SKILLS_PLUGIN_ID = "natalia-skills";

export const SKILLS_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: SKILLS_PLUGIN_ID,
  version: "1.0.0",
  name: "Skills",
  description: "Discovered project, user and remote skills.",
  entry: "index.js",
  scope: "workspace",
  provides: [skillService.id],
  requires: [],
  optionalRequires: [],
  conflicts: [],
  dependencies: [],
  hooks: {},
  integrationPoints: ["tools", "commands", "services"],
  ui: {
    entry: "ui/plugin.js",
    panels: [
      {
        id: "skills-settings",
        title: "Skills",
        region: "settings",
        group: "扩展",
      },
    ],
  },
};

export function createSkillsPlugin(input: {
  workspaceRoot: string;
  userRoot?: string;
  remoteURLs?: string[];
  /**
   * The loaded plugins' declared skills directories, read live at each
   * discovery (the controller's catalog is the source; the fingerprint
   * mechanism reloads this plugin when it changes).
   */
  pluginDirs?: () => readonly string[];
  onLoad?: (
    skill: Skill,
    output: string,
    context: ToolExecutionContext,
  ) => void;
  commandSession?: {
    active(sessionID: SessionID): Skill | undefined;
    activate(sessionID: SessionID, skill: Skill): void;
  };
}): Plugin {
  // One discovery shape for setup and every reload: the plugin dirs are
  // read live so an install/uninstall lands on the next discovery.
  async function discover() {
    return await discoverSkills({
      workspaceRoot: input.workspaceRoot,
      ...(input.userRoot ? { userRoot: input.userRoot } : {}),
      ...(input.remoteURLs ? { remoteURLs: input.remoteURLs } : {}),
      ...(input.pluginDirs ? { pluginDirs: input.pluginDirs() } : {}),
    });
  }
  return {
    manifest: SKILLS_PLUGIN_MANIFEST,
    async setup(api) {
      const skills = await discover();
      api.services.provide(skillService.id, skills);
      api.tools.register(
        createSkillLoadTool({ registry: () => skills, onLoad: input.onLoad }),
      );
      api.commands.register({
        name: "skills",
        title: "List skills",
        run() {
          const listing = skills.list();
          return listing.length
            ? listing
                .map((skill) => `${skill.qualifiedName}: ${skill.description}`)
                .join("\n")
            : "no native skills discovered";
        },
      });
      api.commands.register({
        name: "skill-install",
        title: "Install skill",
        async run(invocation) {
          const source = invocation?.args.join(" ").trim();
          if (!source)
            throw new Error("/skill-install requires a local path or URL");
          const result = await installSkill({
            source,
            targetRoot: join(input.workspaceRoot, ".natalia", "skills"),
          });
          await skills.reload({
            workspaceRoot: input.workspaceRoot,
            ...(input.userRoot ? { userRoot: input.userRoot } : {}),
            ...(input.remoteURLs ? { remoteURLs: input.remoteURLs } : {}),
            ...(input.pluginDirs ? { pluginDirs: input.pluginDirs() } : {}),
          });
          return `installed skill${result.installed === 1 ? "" : "s"}: ${result.names.join(", ")}`;
        },
      });
      api.commands.register({
        name: "skill",
        title: "Activate skill",
        run(invocation) {
          const name = invocation?.args.join(" ").trim();
          if (!name) throw new Error("/skill requires a skill name");
          if (!invocation?.sessionID)
            throw new Error("skill activation requires a session");
          const skill = skills.resolve(name);
          input.commandSession?.activate(
            invocation.sessionID as SessionID,
            skill,
          );
          return `activated skill ${skill.qualifiedName}`;
        },
      });
      api.commands.register({
        name: "skill-resource",
        title: "Read skill resource",
        async run(invocation) {
          if (!invocation?.sessionID)
            throw new Error("skill resource requires a session");
          const active = input.commandSession?.active(
            invocation.sessionID as SessionID,
          );
          if (!active) throw new Error("no active skill");
          const path = invocation.args.join(" ").trim();
          if (!path) throw new Error("/skill-resource requires a path");
          return await skills.readResource(active, path);
        },
      });
      api.commands.register({
        name: "skill-script",
        title: "Run skill script",
        async run(invocation) {
          if (!invocation?.sessionID)
            throw new Error("skill script requires a session");
          const active = input.commandSession?.active(
            invocation.sessionID as SessionID,
          );
          if (!active) throw new Error("no active skill");
          const script = invocation.args.join(" ").trim();
          if (!script) throw new Error("/skill-script requires a script");
          const result = await skills.runScript(active, script, {
            signal: invocation.signal,
          });
          return JSON.stringify(result, null, 2);
        },
      });
    },
  };
}
