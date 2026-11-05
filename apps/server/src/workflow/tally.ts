/**
 * The vote tally.
 *
 * Approval requires both conditions, and this function is the only place that
 * decides. It is pure, so it is exhaustively testable, and it refuses to
 * approve if the human vote is missing — regardless of the AI result.
 */

import type { JurorVerdict, VoteTally } from "@origin/contracts";

export const AI_YES_REQUIRED = 2;

export function tallyVotes(
  verdicts: JurorVerdict[],
  humanVote: "yes" | "no" | "pending",
): VoteTally {
  const aiYes = verdicts.filter((v) => v.vote === "yes").length;
  const aiNo = verdicts.filter((v) => v.vote === "no").length;

  if (verdicts.length !== 3) {
    return {
      aiYes,
      aiNo,
      aiRequired: AI_YES_REQUIRED,
      humanVote,
      approved: false,
      reason: `Expected 3 juror verdicts, received ${verdicts.length}. Approval is not evaluated on incomplete deliberation.`,
    };
  }

  const aiSatisfied = aiYes >= AI_YES_REQUIRED;

  if (!aiSatisfied) {
    return {
      aiYes,
      aiNo,
      aiRequired: AI_YES_REQUIRED,
      humanVote,
      approved: false,
      reason: `Only ${aiYes} of 3 jurors voted yes; at least ${AI_YES_REQUIRED} are required.`,
    };
  }

  if (humanVote === "pending") {
    return {
      aiYes,
      aiNo,
      aiRequired: AI_YES_REQUIRED,
      humanVote,
      approved: false,
      reason: `Jury approved (${aiYes}/3). Waiting for the human founder's vote.`,
    };
  }

  if (humanVote === "no") {
    return {
      aiYes,
      aiNo,
      aiRequired: AI_YES_REQUIRED,
      humanVote,
      approved: false,
      reason: `Jury approved (${aiYes}/3) but the human founder rejected the opportunity.`,
    };
  }

  return {
    aiYes,
    aiNo,
    aiRequired: AI_YES_REQUIRED,
    humanVote,
    approved: true,
    reason: `Approved: ${aiYes}/3 jurors and the human founder voted yes.`,
  };
}
