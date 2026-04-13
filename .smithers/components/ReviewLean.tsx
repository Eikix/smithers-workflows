// smithers-source: custom
/** @jsxImportSource smithers-orchestrator */
import { Parallel, Task, type AgentLike } from "smithers-orchestrator";
import { z } from "zod/v4";
import ReviewLeanPrompt from "~/.smithers/prompts/review-lean.mdx";

const reviewIssueSchema = z.object({
  severity: z.enum(["critical", "major", "minor", "nit"]),
  title: z.string(),
  file: z.string().nullable().default(null),
  description: z.string(),
});

export const reviewLeanOutputSchema = z.object({
  reviewer: z.string(),
  approved: z.boolean(),
  feedback: z.string(),
  issues: z.array(reviewIssueSchema).default([]),
});

type ReviewLeanProps = {
  idPrefix: string;
  prompt: unknown;
  agents: AgentLike[];
};

export function ReviewLean({ idPrefix, prompt, agents }: ReviewLeanProps) {
  const promptText =
    typeof prompt === "string" ? prompt : JSON.stringify(prompt ?? null);
  return (
    <Parallel>
      {agents.map((agent, index) => (
        <Task
          key={`${idPrefix}:${index}`}
          id={`${idPrefix}:${index}`}
          output={reviewLeanOutputSchema}
          agent={agent}
          continueOnFail
        >
          <ReviewLeanPrompt
            reviewer={`reviewer-${index + 1}`}
            prompt={promptText}
          />
        </Task>
      ))}
    </Parallel>
  );
}
