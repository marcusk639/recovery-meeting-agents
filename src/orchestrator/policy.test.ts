import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpName } from "../tools/server.js";
import { AGENTS, ROLES } from "../team.js";
import { createPolicyHooks, denyReason } from "./policy.js";

const coordinator = (toolName: string, toolInput = {}) =>
  denyReason({ toolName, toolInput });
const agent = (agentType: string, toolName: string) =>
  denyReason({ toolName, toolInput: {}, agentId: "a1", agentType });

test("the Coordinator delegates and reads status, and nothing else", () => {
  assert.equal(coordinator(mcpName("run_status")), null);
  assert.equal(coordinator("Agent", { subagent_type: "feed-collector" }), null);
  assert.ok(coordinator(mcpName("fetch_page")));
  assert.ok(coordinator(mcpName("record_verdict")));
  assert.ok(coordinator("WebSearch"));
  assert.ok(coordinator("Bash"));
});

test("delegations are forced to the foreground, which keeps the run alive", async () => {
  const hook = createPolicyHooks().PreToolUse[0]!.hooks[0]!;
  const result = await hook(
    {
      hook_event_name: "PreToolUse",
      session_id: "s",
      transcript_path: "/tmp/t",
      cwd: "/tmp",
      tool_use_id: "t",
      tool_name: "Agent",
      tool_input: { subagent_type: "feed-collector", run_in_background: true },
    } as never,
    "t",
    { signal: new AbortController().signal },
  );
  assert.deepEqual(
    (result as { hookSpecificOutput: { updatedInput: unknown } })
      .hookSpecificOutput.updatedInput,
    { subagent_type: "feed-collector", run_in_background: false },
  );
});

test("delegation is limited to the team, on its pinned models", () => {
  assert.ok(coordinator("Agent", { subagent_type: "general-purpose" }));
  assert.ok(coordinator("Agent", {}));
  assert.ok(
    coordinator("Agent", { subagent_type: "feed-collector", model: "opus" }),
  );
  assert.ok(
    coordinator("Agent", {
      subagent_type: "feed-collector",
      isolation: "remote",
    }),
  );
});

test("an extractor can't approve what it extracted", () => {
  assert.equal(agent("page-extractor", mcpName("submit_candidates")), null);
  assert.ok(agent("page-extractor", mcpName("record_verdict")));
});

test("a verifier sees only stored pages, and can't add meetings", () => {
  assert.equal(agent("meeting-verifier", mcpName("record_verdict")), null);
  assert.ok(agent("meeting-verifier", mcpName("fetch_page")));
  assert.ok(agent("meeting-verifier", mcpName("submit_candidates")));
  assert.ok(agent("meeting-verifier", "WebSearch"));
});

test("no role has a shell, file writes or a way to delegate", () => {
  for (const role of ROLES) {
    for (const tool of ["Bash", "Write", "Edit", "Read", "Agent", "Task"]) {
      assert.ok(agent(role, tool), `${role} must not have ${tool}`);
    }
    assert.ok(!AGENTS[role].tools.includes("Bash"));
  }
});

test("an unknown agent type is refused", () => {
  assert.ok(agent("general-purpose", mcpName("run_status")));
  assert.ok(agent("__proto__", mcpName("run_status")));
});

test("the hook returns a deny decision the SDK understands", async () => {
  const hook = createPolicyHooks().PreToolUse[0]!.hooks[0]!;
  const base = {
    hook_event_name: "PreToolUse",
    session_id: "s",
    transcript_path: "/tmp/t",
    cwd: "/tmp",
    tool_use_id: "t",
  };
  const denied = await hook(
    { ...base, tool_name: "Bash", tool_input: { command: "ls" } } as never,
    "t",
    { signal: new AbortController().signal },
  );
  assert.equal(
    (denied as { hookSpecificOutput: { permissionDecision: string } })
      .hookSpecificOutput.permissionDecision,
    "deny",
  );
  const allowed = await hook(
    { ...base, tool_name: mcpName("run_status"), tool_input: {} } as never,
    "t",
    { signal: new AbortController().signal },
  );
  assert.deepEqual(allowed, { continue: true });
});
