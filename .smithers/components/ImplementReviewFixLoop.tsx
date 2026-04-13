// smithers-source: custom
/** @jsxImportSource smithers-orchestrator */
import { Loop, Sequence, Task, type AgentLike } from "smithers-orchestrator";
import { z } from "zod/v4";
import { ReviewLean } from "~/.smithers/components/ReviewLean";
import ImplementPrompt from "~/.smithers/prompts/implement.mdx";
import ValidatePrompt from "~/.smithers/prompts/validate.mdx";

export const implementOutputSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  allTestsPassing: z.boolean().default(true),
});

export const validateOutputSchema = z.object({
  summary: z.string(),
  allPassed: z.boolean().default(true),
  failingSummary: z.string().nullable().default(null),
});

type ImplementReviewFixLoopProps = {
  idPrefix: string;
  prompt: string;
  implementAgents: AgentLike[];
  reviewAgents: AgentLike[];
  validateAgents?: AgentLike[];
  feedback?: string | null;
  done: boolean;
  maxIterations?: number;
};

export function ImplementReviewFixLoop({
  idPrefix,
  prompt,
  implementAgents,
  reviewAgents,
  validateAgents,
  feedback,
  done,
  maxIterations = 4,
}: ImplementReviewFixLoopProps) {
  const request = feedback
    ? `${prompt}\n\n---\nADDRESS THESE FINDINGS BEFORE ANYTHING ELSE:\n${feedback}`
    : prompt;

  return (
    <Loop
      id={`${idPrefix}:loop`}
      until={done}
      maxIterations={maxIterations}
      onMaxReached="return-last"
    >
      <Sequence>
        <Task
          id={`${idPrefix}:implement`}
          output={implementOutputSchema}
          agent={implementAgents}
          timeoutMs={2_700_000}
          heartbeatTimeoutMs={900_000}
        >
          <ImplementPrompt prompt={request} />
        </Task>
        <Task
          id={`${idPrefix}:validate`}
          output={validateOutputSchema}
          agent={
            validateAgents && validateAgents.length > 0
              ? validateAgents
              : implementAgents
          }
          timeoutMs={2_700_000}
          heartbeatTimeoutMs={900_000}
        >
          <ValidatePrompt prompt={prompt} />
        </Task>
        <ReviewLean
          idPrefix={`${idPrefix}:review`}
          prompt={prompt}
          agents={reviewAgents}
        />
      </Sequence>
    </Loop>
  );
}
