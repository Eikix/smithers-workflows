# smithers-workflows

Private Smithers workflow library for repeatable coding and GitHub operations.

## Workflows

- `implement-review-fix`
  - implement a change
  - validate it
  - review for safety, validity, and maximum leanness
  - fix and loop until clean or capped
- `ci-babysit`
  - inspect a GitHub Actions run
  - distinguish green, in-progress, infra, deterministic, and blocked outcomes
  - rerun infra flakes or patch deterministic failures
- `ci-watch-babysit`
  - watch a GitHub Actions run over time
  - wait durably with backoff between inspections
  - rerun infra flakes or patch deterministic failures until the run turns green or blocked
- `pr-babysit`
  - inspect a pull request
  - summarize checks and actionable review pressure
  - patch when the PR needs deterministic fixes

## Structure

- `.smithers/workflows/` runnable workflows
- `.smithers/components/` reusable building blocks
- `.smithers/prompts/` prompt templates

## Run

```bash
bun install
bun run workflow:list
bunx smithers-orchestrator up .smithers/workflows/implement-review-fix.tsx
```

## Hooks

This repository uses `prek` with local hooks for:

- formatting via `prettier`
- linting via `oxlint`
- type-checking via `tsc`
