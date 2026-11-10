import { mcpName } from "../../tools/server.js";
import { type AgentSpec, TEAM_PLUGIN_NAME } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Independently checks page-extracted meetings against the stored page and records a verdict on each. Only confirmed meetings can be published. Use after any page extraction.",
  // Judge tier, and no route to the extractor's reasoning: it sees the page and the claim.
  model: "opus",
  maxTurns: 60,
  tools: [
    mcpName("list_pending"),
    mcpName("read_snapshot"),
    mcpName("record_verdict"),
  ],
  skills: [`${TEAM_PLUGIN_NAME}:meeting-verification`],
  promptFile: new URL("./prompt.md", import.meta.url),
};
