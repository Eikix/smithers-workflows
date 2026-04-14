---
name: use-smithers-workflows
description: Use when a task should invoke, compose, derive, or extend workflows from the personal Smithers workflow library, regardless of the current repository. Use when the user wants reusable loops like implement-review-fix, ci-babysit, ci-watch-babysit, or pr-babysit applied to work in another repo such as fhevm, or when a new workflow should be derived from those patterns.
---

# Use Smithers Workflows

Use this skill when the workflow library should be used as an execution or composition tool, even if the current working repository is not the workflow library itself.

The workflow library lives at:

- `/Users/work/code/smithers-workflows`

The target work may live elsewhere, for example:

- `/Users/work/.codex/worktrees/.../fhevm`

Do not assume the current repo is the workflow repo. Distinguish clearly between:

- the workflow library repo
- the target repo where implementation or CI work happens

Work from the workflow repository as it exists now. Do not assume upstream Smithers examples still match this repo.

## Repository contract

- Treat this repo as a lean personal workflow library.
- Prefer deriving from an existing workflow over inventing a new one from scratch.
- Keep workflows small, composable, and opinionated.
- Keep prompts generic and reusable; do not add project-specific or personal context.
- Keep the staple roster small unless a new workflow is clearly justified.

## How to think about scope

This skill is for choosing and using workflow patterns, not for mechanically forcing Smithers into every task.

Use it when the user wants behavior like:

- implement, review, fix, loop until clean
- monitor CI over time and keep acting
- monitor a PR and keep reacting to checks or comments
- compose multiple known workflow patterns into one higher-level flow

Do not use it merely because files happen to live in the workflow repo.

If the task is mainly:

- debugging Smithers itself
- investigating an upstream Smithers runtime bug
- changing the workflow library internals

then use this skill only for local repo conventions when needed, not as the framing for the whole task.

## Current baseline

Check these files first before making changes:

- `package.json`
- `smithers.config.ts`
- `.smithers/workflows/implement-review-fix.tsx`
- `.smithers/workflows/ci-babysit.tsx`
- `.smithers/workflows/ci-watch-babysit.tsx`
- `.smithers/workflows/pr-babysit.tsx`
- `.smithers/components/ImplementReviewFixLoop.tsx`
- `.smithers/components/ReviewLean.tsx`

As of this repository state:

- Smithers runtime dependency is `smithers-orchestrator` from npm.
- The repo is configured around `typescript ~5.9.3`.
- The repo expects `zod ^4.3.6`.
- Hooks are managed with `prek`.

If the dependency stack changes, update this skill to match the current repository rather than preserving stale instructions.

## Workflow selection

Start from the nearest existing workflow:

- `implement-review-fix`
  - Use for coding loops that should implement, validate, review for safety/correctness/leanness, fix findings, and converge.
- `ci-babysit`
  - Use for GitHub Actions inspection, failure classification, deterministic fix-up, and rerun decisions.
- `ci-watch-babysit`
  - Use for long-running GitHub Actions monitoring with durable timer-based backoff, reruns, and fix loops.
- `pr-babysit`
  - Use for pull request inspection, actionable review handling, and deterministic patching.

When a request can be expressed as a composition or refinement of one of these, modify or derive that workflow.

Common target-repo mappings:

- feature implementation with iterative review
  - start from `implement-review-fix`
- investigate a failing GitHub Actions run once
  - start from `ci-babysit`
- monitor a GitHub Actions run over time and keep acting
  - start from `ci-watch-babysit`
- inspect or babysit a PR
  - start from `pr-babysit`
- implement -> review -> fix -> push draft PR -> watch CI/PR -> keep fixing
  - compose `implement-review-fix` with `ci-watch-babysit` and `pr-babysit`
  - if that composition becomes a recurring pattern, derive a new workflow instead of repeating ad hoc glue

Only create a brand-new workflow when:

- no existing workflow is structurally close, and
- forcing reuse would make the result harder to understand or maintain.

## Editing rules

- Reuse existing components before adding new ones.
- Reuse existing prompts before adding new prompts.
- Add a new component only when logic would otherwise be duplicated across workflows.
- Add a new prompt only when the behavior is meaningfully distinct and reusable.
- Remove dead scaffold or unused files instead of accumulating alternatives.
- Keep code lean. The best new node is the one not added.

## Invocation

Use the repo-local Smithers CLI, not `bunx smithers-orchestrator`. This repository relies on its installed runtime and workflow pack:

```bash
./node_modules/.bin/smithers
```

When invoked from another repo, keep the working-repo boundary explicit:

- run Smithers commands from `/Users/work/code/smithers-workflows`
- pass the target repo or GitHub identifiers as workflow input
- make code changes in the target repo, not in the workflow repo, unless the task is to evolve the workflow library itself

List available workflows:

```bash
bun run workflow:list
```

Run a workflow directly:

```bash
./node_modules/.bin/smithers up .smithers/workflows/<workflow>.tsx
```

Typical examples:

```bash
./node_modules/.bin/smithers up .smithers/workflows/implement-review-fix.tsx --input '{"prompt":"Implement the requested change."}'
./node_modules/.bin/smithers up .smithers/workflows/ci-babysit.tsx --input '{"repo":"owner/name","run":"123456789"}'
./node_modules/.bin/smithers up .smithers/workflows/pr-babysit.tsx --input '{"repo":"owner/name","pr":"42"}'
```

## Local dashboard

When a workflow is launched for monitoring, babysitting, or any long-running task, also make the local dashboard available unless it is clearly unnecessary.

For long-running workflows, a detached run alone is not sufficient. Timer-based workflows persist state in `smithers.db`, but they do not keep resuming themselves unless a supervisor loop is running.

For these workflows:

- `ci-watch-babysit`
- any workflow that uses `Timer`
- any workflow expected to keep acting while the user is away

Preferred approach: use `tmux` so the supervisor is owned by the OS session rather than the launching chat/tool process.

Launch all three:

1. the run in detached mode
2. the supervisor loop in a long-lived `tmux` session
3. the dashboard

Use:

```bash
./node_modules/.bin/smithers up -d .smithers/workflows/<workflow>.tsx --input '{...}'
bun run supervisor:start
bun run dashboard
```

Supervisor lifecycle commands:

```bash
bun run supervisor:start
bun run supervisor:status
bun run supervisor:stop-if-idle
```

Do not present `smithers up` by itself as durable monitoring. Without `supervise`, the run will reach `waiting-timer`, the CLI will exit, and nothing will resume it.

Operational notes:

- `supervisor:start` must be treated as idempotent.
- Reuse one supervisor per Smithers DB / repo runtime, not one per workflow.
- Prefer reusing the same `tmux` session name: `smithers-supervisor`.
- If the supervisor command changes, replace the session intentionally instead of spawning duplicates.
- Report to the user that the long-lived supervisor is running in `tmux`, not inside the chat process.
- If `tmux` is unavailable, state that clearly and fall back to a normal long-lived terminal process only as a weaker alternative.

- Start the dashboard with:

```bash
bun run dashboard
```

- Tell the user to open:

```text
http://127.0.0.1:4311
```

- Make it explicit which local runtime the UI is serving:
  - workspace/worktree root
  - local `smithers.db` path

Use the dashboard especially for:

- `ci-watch-babysit`
- `ci-babysit` when the user wants live supervision
- `pr-babysit` when the user wants live supervision

Do not make the user ask separately for visibility if the task is inherently ongoing. Start the UI path proactively and report the localhost URL.

## Validation

Run these after changing the library:

```bash
bun run lint
bun run typecheck
bunx @j178/prek run --all-files
```

If validation fails because the repo toolchain changed, fix the repo configuration first and then update this skill to reflect the new reality.

## Derivation pattern

When asked to create a new workflow:

1. Identify the closest existing workflow.
2. Explain briefly why that base workflow is the right starting point.
3. Derive the smallest change set that matches the new use case.
4. Keep names literal and operational.
5. Validate the repo.

When asked to explain or use a workflow:

1. Read the actual workflow file.
2. Read any components and prompts it imports.
3. Explain the current implementation, not a guessed Smithers pattern.

## Cross-repo execution pattern

When the user is in another repo and wants to use the workflow library:

1. Identify the target repo and the target task.
2. Choose the nearest existing workflow from the library.
3. Decide whether the task is:
   - direct invocation
   - light composition of existing workflows
   - or a reusable new derived workflow
4. Run the workflow from `/Users/work/code/smithers-workflows`.
5. Apply resulting code changes only in the target repo.
6. Keep workflow-library edits separate from target-repo edits unless the user explicitly wants both.

Do not blur these boundaries in commits or explanations.
