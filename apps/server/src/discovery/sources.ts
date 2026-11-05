/**
 * Evidence retrieval.
 *
 * Both sources record what was actually fetched: the canonical URL and the
 * retrieval timestamp. Nothing here generates a claim; it only collects
 * artefacts a reader can open. If a source fails, the failure is reported,
 * not filled in with invented content.
 */

import { createHash } from "node:crypto";
import type { EvidenceItem } from "@origin/contracts";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

const HN_BASE = "https://hacker-news.firebaseio.com/v0";
const GITHUB_API = "https://api.github.com";

export interface DiscoveryResult {
  items: EvidenceItem[];
  errors: Array<{ source: string; message: string }>;
}

function evidenceId(source: string, nativeId: string): string {
  return createHash("sha1").update(`${source}:${nativeId}`).digest("hex").slice(0, 16);
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "origin-venture-studio", ...headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Hacker News
// ---------------------------------------------------------------------------

interface HnItem {
  id: number;
  type?: string;
  title?: string;
  text?: string;
  by?: string;
  score?: number;
  descendants?: number;
  time?: number;
  url?: string;
  dead?: boolean;
  deleted?: boolean;
}

const COMPLAINT_SIGNALS = [
  "why is there no",
  "why isn't there",
  "wish there was",
  "wish i could",
  "frustrat",
  "annoying",
  "painful",
  "nightmare",
  "hate",
  "struggle",
  "broken",
  "no good",
  "no way to",
  "manual",
  "spreadsheet",
  "ask hn",
  "show hn",
  "how do you",
  "recommendations for",
];

function looksLikeProblem(item: HnItem): boolean {
  const haystack = `${item.title ?? ""} ${item.text ?? ""}`.toLowerCase();
  if (!haystack.trim()) return false;
  return COMPLAINT_SIGNALS.some((signal) => haystack.includes(signal));
}

function stripHtml(html: string): string {
  return html
    .replace(/<p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetches recent Hacker News stories and keeps those that read like a problem
 * worth solving. The filter is a cheap keyword pre-pass that narrows the set
 * the LLM clusters; it is not presented as evidence of demand on its own.
 */
export async function fetchHackerNewsSignals(limit: number): Promise<DiscoveryResult> {
  const errors: Array<{ source: string; message: string }> = [];
  const retrievedAt = new Date().toISOString();
  let ids: number[] = [];

  try {
    ids = await fetchJson<number[]>(`${HN_BASE}/topstories.json`);
  } catch (err) {
    errors.push({ source: "hacker-news", message: (err as Error).message });
    return { items: [], errors };
  }

  const candidates = ids.slice(0, Math.max(limit * 4, 120));
  const items: EvidenceItem[] = [];

  // Bounded concurrency: enough to be quick, not enough to hammer the API.
  const batchSize = 12;
  for (let i = 0; i < candidates.length && items.length < limit; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((id) => fetchJson<HnItem>(`${HN_BASE}/item/${id}.json`)),
    );
    for (const result of settled) {
      if (result.status === "rejected") continue;
      const item = result.value;
      if (!item || item.dead || item.deleted || !item.title) continue;
      if (!looksLikeProblem(item)) continue;

      items.push({
        id: evidenceId("hn", String(item.id)),
        source: "hacker-news",
        title: item.title,
        url: `https://news.ycombinator.com/item?id=${item.id}`,
        retrievedAt,
        ...(item.by ? { author: item.by } : {}),
        excerpt: stripHtml(item.text ?? "").slice(0, 600),
        ...(typeof item.score === "number" ? { score: item.score } : {}),
        ...(typeof item.descendants === "number" ? { commentCount: item.descendants } : {}),
        tags: [],
      });
      if (items.length >= limit) break;
    }
  }

  logger.info(`Hacker News: ${items.length} problem-shaped signals from ${candidates.length} stories`);
  return { items, errors };
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

interface GithubSearchResponse {
  total_count: number;
  items: Array<{
    id: number;
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string } | null;
    labels: Array<{ name: string }>;
    comments: number;
    reactions?: { total_count: number };
    repository_url: string;
  }>;
}

/**
 * Searches open GitHub issues for recurring developer pain.
 *
 * The unauthenticated limit is 60 requests/hour, so this makes a small fixed
 * number of searches rather than one per topic. Rate limiting is reported as
 * an error rather than being hidden, because thin evidence should be visible.
 */
export async function fetchGithubSignals(limit: number): Promise<DiscoveryResult> {
  const errors: Array<{ source: string; message: string }> = [];
  const retrievedAt = new Date().toISOString();
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (config.GITHUB_TOKEN) headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;

  const queries = [
    "is:issue is:open label:bug comments:>20",
    "is:issue is:open label:enhancement comments:>15",
    "is:issue is:open in:title tooling",
  ];

  const seen = new Set<string>();
  const items: EvidenceItem[] = [];

  for (const q of queries) {
    if (items.length >= limit) break;
    const perPage = Math.min(20, limit - items.length);
    const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&sort=comments&order=desc&per_page=${perPage}`;
    try {
      const data = await fetchJson<GithubSearchResponse>(url, headers);
      for (const issue of data.items ?? []) {
        if (seen.has(issue.html_url)) continue;
        seen.add(issue.html_url);
        const repo = issue.repository_url.split("/repos/")[1] ?? "";
        items.push({
          id: evidenceId("gh", String(issue.id)),
          source: "github",
          title: `${repo}#${issue.number}: ${issue.title}`,
          url: issue.html_url,
          retrievedAt,
          ...(issue.user?.login ? { author: issue.user.login } : {}),
          excerpt: (issue.body ?? "").replace(/\s+/g, " ").slice(0, 600),
          commentCount: issue.comments,
          ...(issue.reactions ? { score: issue.reactions.total_count } : {}),
          tags: (issue.labels ?? []).map((l) => l.name).slice(0, 6),
        });
        if (items.length >= limit) break;
      }
    } catch (err) {
      errors.push({ source: "github", message: `${q}: ${(err as Error).message}` });
    }
  }

  logger.info(`GitHub: ${items.length} issue signals${errors.length ? ` (${errors.length} errors)` : ""}`);
  return { items, errors };
}

export async function runDiscovery(): Promise<DiscoveryResult> {
  const [hn, gh] = await Promise.all([
    fetchHackerNewsSignals(config.DISCOVERY_HN_MAX_STORIES),
    fetchGithubSignals(config.DISCOVERY_GITHUB_MAX_ISSUES),
  ]);

  const all = [...hn.items, ...gh.items];
  // Sources can legitimately overlap; keep one row per canonical URL.
  const unique = new Map<string, EvidenceItem>();
  for (const item of all) unique.set(item.url, item);

  return {
    items: [...unique.values()],
    errors: [...hn.errors, ...gh.errors],
  };
}
