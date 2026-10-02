export {
  createSkillsPlugin,
  SKILLS_PLUGIN_ID,
  SKILLS_PLUGIN_MANIFEST,
} from "./skills-plugin";
export {
  authorizeSkillTool,
  createSkillLoadTool,
  discoverSkills,
  readSkillResource,
  runSkillScript,
  type Skill,
  type SkillRegistry,
} from "./skills";
import type { SessionID } from "@anthelia/contracts";
import type { Plugin, PluginAPI } from "@anthelia/plugin";
import type { ToolExecutionContext } from "@anthelia/tools";
import { createSkillsPlugin, SKILLS_PLUGIN_MANIFEST } from "./skills-plugin";
import { skillsInput } from "@anthelia/runtime-services";
import type { Skill } from "./skills";

export type SkillsRuntimeInput = {
  workspaceRoot: string;
  userRoot?: string;
  remoteURLs?: string[];
  onLoad?: (
    skill: Skill,
    output: string,
    context: ToolExecutionContext,
  ) => void;
  commandSession?: {
    active(sessionID: SessionID): Skill | undefined;
    activate(sessionID: SessionID, skill: Skill): void;
  };
};

export default function skillsPlugin(): Plugin {
  let instance: Plugin | undefined;
  return {
    manifest: {
      ...SKILLS_PLUGIN_MANIFEST,
      entry: "index.js",
      requires: [skillsInput.id],
    },
    async setup(api: PluginAPI) {
      const input = api.services.get<SkillsRuntimeInput>(skillsInput.id);
      if (!input) throw new Error(`missing runtime service: ${skillsInput.id}`);
      instance = createSkillsPlugin(input);
      await instance.setup(api);
    },
    async dispose() {
      await instance?.dispose?.();
      instance = undefined;
    },
  };
}
