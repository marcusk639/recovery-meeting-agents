import { mcpName } from "../../tools/server.js";
import type { AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Collects meetings from structured sources (BMLT regions, Meeting Guide JSON feeds) and reports how each collection went. Use for any source with a feed.",
  // Code does the mapping and the health checks; this role picks regions and reads results.
  model: "haiku",
  maxTurns: 30,
  tools: [
    mcpName("list_sources"),
    mcpName("list_bmlt_regions"),
    mcpName("collect_feed"),
    mcpName("run_status"),
  ],
  promptFile: new URL("./prompt.md", import.meta.url),
};
