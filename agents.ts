// smithers-source: generated
import {
  ClaudeCodeAgent,
  CodexAgent,
  PiAgent,
  AmpAgent,
  type AgentLike,
} from "smithers-orchestrator";

export const providers = {
  claude: new ClaudeCodeAgent({ model: "claude-opus-4-6" }),
  codex: new CodexAgent({ model: "gpt-5.3-codex", skipGitRepoCheck: true }),
  pi: new PiAgent({ provider: "openai", model: "gpt-5.3-codex" }),
  amp: new AmpAgent(),
  claudeSonnet: new ClaudeCodeAgent({ model: "claude-sonnet-4-6" }),
} as const;

export const agents = {
  cheapFast: [providers.claudeSonnet, providers.pi],
  smart: [providers.codex, providers.claude, providers.amp],
  smartTool: [providers.claude, providers.codex, providers.amp],
} as const satisfies Record<string, AgentLike[]>;
