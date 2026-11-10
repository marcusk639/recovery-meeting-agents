import { mcpName } from "../../tools/server.js";
import { type AgentSpec, TEAM_PLUGIN_NAME } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Reads meetings off a source's public web pages and submits them with verbatim evidence. Use for html-pages sources. Give it the source id and any URLs to start from.",
  model: "sonnet",
  maxTurns: 60,
  tools: [
    mcpName("list_sources"),
    mcpName("fetch_page"),
    mcpName("read_snapshot"),
    mcpName("submit_candidates"),
  ],
  skills: [`${TEAM_PLUGIN_NAME}:meeting-extraction`],
  promptFile: new URL("./prompt.md", import.meta.url),
};
