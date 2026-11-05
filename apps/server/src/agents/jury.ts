/**
 * The jury.
 *
 * Three jurors assess the *same frozen evidence bundle* and the *same brief*,
 * concurrently and in isolation. They do not see each other's verdicts, which
 * is what makes their disagreement meaningful rather than a consensus the
 * first speaker anchors.
 *
 * A verdict schema has no human-vote field, so no amount of prompt injection
 * lets an LLM produce the founder's decision.
 */

import {
  deliberationSchema,
  jurorVerdictSchema,
  type CompetitorMap,
  type Deliberation,
  type EvidenceItem,
  type JurorKey,
  type JurorVerdict,
  type MarketAssessment,
  type OpportunityBrief,
} from "@origin/contracts";
import { logger } from "../lib/logger.js";
import { formatEvidence, runAgent, type AgentSpec } from "./runtime.js";

export const JUROR_SPECS: Record<JurorKey, AgentSpec> = {
  investor: {
    key: "investor",
    displayName: "Investor",
    role: "Decide whether this opportunity is worth funding and building now.",
    lens: "You care about market size, monetization and scalability. You are unmoved by technical elegance or user sympathy; a real problem that nobody will pay to solve is not a company.",
  },
  "technical-architect": {
    key: "technical-architect",
    displayName: "Technical Architect",
    role: "Decide whether this can actually be built well by a small team.",
    lens: "You care about feasibility, complexity and delivery risk. You distinguish 'hard' from 'underspecified', and you discount plans that depend on data or integrations the team does not have.",
  },
  "customer-advocate": {
    key: "customer-advocate",
    displayName: "Customer Advocate",
    role: "Decide whether this solves a severe, real problem for the people who have it.",
    lens: "You care about severity and usefulness. A mild annoyance wrapped in a business model is still a mild annoyance. You check whether the proposed solution addresses the problem that was actually described.",
  },
};

export interface JuryInput {
  brief: OpportunityBrief;
  market: MarketAssessment;
  competitors: CompetitorMap;
  evidence: EvidenceItem[];
  clusterProblem: string;
}

export interface JuryOutput {
  verdicts: JurorVerdict[];
  deliberation: Deliberation;
  timings: { jurorsMs: number; deliberationMs: number };
}

function juryContext(input: JuryInput): string {
  const cited = input.evidence.filter((e) => input.brief.evidenceIds.includes(e.id));
  return [
    "ORIGINAL PROBLEM",
    input.clusterProblem,
    "",
    "OPPORTUNITY BRIEF",
    JSON.stringify(input.brief, null, 2),
    "",
    "MARKET ASSESSMENT",
    JSON.stringify(input.market, null, 2),
    "",
    "COMPETITOR MAP",
    JSON.stringify(input.competitors, null, 2),
    "",
    formatEvidence(cited, 30),
  ].join("\n");
}

/**
 * Runs the three jurors concurrently. Each is a separate request, so no juror
 * can see another's output.
 */
export async function runJury(input: JuryInput): Promise<JuryOutput> {
  const context = juryContext(input);
  const started = Date.now();

  const instructionFor = (juror: JurorKey): string =>
    [
      `You are the ${JUROR_SPECS[juror].displayName}. Evaluate this opportunity independently.`,
      "Return: your juror key, your vote (yes or no), a 0-100 score,",
      "a one-line summary, full reasoning, the evidence ids that support your position,",
      "your specific concerns, and any conditions you would require for approval.",
      "Judge the evidence as presented. Do not assume facts not in the bundle.",
    ].join(" ");

  const results = await Promise.all(
    (Object.keys(JUROR_SPECS) as JurorKey[]).map(async (juror) => {
      const result = await runAgent({
        spec: JUROR_SPECS[juror],
        schema: jurorVerdictSchema,
        taskKey: `juror-${juror}`,
        maxOutputTokens: 10_000,
        instruction: instructionFor(juror),
        context,
      });
      // Enforce the juror's own identity: a model must not return another
      // juror's verdict, which would corrupt the tally.
      if (result.value.juror !== juror) {
        throw new Error(
          `Juror ${juror} returned a verdict for ${result.value.juror}; refusing to count it`,
        );
      }
      return result;
    }),
  );

  const jurorsMs = Date.now() - started;
  const verdicts = results.map((r) => r.value);

  // Only the real human participant decides; this summary is advisory.
  const deliberationStart = Date.now();
  const contextForChair = [
    context,
    "",
    "JUROR VERDICTS (independent, produced without seeing each other)",
    JSON.stringify(verdicts, null, 2),
  ].join("\n");

  const deliberation = await runAgent({
    spec: {
      key: "product-strategist",
      displayName: "Product Strategist",
      role: "Chair the jury deliberation and make the disagreement legible.",
      lens: "You do not cast a vote. You summarise where the jurors agree and disagree, and you name the specific uncertainty a human decision should resolve.",
    },
    schema: deliberationSchema,
    taskKey: "deliberation",
    maxOutputTokens: 8_000,
    instruction: [
      "Summarise the jury's deliberation.",
      "List the points the jurors agree on, the points where they genuinely disagree (be specific about whose position differs and why),",
      "a short overall summary, and whether the council should proceed to a human vote or reject.",
      "Do not invent consensus. If two jurors disagree about feasibility, say so plainly.",
    ].join(" "),
    context: contextForChair,
  });

  const deliberationMs = Date.now() - deliberationStart;
  const yes = verdicts.filter((v) => v.vote === "yes").length;
  logger.info(`Jury: ${yes}/3 yes (${verdicts.map((v) => `${v.juror}=${v.vote}`).join(", ")})`);

  return {
    verdicts,
    deliberation: deliberation.value,
    timings: { jurorsMs, deliberationMs },
  };
}
