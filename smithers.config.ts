export const repoCommands = {
  lint: "bun run lint && bun run typecheck",
  test: null,
  coverage: null,
} as const;

export default { repoCommands };
