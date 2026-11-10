import { mcpName } from "../../tools/server.js";
import { type AgentSpec, TEAM_PLUGIN_NAME } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Finds official meeting directories for a fellowship in a region and proposes them as sources. Use when a fellowship or region has no usable source yet.",
  model: "sonnet",
  maxTurns: 40,
  tools: [
    "WebSearch",
    mcpName("list_sources"),
    mcpName("register_source"),
    mcpName("fetch_page"),
    mcpName("crawl_site"),
  ],
  skills: [`${TEAM_PLUGIN_NAME}:fellowship-sources`],
  promptFile: new URL("./prompt.md", import.meta.url),
};
