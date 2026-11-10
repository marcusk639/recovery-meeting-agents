import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { mcpName } from "../tools/server.js";
import { AGENTS, type TeamRole } from "../team.js";

const DELEGATION_TOOLS = new Set(["Agent", "Task"]);

/** What the Coordinator may do itself: delegate and read status. */
export const COORDINATOR_TOOLS = new Set<string>([
  ...DELEGATION_TOOLS,
  mcpName("list_sources"),
  mcpName("run_status"),
]);

export interface ToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Present only inside a subagent. */
  agentId?: string | undefined;
  agentType?: string | undefined;
}

const isRole = (name: unknown): name is TeamRole =>
  typeof name === "string" && Object.hasOwn(AGENTS, name);

/**
 * The reason a call is refused, or null. Pages are untrusted and agents read them,
 * so what each role can do is enforced here rather than left to its prompt: a
 * steered extractor can't approve its own meetings or reach any other tool.
 */
export function denyReason(call: ToolCall): string | null {
  const { toolName, toolInput, agentId, agentType } = call;

  if (agentId === undefined) {
    if (!COORDINATOR_TOOLS.has(toolName)) {
      return `The Coordinator delegates and reads status; it does not use ${toolName}.`;
    }
    if (DELEGATION_TOOLS.has(toolName)) {
      if (!isRole(toolInput.subagent_type)) {
        return `Delegate to one of: ${Object.keys(AGENTS).join(", ")}.`;
      }
      if (toolInput.model !== undefined) {
        return "Each role runs on the model its definition sets. Delegate without a model override.";
      }
      if (toolInput.isolation !== undefined) {
        return "Delegations run in this process, under this policy. Delegate without isolation.";
      }
    }
    return null;
  }

  if (!isRole(agentType)) return `Unknown agent type "${String(agentType)}".`;
  if (!AGENTS[agentType].tools.includes(toolName)) {
    return `${agentType} can't use ${toolName}. Report what you needed it for instead.`;
  }
  return null;
}

/** Enforced in every mode, and inside subagents. A failure in the check denies the call. */
export function createPolicyHooks(): Record<
  "PreToolUse",
  HookCallbackMatcher[]
> {
  const deny = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  });
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            try {
              if (input.hook_event_name !== "PreToolUse") {
                return { continue: true };
              }
              const toolInput = input.tool_input;
              if (typeof toolInput !== "object" || toolInput === null) {
                return deny("The call's input is not an object.");
              }
              const reason = denyReason({
                toolName: input.tool_name,
                toolInput: toolInput as Record<string, unknown>,
                agentId: input.agent_id,
                agentType: input.agent_type,
              });
              if (reason !== null) return deny(reason);
              if (!DELEGATION_TOOLS.has(input.tool_name)) {
                return { continue: true };
              }
              // A backgrounded agent ends the Coordinator's turn, and with it the
              // run: the SDK then cancels the agent's tool calls mid-task.
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  updatedInput: { ...toolInput, run_in_background: false },
                },
              };
            } catch (error) {
              return deny(`The policy check failed: ${String(error)}`);
            }
          },
        ],
      },
    ],
  };
}
