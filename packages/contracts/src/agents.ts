import { z } from "zod";

/** The three collaboration rooms Origin projects into SWITCH. */
export const ROOM_KEYS = ["discovery-lab", "startup-council", "build-studio"] as const;
export type RoomKey = (typeof ROOM_KEYS)[number];

/**
 * Identifies one of the nine logical agents. This key is the stable join
 * between the domain model, the UI and the SWITCH registration record.
 */
export const AGENT_KEYS = [
  "social-scout",
  "developer-scout",
  "market-researcher",
  "competitor-analyst",
  "product-strategist",
  "investor",
  "technical-architect",
  "customer-advocate",
  "builder",
  "qa-agent",
] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

export const AGENT_TEAMS = ["discovery", "research", "jury", "build"] as const;
export type AgentTeam = (typeof AGENT_TEAMS)[number];

export const AGENT_SPECS: ReadonlyArray<{
  key: AgentKey;
  name: string;
  displayName: string;
  team: AgentTeam;
  room: RoomKey;
  description: string;
}> = [
  {
    key: "social-scout",
    name: "origin-social-scout",
    displayName: "Social Scout",
    team: "discovery",
    room: "discovery-lab",
    description:
      "Finds complaints, frustrations and unmet needs in public discussion forums.",
  },
  {
    key: "developer-scout",
    name: "origin-developer-scout",
    displayName: "Developer Scout",
    team: "discovery",
    room: "discovery-lab",
    description:
      "Finds recurring developer problems and missing tooling in GitHub issues.",
  },
  {
    key: "market-researcher",
    name: "origin-market-researcher",
    displayName: "Market Researcher",
    team: "research",
    room: "startup-council",
    description:
      "Assesses demand, target audiences and available evidence for a problem cluster.",
  },
  {
    key: "competitor-analyst",
    name: "origin-competitor-analyst",
    displayName: "Competitor Analyst",
    team: "research",
    room: "startup-council",
    description:
      "Maps existing solutions, compares capabilities and identifies underserved segments.",
  },
  {
    key: "product-strategist",
    name: "origin-product-strategist",
    displayName: "Product Strategist",
    team: "research",
    room: "startup-council",
    description:
      "Turns research into a structured opportunity brief and chairs the council.",
  },
  {
    key: "investor",
    name: "origin-investor",
    displayName: "Investor",
    team: "jury",
    room: "startup-council",
    description:
      "Evaluates market potential, monetization and scalability.",
  },
  {
    key: "technical-architect",
    name: "origin-technical-architect",
    displayName: "Technical Architect",
    team: "jury",
    room: "startup-council",
    description:
      "Evaluates technical feasibility, implementation complexity and delivery risk.",
  },
  {
    key: "customer-advocate",
    name: "origin-customer-advocate",
    displayName: "Customer Advocate",
    team: "jury",
    room: "startup-council",
    description:
      "Evaluates problem severity, user needs and whether the solution is genuinely useful.",
  },
  {
    key: "builder",
    name: "origin-builder",
    displayName: "Builder",
    team: "build",
    room: "build-studio",
    description:
      "Generates the approved MVP in an isolated workspace using a coding agent.",
  },
  {
    key: "qa-agent",
    name: "origin-qa-agent",
    displayName: "QA Agent",
    team: "build",
    room: "build-studio",
    description:
      "Runs the generated project's tests, checks functionality and requests fixes.",
  },
];

export const ROOM_SPECS: ReadonlyArray<{
  key: RoomKey;
  name: string;
  description: string;
  agents: readonly AgentKey[];
}> = [
  {
    key: "discovery-lab",
    name: "discovery-lab",
    description:
      "Problem discovery. Raw signals from Hacker News and GitHub, with source links and retrieval timestamps.",
    agents: ["social-scout", "developer-scout"],
  },
  {
    key: "startup-council",
    name: "startup-council",
    description:
      "Research findings, jury deliberation and the founder's vote on each opportunity.",
    agents: [
      "market-researcher",
      "competitor-analyst",
      "product-strategist",
      "investor",
      "technical-architect",
      "customer-advocate",
    ],
  },
  {
    key: "build-studio",
    name: "build-studio",
    description:
      "Autonomous MVP build, test runs and preview for approved opportunities.",
    agents: ["builder", "qa-agent"],
  },
];

export const ROOM_ROLES = {
  scout: {
    room: "discovery-lab" as RoomKey,
    instructions:
      "You are a scout. Report only signals you actually retrieved, each with its source URL and retrieval timestamp. Never invent a complaint, a thread or a quotation.",
  },
  researcher: {
    room: "startup-council" as RoomKey,
    instructions:
      "You are a researcher. Ground every claim in the supplied evidence bundle. Where evidence is thin, say so explicitly rather than extrapolating.",
  },
  juror: {
    room: "startup-council" as RoomKey,
    instructions:
      "You are a juror. Assess the same frozen evidence bundle independently. State your vote and reasoning; do not defer to other jurors.",
  },
  chair: {
    room: "startup-council" as RoomKey,
    instructions:
      "You chair the council. Summarise the juror positions and name their disagreements. You do not cast a juror vote.",
  },
  builder: {
    room: "build-studio" as RoomKey,
    instructions:
      "You are the builder. Implement only the approved MVP specification, inside the isolated workspace. Never run generated code on the host.",
  },
  qa: {
    room: "build-studio" as RoomKey,
    instructions:
      "You are QA. Run the project's own test suite, report failures verbatim and request a fix from the builder. Do not fix code yourself.",
  },
} as const;

export const switchAgentRegistrationSchema = z.object({
  key: z.enum(AGENT_KEYS),
  switchAgentId: z.string().min(1),
  apiKey: z.string().min(1),
  registeredAt: z.string().datetime(),
});
export type SwitchAgentRegistration = z.infer<typeof switchAgentRegistrationSchema>;

export const switchRoomRecordSchema = z.object({
  key: z.enum(ROOM_KEYS),
  switchRoomId: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().datetime(),
  bridged: z.boolean(),
});
export type SwitchRoomRecord = z.infer<typeof switchRoomRecordSchema>;
