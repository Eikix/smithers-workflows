// smithers-source: generated
import {
  ClaudeCodeAgent,
  CodexAgent,
  type AgentLike,
} from "smithers-orchestrator";

export const providers = {
  claudeOpus: new ClaudeCodeAgent({ model: "claude-opus-4-6" }),
  claudeSonnet: new ClaudeCodeAgent({ model: "claude-sonnet-4-6" }),
  codex: new CodexAgent({ model: "gpt-5.4", skipGitRepoCheck: true }),
} as const;

export const agents = {
  cheapFast: [providers.claudeSonnet],
  smart: [providers.codex, providers.claudeOpus],
  smartTool: [providers.claudeOpus, providers.codex],
} as const satisfies Record<string, AgentLike[]>;
