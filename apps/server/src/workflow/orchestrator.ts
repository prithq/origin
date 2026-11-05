/**
 * The orchestrator.
 *
 * Runs the journey end to end:
 *
 *   discovery -> clustering -> research -> jury -> human vote -> build -> QA
 *
 * It is the only place that composes agents, the store, SWITCH and the
 * sandbox. Each phase is a separate exported function so it can be triggered
 * (and retried) independently, but `runFullJourney` chains them the way the
 * product intends.
 *
 * Two invariants run through all of it:
 *   - the stored state and the transition log are always updated together;
 *   - a failure marks the opportunity FAILED with its real cause rather than
 *     leaving it stuck in an in-progress state.
 */

import {
  AGENT_SPECS,
  type AgentKey,
  type EvidenceItem,
  type Opportunity,
  type RoomKey,
} from "@origin/contracts";
import { clusterEvidence } from "../agents/discovery.js";
import { runJury } from "../agents/jury.js";
import { runResearch } from "../agents/research.js";
import { runDiscovery } from "../discovery/sources.js";
import { getStore } from "../db/store.js";
import { logger } from "../lib/logger.js";
import { recordActivity } from "../lib/activity.js";
import type { SwitchHub } from "../switch/hub.js";
import { voteInstruction } from "../switch/human-vote.js";
import {
  createOpportunity,
  narrate,
  setOpportunityState,
  summariseEvidence,
} from "./engine.js";
import { beginRun, endRun, isRunning } from "./runs.js";
import { tallyVotes } from "./tally.js";
import { buildApprovedOpportunity } from "../build/pipeline.js";

export interface OrchestratorDeps {
  hub: SwitchHub;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  private get hub(): SwitchHub {
    return this.deps.hub;
  }

  /** Posts into a room as a named agent, if that agent is connected. */
  private poster(agentKey: AgentKey, room: RoomKey, body: string): () => Promise<void> {
    return async () => {
      if (!this.hub.isReady) return;
      await this.hub.postAs(agentKey, body);
      void room;
    };
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Retrieves evidence and clusters it into candidate problems.
   *
   * Returns the created opportunities. Each one starts in DISCOVERING and is
   * moved to RESEARCHING when the operator (or the automatic journey) picks it
   * up, so a discovery run never claims research it has not done.
   */
  async runDiscoveryPhase(): Promise<{
    opportunities: Opportunity[];
    evidenceCount: number;
    errors: Array<{ source: string; message: string }>;
  }> {
    if (isRunning("discovery")) {
      throw new Error("A discovery run is already in progress");
    }
    beginRun("discovery");

    try {
      await recordActivity({
        phase: "discovery",
        summary: "Discovery run started",
        agentKey: "social-scout",
        room: "discovery-lab",
        level: "info",
      });

      const result = await runDiscovery();
      if (result.items.length === 0) {
        throw new Error(
          `No signals were retrieved from any source: ${
            result.errors.map((e) => `${e.source}: ${e.message}`).join("; ") || "no error reported"
          }`,
        );
      }

      if (this.hub.isReady) {
        await narrate({
          post: this.poster(
            "social-scout",
            "discovery-lab",
            `Discovery pass complete: ${result.items.length} signals retrieved (${summariseEvidence(
              result.items,
            )}). Source failures: ${result.errors.length}.`,
          ),
          agentKey: "social-scout",
          room: "discovery-lab",
          phase: "discovery",
          summary: `Retrieved ${result.items.length} signals from public sources`,
          detail: summariseEvidence(result.items),
        });
      }

      const { clusters, rejected } = await clusterEvidence(result.items);
      if (rejected.length > 0) {
        await recordActivity({
          phase: "discovery",
          summary: `Rejected ${rejected.length} cluster(s) for citing evidence outside the bundle`,
          agentKey: "product-strategist",
          room: "discovery-lab",
          level: "warning",
          detail: rejected.map((r) => `${r.label}: ${r.reason}`).join("; "),
        });
      }

      const opportunities: Opportunity[] = [];
      for (const cluster of clusters) {
        const opportunity = await createOpportunity(cluster);
        // Persist the evidence snapshot on the opportunity so a later run
        // cannot retroactively change what an opportunity was based on.
        await getStore().saveEvidence(opportunity.id, result.items);
        opportunities.push(opportunity);
      }

      if (this.hub.isReady) {
        await narrate({
          post: this.poster(
            "product-strategist",
            "discovery-lab",
            `Clustered ${result.items.length} signals into ${clusters.length} candidate problems:\n` +
              clusters.map((c) => `- ${c.label} (${c.signalCount} signals)`).join("\n"),
          ),
          agentKey: "product-strategist",
          room: "discovery-lab",
          phase: "clustering",
          summary: `Clustered signals into ${clusters.length} candidate problems`,
        });
      }

      return {
        opportunities,
        evidenceCount: result.items.length,
        errors: result.errors,
      };
    } finally {
      endRun("discovery");
    }
  }

  // -------------------------------------------------------------------------
  // Research
  // -------------------------------------------------------------------------

  async runResearchPhase(opportunityId: string): Promise<Opportunity> {
    if (isRunning("research", opportunityId)) {
      throw new Error("Research is already running for this opportunity");
    }
    const store = getStore();
    const opportunity = store.getOpportunity(opportunityId);
    if (!opportunity) throw new Error(`Opportunity ${opportunityId} not found`);

    if (opportunity.state !== "DISCOVERING") {
      throw new Error(
        `Research requires state DISCOVERING; ${opportunityId} is ${opportunity.state}`,
      );
    }

    beginRun("research", opportunityId);
    try {
      let current = await setOpportunityState(
        opportunity,
        "RESEARCHING",
        "system",
        "origin",
        "Selected for research",
      );

      const evidence = await this.evidenceFor(opportunityId);
      const research = await runResearch({ cluster: current.cluster, evidence });

      current = {
        ...current,
        market: research.market,
        competitors: research.competitors,
        brief: research.brief,
        updatedAt: new Date().toISOString(),
      };
      await store.upsertOpportunity(current);

      if (this.hub.isReady) {
        await narrate({
          post: this.poster(
            "product-strategist",
            "startup-council",
            [
              `Opportunity brief: ${research.brief.title}`,
              "",
              `Problem: ${research.brief.problemStatement}`,
              `Target users: ${research.brief.targetUsers.join(", ")}`,
              `Proposed solution: ${research.brief.proposedSolution}`,
              `Market demand: ${research.market.demand} (confidence ${research.market.confidence}/100)`,
              `Competitors considered: ${
                research.competitors.competitors.map((c) => c.name).join(", ") || "none identified"
              }`,
              `MVP must-haves: ${research.brief.mvpFeatures
                .filter((f) => f.priority === "must")
                .map((f) => f.title)
                .join("; ")}`,
            ].join("\n"),
          ),
          agentKey: "product-strategist",
          room: "startup-council",
          phase: "research",
          summary: `Opportunity brief produced: ${research.brief.title}`,
          opportunityId,
        });
      }

      return current;
    } catch (err) {
      await this.failOpportunity(opportunityId, "research", err);
      throw err;
    } finally {
      endRun("research", opportunityId);
    }
  }

  // -------------------------------------------------------------------------
  // Jury
  // -------------------------------------------------------------------------

  async runJuryPhase(opportunityId: string): Promise<Opportunity> {
    if (isRunning("jury", opportunityId)) {
      throw new Error("Jury review is already running for this opportunity");
    }
    const store = getStore();
    const opportunity = store.getOpportunity(opportunityId);
    if (!opportunity) throw new Error(`Opportunity ${opportunityId} not found`);

    if (opportunity.state !== "RESEARCHING") {
      throw new Error(`Jury review requires state RESEARCHING; got ${opportunity.state}`);
    }
    if (!opportunity.brief || !opportunity.market || !opportunity.competitors) {
      throw new Error("Jury review requires a completed brief, market and competitor analysis");
    }

    beginRun("jury", opportunityId);
    try {
      let current = await setOpportunityState(
        opportunity,
        "JURY_REVIEW",
        "system",
        "origin",
        "Brief complete; convening the jury",
      );

      const evidence = await this.evidenceFor(opportunityId);
      const jury = await runJury({
        brief: current.brief!,
        market: current.market!,
        competitors: current.competitors!,
        evidence,
        clusterProblem: current.cluster.problemStatement,
      });

      const tally = tallyVotes(jury.verdicts, "pending");
      current = {
        ...current,
        verdicts: jury.verdicts,
        deliberation: jury.deliberation,
        tally,
        updatedAt: new Date().toISOString(),
      };
      await store.upsertOpportunity(current);

      if (this.hub.isReady) {
        const verdictLines = jury.verdicts
          .map((v) => `- ${v.juror}: ${v.vote.toUpperCase()} (${v.score}/100) — ${v.summary}`)
          .join("\n");
        await narrate({
          post: this.poster(
            "product-strategist",
            "startup-council",
            [
              `Jury deliberation for: ${current.brief!.title}`,
              "",
              verdictLines,
              "",
              "Disagreements:",
              jury.deliberation.disagreements.length > 0
                ? jury.deliberation.disagreements.map((d) => `- ${d}`).join("\n")
                : "- none; the jurors converged",
              "",
              voteInstruction(current.id, current.brief!.title),
            ].join("\n"),
          ),
          agentKey: "product-strategist",
          room: "startup-council",
          phase: "jury",
          summary: `Jury voted ${tally.aiYes}/3 yes`,
          detail: tally.reason,
          opportunityId,
        });
      }

      // The council always proceeds to the human vote. Even a unanimous
      // rejection is the founder's to confirm, so the decision stays theirs.
      current = await setOpportunityState(
        current,
        "AWAITING_HUMAN_VOTE",
        "system",
        "origin",
        `Jury complete (${tally.aiYes}/3 yes); awaiting the founder's vote`,
      );

      return current;
    } catch (err) {
      await this.failOpportunity(opportunityId, "jury", err);
      throw err;
    } finally {
      endRun("jury", opportunityId);
    }
  }

  // -------------------------------------------------------------------------
  // Human vote
  // -------------------------------------------------------------------------

  /**
   * Records the founder's vote and applies the approval rule.
   *
   * Idempotent in the sense that matters: a vote is only accepted while the
   * opportunity is awaiting one, so a replayed or duplicated vote cannot
   * re-trigger a build. Returns the updated opportunity and the tally.
   */
  async recordHumanVote(
    opportunityId: string,
    vote: {
      decision: "yes" | "no";
      channel: "mattermost" | "switch-room" | "origin-console";
      voterName: string;
      switchSenderId?: string;
      switchMessageId?: string;
      note?: string;
    },
  ): Promise<{ opportunity: Opportunity; approved: boolean; reason: string }> {
    const store = getStore();
    const opportunity = store.getOpportunity(opportunityId);
    if (!opportunity) throw new Error(`Opportunity ${opportunityId} not found`);

    if (opportunity.state !== "AWAITING_HUMAN_VOTE") {
      throw new Error(
        `Opportunity ${opportunityId} is not awaiting a human vote (state ${opportunity.state})`,
      );
    }

    const castAt = new Date().toISOString();
    const humanVote = {
      decision: vote.decision,
      channel: vote.channel,
      voterName: vote.voterName,
      castAt,
      ...(vote.switchSenderId ? { switchSenderId: vote.switchSenderId } : {}),
      ...(vote.switchMessageId ? { switchMessageId: vote.switchMessageId } : {}),
      ...(vote.note ? { note: vote.note } : {}),
    };

    const tally = tallyVotes(opportunity.verdicts, vote.decision);

    let current: Opportunity = {
      ...opportunity,
      humanVote,
      tally,
      updatedAt: castAt,
    };
    await store.upsertOpportunity(current);

    const nextState = tally.approved ? "APPROVED" : "REJECTED";
    current = await setOpportunityState(
      current,
      nextState,
      "human",
      vote.voterName,
      tally.reason,
    );

    if (this.hub.isReady) {
      await narrate({
        post: this.poster(
          "product-strategist",
          "startup-council",
          [
            `Founder vote recorded: ${vote.decision.toUpperCase()} (${vote.channel})`,
            `Tally: ${tally.aiYes}/3 jurors yes, founder ${vote.decision}`,
            tally.reason,
            tally.approved
              ? "The build workflow starts automatically."
              : "The opportunity will not be built.",
          ].join("\n"),
        ),
        agentKey: "product-strategist",
        room: "startup-council",
        phase: "vote",
        summary: `Founder voted ${vote.decision}; ${tally.approved ? "approved" : "rejected"}`,
        detail: tally.reason,
        opportunityId,
        level: tally.approved ? "success" : "warning",
      });
    }

    if (tally.approved) {
      // Approval triggers the build with no further gate.
      void this.startBuild(opportunityId).catch((err) => {
        logger.error(`Build failed to start for ${opportunityId}: ${(err as Error).message}`);
      });
    }

    return { opportunity: current, approved: tally.approved, reason: tally.reason };
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  async startBuild(opportunityId: string): Promise<Opportunity> {
    const store = getStore();
    const opportunity = store.getOpportunity(opportunityId);
    if (!opportunity) throw new Error(`Opportunity ${opportunityId} not found`);

    if (opportunity.state !== "APPROVED") {
      throw new Error(`Build requires state APPROVED; got ${opportunity.state}`);
    }
    if (isRunning("build", opportunityId)) {
      throw new Error("A build is already running for this opportunity");
    }

    beginRun("build", opportunityId);
    try {
      const building = await setOpportunityState(
        opportunity,
        "BUILDING",
        "system",
        "origin",
        "Approved; starting the autonomous build",
      );

      const result = await buildApprovedOpportunity({
        opportunity: building,
        hub: this.hub,
        onTesting: async () => {
          const current = getStore().getOpportunity(opportunityId);
          if (current?.state === "BUILDING") {
            await setOpportunityState(
              current,
              "TESTING",
              "agent",
              "QA Agent",
              "Builder finished; QA is running",
            );
          }
        },
        onRetry: async (attempt, failures) => {
          const current = getStore().getOpportunity(opportunityId);
          if (current?.state === "TESTING") {
            await setOpportunityState(
              current,
              "BUILDING",
              "agent",
              "QA Agent",
              `QA failed (attempt ${attempt}): requesting fixes`,
            );
          }
          await recordActivity({
            phase: "qa",
            summary: `QA requested a fix (attempt ${attempt})`,
            agentKey: "qa-agent",
            room: "build-studio",
            level: "warning",
            detail: failures.join("; ").slice(0, 800),
            opportunityId,
            viaSwitch: true,
          });
        },
      });

      const afterBuild = getStore().getOpportunity(opportunityId);
      if (!afterBuild) throw new Error("Opportunity disappeared during the build");

      const completed: Opportunity = {
        ...afterBuild,
        build: result,
        updatedAt: new Date().toISOString(),
      };
      await store.upsertOpportunity(completed);

      const final = await setOpportunityState(
        completed,
        result.state === "completed" ? "COMPLETED" : "FAILED",
        "agent",
        result.state === "completed" ? "QA Agent" : "origin",
        result.state === "completed"
          ? `QA passed after ${result.attempts} attempt(s)`
          : result.error ?? "Build failed",
      );

      return final;
    } catch (err) {
      await this.failOpportunity(opportunityId, "build", err);
      throw err;
    } finally {
      endRun("build", opportunityId);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async evidenceFor(opportunityId: string): Promise<EvidenceItem[]> {
    const stored = await getStore().loadEvidence(opportunityId);
    if (stored.length > 0) return stored;
    throw new Error(
      `No evidence snapshot is stored for ${opportunityId}; refusing to research an opportunity without its sources`,
    );
  }

  private async failOpportunity(
    opportunityId: string,
    phase: string,
    err: unknown,
  ): Promise<void> {
    const store = getStore();
    const current = store.getOpportunity(opportunityId);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`${phase} phase failed for ${opportunityId}: ${message}`);

    if (!current) return;
    // Only transitions declared by the state machine are allowed.
    try {
      await setOpportunityState(current, "FAILED", "system", "origin", `${phase}: ${message}`);
    } catch (transitionErr) {
      logger.warn(
        `Could not mark ${opportunityId} FAILED from ${current.state}: ${
          (transitionErr as Error).message
        }`,
      );
    }
    await recordActivity({
      phase,
      summary: `${phase} phase failed`,
      level: "error",
      detail: message.slice(0, 800),
      opportunityId,
    });
  }
}

/** The agent roster, for UI display. */
export function agentRoster(): Array<{ key: AgentKey; displayName: string; team: string }> {
  return AGENT_SPECS.map((a) => ({ key: a.key, displayName: a.displayName, team: a.team }));
}
