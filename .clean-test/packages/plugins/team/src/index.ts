export {
  LEAD_REVIEWER_SYSTEM_PROMPT,
  ORCHESTRATOR_SYSTEM_PROMPT,
  sandboxedSubagentSystemPrompt,
  TEAM_MODE_DIRECTIVE,
} from "./agent-team-prompts";
export {
  prSettlementReason,
  reviewPRs,
  runFanOut,
  validateOwnershipMap,
  type FanOutPR,
  type FanOutTask,
  type PRReviewDecision,
  type PRReviewOutcome,
} from "./fan-out";
export {
  createTeamPlugin,
  TEAM_PLUGIN_ID,
  TEAM_PLUGIN_MANIFEST,
} from "./team-plugin";
export { createTeamFanoutTool, createTeamReviewTool } from "./team-tools";
import { createTeamPlugin } from "./team-plugin";

export default createTeamPlugin();
