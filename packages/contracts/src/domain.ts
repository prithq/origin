import { z } from "zod";
import { AGENT_KEYS, ROOM_KEYS } from "./agents.js";
import { WORKFLOW_STATES } from "./workflow.js";

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const EVIDENCE_SOURCES = ["hacker-news", "github"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/**
 * A single retrieved item. `url` and `retrievedAt` are required: an evidence
 * row without a resolvable source and a retrieval timestamp is rejected by the
 * schema, which is what stops the system presenting invented demand.
 */
export const evidenceItemSchema = z.object({
  id: z.string().min(1),
  source: z.enum(EVIDENCE_SOURCES),
  title: z.string().min(1),
  url: z.string().url(),
  retrievedAt: z.string().datetime(),
  author: z.string().optional(),
  excerpt: z.string().default(""),
  score: z.number().optional(),
  commentCount: z.number().optional(),
  tags: z.array(z.string()).default([]),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const problemClusterSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  problemStatement: z.string().min(1),
  rationale: z.string().min(1),
  evidenceIds: z.array(z.string()).min(1),
  signalCount: z.number().int().nonnegative(),
});
export type ProblemCluster = z.infer<typeof problemClusterSchema>;

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

export const demandLevelSchema = z.enum(["high", "medium", "low", "unknown"]);

export const marketAssessmentSchema = z.object({
  demand: demandLevelSchema,
  confidence: z.number().min(0).max(100),
  targetAudiences: z.array(
    z.object({
      segment: z.string().min(1),
      description: z.string().min(1),
      urgency: z.number().min(0).max(100),
    }),
  ).min(1),
  evidenceIds: z.array(z.string()).min(1),
  reasoning: z.string().min(1),
  evidenceGaps: z.array(z.string()).default([]),
});
export type MarketAssessment = z.infer<typeof marketAssessmentSchema>;

export const competitorMapSchema = z.object({
  competitors: z.array(
    z.object({
      name: z.string().min(1),
      url: z.string().url().optional(),
      capabilities: z.array(z.string()).default([]),
      weaknesses: z.array(z.string()).default([]),
    }),
  ),
  underservedSegments: z.array(z.string()).default([]),
  differentiation: z.string().min(1),
  reasoning: z.string().min(1),
});
export type CompetitorMap = z.infer<typeof competitorMapSchema>;

export const mvpFeatureSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(["must", "should", "could"]),
});

export const opportunityBriefSchema = z.object({
  title: z.string().min(1),
  problemStatement: z.string().min(1),
  targetUsers: z.array(z.string().min(1)).min(1),
  proposedSolution: z.string().min(1),
  mvpFeatures: z.array(mvpFeatureSchema).min(1),
  businessModel: z.string().min(1),
  risks: z.array(z.string()).min(1),
  successCriteria: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(100),
});
export type OpportunityBrief = z.infer<typeof opportunityBriefSchema>;

// ---------------------------------------------------------------------------
// Jury
// ---------------------------------------------------------------------------

export const JUROR_KEYS = ["investor", "technical-architect", "customer-advocate"] as const;
export type JurorKey = (typeof JUROR_KEYS)[number];

/**
 * A juror verdict. Note what is absent: there is no human-vote field. An LLM
 * cannot produce a human decision through this schema, by construction.
 */
export const jurorVerdictSchema = z.object({
  juror: z.enum(JUROR_KEYS),
  vote: z.enum(["yes", "no"]),
  score: z.number().min(0).max(100),
  summary: z.string().min(1),
  reasoning: z.string().min(1),
  supportingEvidenceIds: z.array(z.string()).default([]),
  concerns: z.array(z.string()).default([]),
  conditionsForApproval: z.array(z.string()).default([]),
});
export type JurorVerdict = z.infer<typeof jurorVerdictSchema>;

export const deliberationSchema = z.object({
  agreements: z.array(z.string()).default([]),
  disagreements: z.array(z.string()).default([]),
  summary: z.string().min(1),
  recommendedAction: z.enum(["proceed-to-vote", "reject"]),
});
export type Deliberation = z.infer<typeof deliberationSchema>;

// ---------------------------------------------------------------------------
// Votes
// ---------------------------------------------------------------------------

/**
 * Where a vote came from. `mattermost` and `switch-room` are genuine SWITCH
 * events from a human participant; `origin-console` is the authenticated
 * human fallback. `agent` is never a valid human vote source and is rejected
 * by the vote recorder.
 */
export const HUMAN_VOTE_CHANNELS = ["mattermost", "switch-room", "origin-console"] as const;

export const humanVoteSchema = z.object({
  decision: z.enum(["yes", "no"]),
  channel: z.enum(HUMAN_VOTE_CHANNELS),
  voterName: z.string().min(1),
  /** Opaque SWITCH participant id, when the vote arrived through SWITCH. */
  switchSenderId: z.string().optional(),
  /** SWITCH message id, retained as tamper-evident provenance. */
  switchMessageId: z.string().optional(),
  castAt: z.string().datetime(),
  note: z.string().optional(),
});
export type HumanVote = z.infer<typeof humanVoteSchema>;

export const voteTallySchema = z.object({
  aiYes: z.number().int().nonnegative(),
  aiNo: z.number().int().nonnegative(),
  aiRequired: z.number().int().positive(),
  humanVote: z.enum(["yes", "no", "pending"]),
  approved: z.boolean(),
  reason: z.string(),
});
export type VoteTally = z.infer<typeof voteTallySchema>;

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export const buildFileSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});

export const qaCheckSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  detail: z.string().default(""),
});
export type QaCheck = z.infer<typeof qaCheckSchema>;

export const qaReportSchema = z.object({
  passed: z.boolean(),
  checks: z.array(qaCheckSchema).min(1),
  failures: z.array(z.string()).default([]),
  summary: z.string().min(1),
});
export type QaReport = z.infer<typeof qaReportSchema>;

export const buildStatusSchema = z.object({
  state: z.enum(["pending", "running", "testing", "completed", "failed"]),
  workspaceId: z.string(),
  files: z.array(buildFileSchema).default([]),
  qa: qaReportSchema.optional(),
  attempts: z.number().int().nonnegative().default(0),
  error: z.string().optional(),
  previewPath: z.string().optional(),
});
export type BuildStatus = z.infer<typeof buildStatusSchema>;

// ---------------------------------------------------------------------------
// Activity and opportunities
// ---------------------------------------------------------------------------

export const ACTIVITY_LEVELS = ["info", "success", "warning", "error"] as const;

export const activityEventSchema = z.object({
  id: z.string().min(1),
  at: z.string().datetime(),
  agentKey: z.enum(AGENT_KEYS).optional(),
  room: z.enum(ROOM_KEYS).optional(),
  phase: z.string().min(1),
  level: z.enum(ACTIVITY_LEVELS),
  summary: z.string().min(1),
  detail: z.string().optional(),
  /** True when this event arrived over the real SWITCH transport. */
  viaSwitch: z.boolean().default(false),
  opportunityId: z.string().optional(),
});
export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const opportunitySchema = z.object({
  id: z.string().min(1),
  state: z.enum(WORKFLOW_STATES),
  cluster: problemClusterSchema,
  brief: opportunityBriefSchema.optional(),
  market: marketAssessmentSchema.optional(),
  competitors: competitorMapSchema.optional(),
  verdicts: z.array(jurorVerdictSchema).default([]),
  deliberation: deliberationSchema.optional(),
  humanVote: humanVoteSchema.optional(),
  tally: voteTallySchema.optional(),
  build: buildStatusSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Opportunity = z.infer<typeof opportunitySchema>;

export const transitionSchema = z.object({
  id: z.string(),
  at: z.string().datetime(),
  from: z.enum(WORKFLOW_STATES),
  to: z.enum(WORKFLOW_STATES),
  actor: z.string(),
  reason: z.string(),
  opportunityId: z.string().optional(),
});
export type Transition = z.infer<typeof transitionSchema>;
