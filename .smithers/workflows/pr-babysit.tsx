// smithers-source: custom
// smithers-display-name: PR Babysit
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Task, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "~/agents";
import ObservePrompt from "~/.smithers/prompts/pr-observe.mdx";
import FixPrompt from "~/.smithers/prompts/pr-fix.mdx";

const inspectionSchema = z.object({
  state: z.enum(["open", "merged", "closed", "unknown"]),
  action: z.enum(["clean", "needs-fix", "needs-human", "waiting"]),
  checksSummary: z.string(),
  reviewSummary: z.string(),
  summary: z.string(),
});

const fixSchema = z.object({
  changedFiles: z.array(z.string()).default([]),
  summary: z.string(),
});

const reportSchema = z.object({
  action: z.enum(["none", "fix", "blocked"]),
  summary: z.string(),
});

const { Workflow, smithers, outputs } = createSmithers({
  inspection: inspectionSchema,
  fix: fixSchema,
  report: reportSchema,
});

export default smithers((ctx) => {
  const pr = String(ctx.input.pr ?? "");
  const repo = String(ctx.input.repo ?? "");
  const inspection = ctx.outputMaybe("inspection", { nodeId: "inspect" });
  const needsFix = inspection?.action === "needs-fix";

  return (
    <Workflow name="pr-babysit">
      <Sequence>
        <Task id="inspect" output={outputs.inspection} agent={agents.smartTool}>
          <ObservePrompt pr={pr} repo={repo} />
        </Task>

        {needsFix ? (
          <Task id="fix" output={outputs.fix} agent={agents.smartTool}>
            <FixPrompt
              pr={pr}
              repo={repo}
              summary={inspection?.summary ?? ""}
            />
          </Task>
        ) : null}

        <Task id="report" output={outputs.report}>
          {{
            action:
              inspection?.action === "needs-human"
                ? "blocked"
                : needsFix
                  ? "fix"
                  : "none",
            summary:
              inspection?.summary ?? "PR inspection did not produce a summary.",
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
