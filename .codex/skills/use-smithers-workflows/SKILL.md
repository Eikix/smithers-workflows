---
name: use-smithers-workflows
description: Use when working inside the smithers-workflows repository to run, refine, derive, or add Smithers workflows. Use when asked to create a new reusable workflow from an existing pattern, adapt implement-review-fix, ci-babysit, or pr-babysit to a new use case, or explain how to invoke the repository workflows with bunx.
---

# Use Smithers Workflows

Work from the repository as it exists now. Do not assume upstream Smithers examples still match this repo.

## Repository contract

- Treat this repo as a lean personal workflow library.
- Prefer deriving from an existing workflow over inventing a new one from scratch.
- Keep workflows small, composable, and opinionated.
- Keep prompts generic and reusable; do not add project-specific or personal context.
- Keep the staple roster small unless a new workflow is clearly justified.

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

List available workflows:

```bash
bun run workflow:list
```

Run a workflow directly:

```bash
bunx smithers-orchestrator up .smithers/workflows/<workflow>.tsx
```

Typical examples:

```bash
bunx smithers-orchestrator up .smithers/workflows/implement-review-fix.tsx --input '{"prompt":"Implement the requested change."}'
bunx smithers-orchestrator up .smithers/workflows/ci-babysit.tsx --input '{"repo":"owner/name","run":"123456789"}'
bunx smithers-orchestrator up .smithers/workflows/pr-babysit.tsx --input '{"repo":"owner/name","pr":"42"}'
```

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
