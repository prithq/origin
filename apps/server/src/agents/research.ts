/**
 * The research team.
 *
 * Three agents assess one problem cluster from different angles and produce
 * the inputs to the opportunity brief:
 *   - Market Researcher: is there demand, and from whom?
 *   - Competitor Analyst: what already exists, and who is underserved?
 *   - Product Strategist: what would we actually build?
 *
 * They share one frozen evidence bundle and run concurrently, so a later agent
 * cannot quietly reshape the evidence an earlier one reasoned about.
 */

import {
  competitorMapSchema,
  marketAssessmentSchema,
  opportunityBriefSchema,
  type CompetitorMap,
  type EvidenceItem,
  type MarketAssessment,
  type OpportunityBrief,
  type ProblemCluster,
} from "@origin/contracts";
import { formatEvidence, runAgent, type AgentSpec } from "./runtime.js";

export const AGENT_SPECS_RESEARCH = {
  marketResearcher: {
    key: "market-researcher",
    displayName: "Market Researcher",
    role: "Assess whether a problem cluster represents real, reachable demand and identify who suffers from it.",
    lens: "You are skeptical of thread volume as a proxy for willingness to pay. You separate 'people complain about this' from 'people would pay to solve this', and you say which one the evidence supports.",
  } satisfies AgentSpec,

  competitorAnalyst: {
    key: "competitor-analyst",
    displayName: "Competitor Analyst",
    role: "Map existing solutions to a problem and identify segments they serve badly or not at all.",
    lens: "An empty market is usually a warning, not an opportunity. You look for crowded markets with an underserved slice, and you name incumbents only when you are confident they exist.",
  } satisfies AgentSpec,

  productStrategist: {
    key: "product-strategist",
    displayName: "Product Strategist",
    role: "Turn research into a concrete, buildable opportunity brief.",
    lens: "You scope for a small team shipping in days, not a roadmap for a funded company. You cut features that do not prove the core value.",
  } satisfies AgentSpec,
} as const;

export interface ResearchInput {
  cluster: ProblemCluster;
  evidence: EvidenceItem[];
}

export interface ResearchOutput {
  market: MarketAssessment;
  competitors: CompetitorMap;
  brief: OpportunityBrief;
  timings: { marketMs: number; competitorMs: number; briefMs: number };
}

function clusterContext(cluster: ProblemCluster, evidence: EvidenceItem[]): string {
  const cited = evidence.filter((e) => cluster.evidenceIds.includes(e.id));
  return [
    "PROBLEM CLUSTER",
    `Label: ${cluster.label}`,
    `Problem: ${cluster.problemStatement}`,
    `Why these signals belong together: ${cluster.rationale}`,
    `Signals in cluster: ${cluster.signalCount}`,
    "",
    formatEvidence(cited, 40),
  ].join("\n");
}

/**
 * Market and competitor analysis run in parallel against the same bundle.
 */
export async function runMarketResearch(input: ResearchInput): Promise<{
  market: MarketAssessment;
  competitors: CompetitorMap;
  timings: { marketMs: number; competitorMs: number };
}> {
  const context = clusterContext(input.cluster, input.evidence);
  const validIds = new Set(input.cluster.evidenceIds);

  const [market, competitors] = await Promise.all([
    runAgent({
      spec: AGENT_SPECS_RESEARCH.marketResearcher,
      schema: marketAssessmentSchema,
      taskKey: "market-assessment",
      maxOutputTokens: 10_000,
      instruction: [
        "Assess demand for a product that solves this cluster's problem.",
        "Return a demand level, a confidence score, the target audience segments ranked by urgency,",
        "the evidence ids your assessment rests on, your reasoning, and any evidence gaps you would want filled.",
        "Be explicit about what the evidence does not show.",
      ].join(" "),
      context,
    }),
    runAgent({
      spec: AGENT_SPECS_RESEARCH.competitorAnalyst,
      schema: competitorMapSchema,
      taskKey: "competitor-map",
      maxOutputTokens: 10_000,
      instruction: [
        "Identify existing solutions to this problem and how well they serve it.",
        "For each competitor: name, optional URL, capabilities, weaknesses.",
        "Then list underserved segments and state what a new entrant could differentiate on.",
        "Name only competitors you are confident exist. If the evidence suggests no dedicated tool exists, say so in your reasoning.",
      ].join(" "),
      context,
    }),
  ]);

  // A market assessment citing evidence it was not given is untrustworthy.
  const cited = market.value.evidenceIds.filter((id) => validIds.has(id));
  if (cited.length === 0) {
    throw new Error(
      "Market assessment cited no evidence from the cluster; refusing to present it as grounded research",
    );
  }

  return {
    market: { ...market.value, evidenceIds: cited },
    competitors: competitors.value,
    timings: { marketMs: market.durationMs, competitorMs: competitors.durationMs },
  };
}

/**
 * The brief is produced after the other two, because it must reconcile them.
 */
export async function runOpportunityBrief(
  input: ResearchInput,
  market: MarketAssessment,
  competitors: CompetitorMap,
): Promise<{ brief: OpportunityBrief; briefMs: number }> {
  const context = [
    clusterContext(input.cluster, input.evidence),
    "",
    "MARKET ASSESSMENT",
    JSON.stringify(market, null, 2),
    "",
    "COMPETITOR MAP",
    JSON.stringify(competitors, null, 2),
  ].join("\n");

  const result = await runAgent({
    spec: AGENT_SPECS_RESEARCH.productStrategist,
    schema: opportunityBriefSchema,
    taskKey: "opportunity-brief",
    maxOutputTokens: 12_000,
    instruction: [
      "Write a structured opportunity brief that reconciles the market assessment and competitor map.",
      "Include: a title, the problem statement, target users, the proposed solution,",
      "MVP features tagged must/should/could, the business model, the main risks, success criteria,",
      "and the evidence ids the brief depends on.",
      "The MVP must be buildable by a small team in a few days. If the market assessment is weak,",
      "reflect that in the confidence score rather than overstating the opportunity.",
    ].join(" "),
    context,
  });

  const validIds = new Set(input.cluster.evidenceIds);
  const cited = result.value.evidenceIds.filter((id) => validIds.has(id));
  if (cited.length === 0) {
    throw new Error("Opportunity brief cited no valid evidence");
  }
  if (!result.value.mvpFeatures.some((f) => f.priority === "must")) {
    throw new Error("Opportunity brief has no must-have MVP feature; it is not buildable as specified");
  }

  return { brief: { ...result.value, evidenceIds: cited }, briefMs: result.durationMs };
}

export async function runResearch(input: ResearchInput): Promise<ResearchOutput> {
  const { market, competitors, timings } = await runMarketResearch(input);
  const { brief, briefMs } = await runOpportunityBrief(input, market, competitors);
  return {
    market,
    competitors,
    brief,
    timings: { ...timings, briefMs },
  };
}
