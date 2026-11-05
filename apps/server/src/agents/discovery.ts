/**
 * Problem clustering.
 *
 * Discovery produces a pile of evidence. This step groups it into problem
 * clusters that could plausibly be startups, and — critically — validates that
 * every cluster cites evidence ids that actually exist in the bundle. A
 * cluster referencing an invented id is rejected.
 */

import { z } from "zod";
import type { AgentKey, EvidenceItem, ProblemCluster } from "@origin/contracts";
import { problemClusterSchema } from "@origin/contracts";
import { logger } from "../lib/logger.js";
import { formatEvidence, runAgent, type AgentSpec } from "./runtime.js";

const clustersSchema = z.object({
  clusters: z.array(problemClusterSchema).min(1).max(6),
});

const CLUSTER_SPEC: AgentSpec = {
  key: "product-strategist",
  displayName: "Product Strategist",
  role: "Group raw signals into distinct problems that a small team could address.",
  lens: "You look for recurring, specific, painful problems with a clear sufferer, not broad themes. Two signals belong together only if the same person would experience them as the same problem.",
};

export interface ClusterResult {
  clusters: ProblemCluster[];
  rejected: Array<{ label: string; reason: string }>;
}

export async function clusterEvidence(evidence: EvidenceItem[]): Promise<ClusterResult> {
  if (evidence.length === 0) {
    throw new Error("Cannot cluster an empty evidence set");
  }

  const validIds = new Set(evidence.map((e) => e.id));

  const result = await runAgent({
    spec: CLUSTER_SPEC,
    schema: clustersSchema,
    taskKey: "cluster-evidence",
    maxOutputTokens: 16_000,
    instruction: [
      "Group the evidence below into between 2 and 5 distinct problem clusters.",
      "For each cluster: a short label, a precise problem statement written from the sufferer's point of view,",
      "a rationale explaining why these signals belong together, and the ids of the evidence that support it.",
      "Prefer a few well-supported clusters over many thin ones. If a signal fits nothing, leave it out.",
      "Every evidenceIds entry must be an id that appears in the bundle.",
    ].join(" "),
    context: formatEvidence(evidence, 70),
  });

  // Validate provenance: a cluster may only cite evidence that was retrieved.
  const accepted: ProblemCluster[] = [];
  const rejected: Array<{ label: string; reason: string }> = [];

  for (const cluster of result.value.clusters) {
    const unknown = cluster.evidenceIds.filter((id) => !validIds.has(id));
    if (unknown.length > 0) {
      rejected.push({
        label: cluster.label,
        reason: `cited ${unknown.length} evidence id(s) not present in the bundle: ${unknown.join(", ")}`,
      });
      continue;
    }
    // Recompute the signal count from the evidence rather than trusting it.
    accepted.push({
      ...cluster,
      evidenceIds: [...new Set(cluster.evidenceIds)],
      signalCount: new Set(cluster.evidenceIds).size,
    });
  }

  if (rejected.length > 0) {
    logger.warn(`Rejected ${rejected.length} cluster(s) for citing unknown evidence`);
  }
  if (accepted.length === 0) {
    throw new Error("Every proposed cluster cited evidence that does not exist in the bundle");
  }

  logger.info(`Clustered ${evidence.length} signals into ${accepted.length} problem clusters`);
  return { clusters: accepted, rejected };
}

export function agentKeyForClustering(): AgentKey {
  return CLUSTER_SPEC.key;
}
