// smithers-source: custom
// smithers-display-name: Implement Review Fix
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "~/agents";
import {
  ImplementReviewFixLoop,
  implementOutputSchema,
  validateOutputSchema,
} from "~/.smithers/components/ImplementReviewFixLoop";
import { reviewLeanOutputSchema } from "~/.smithers/components/ReviewLean";

const summarySchema = z.object({
  approved: z.boolean(),
  iterations: z.number(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewLeanOutputSchema,
  summary: summarySchema,
});

function renderFeedback(
  validate: z.infer<typeof validateOutputSchema> | undefined,
  reviews: Array<z.infer<typeof reviewLeanOutputSchema>>,
) {
  const parts: string[] = [];

  if (validate && !validate.allPassed && validate.failingSummary) {
    parts.push(`VALIDATION FAILED\n${validate.failingSummary}`);
  }

  for (const review of reviews) {
    if (review.approved) continue;
    parts.push(`${review.reviewer}: ${review.feedback}`);
    for (const issue of review.issues) {
      parts.push(
        `- [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`,
      );
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

export default smithers((ctx) => {
  const prompt = ctx.input.prompt ?? "Implement the requested change.";
  const validate = ctx.outputMaybe("validate", { nodeId: "main:validate" });
  const reviews = agents.smart
    .map((_, index) =>
      ctx.outputMaybe("review", { nodeId: `main:review:${index}` }),
    )
    .filter(Boolean) as Array<z.infer<typeof reviewLeanOutputSchema>>;
  const approved = Boolean(
    validate?.allPassed &&
    reviews.length === agents.smart.length &&
    reviews.every((review) => review.approved && review.issues.length === 0),
  );
  const feedback = renderFeedback(validate, reviews);

  return (
    <Workflow name="implement-review-fix">
      <ImplementReviewFixLoop
        idPrefix="main"
        prompt={prompt}
        implementAgents={agents.smartTool}
        validateAgents={agents.smartTool}
        reviewAgents={agents.smart}
        feedback={feedback}
        done={approved}
      />
      <Task id="summary" output={outputs.summary}>
        {{
          approved,
          iterations: reviews.length,
          summary: approved
            ? "Implementation passed validation and lean review."
            : `Stopped with unresolved findings after ${reviews.length} review passes.`,
        }}
      </Task>
    </Workflow>
  );
});
