/**
 * Opportunity detail.
 *
 * The screen where a founder decides. It presents, in order:
 *   the problem and its evidence, the brief, the market and competitor view,
 *   the three independent verdicts, the deliberation, and the vote control.
 *
 * Nothing is summarised away: every score, argument and source is reachable.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  FileText,
  Hammer,
  MessageSquare,
  Scale,
  X,
} from "lucide-react";
import type { Opportunity } from "@origin/contracts";
import {
  api,
  type EvidenceRow,
  type TransitionRow,
} from "../lib/api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  relativeTime,
  ScoreBar,
  SectionHeader,
  Skeleton,
  StateBadge,
} from "../components/primitives";
import { VotePanel } from "../components/VotePanel";
import { JuryPanel } from "../components/JuryPanel";

type Tab = "brief" | "evidence" | "jury" | "history";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "brief", label: "Brief" },
  { key: "evidence", label: "Evidence" },
  { key: "jury", label: "Jury" },
  { key: "history", label: "History" },
];

export function OpportunityPage() {
  const { id } = useParams<{ id: string }>();
  const [opportunity, setOpportunity] = useState<Opportunity | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
  const [transitions, setTransitions] = useState<TransitionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("brief");

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [detail, ev, tr] = await Promise.all([
        api.opportunity(id),
        api.evidence(id),
        api.transitions(id),
      ]);
      setOpportunity(detail.opportunity);
      setEvidence(ev.evidence);
      setTransitions(tr.transitions);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
    const interval = setInterval(load, 6000);
    return () => clearInterval(interval);
  }, [load]);

  if (error) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  if (!opportunity) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const title = opportunity.brief?.title ?? opportunity.cluster.label;
  const yes = opportunity.verdicts.filter((v) => v.vote === "yes").length;

  return (
    <div className="space-y-6">
      <Link
        to="/opportunities"
        className="inline-flex items-center gap-1.5 text-2xs text-muted transition-colors hover:text-content"
      >
        <ArrowLeft size={12} /> All opportunities
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge state={opportunity.state} />
            <Badge>{opportunity.cluster.signalCount} signals</Badge>
            {opportunity.verdicts.length > 0 ? (
              <Badge tone={yes >= 2 ? "success" : "neutral"}>{yes}/3 jurors yes</Badge>
            ) : null}
            {opportunity.humanVote ? (
              <Badge tone={opportunity.humanVote.decision === "yes" ? "success" : "danger"}>
                Founder: {opportunity.humanVote.decision}
              </Badge>
            ) : null}
          </div>
          <h1 className="mt-2.5 text-lg font-semibold leading-snug tracking-tight">{title}</h1>
          <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-muted">
            {opportunity.cluster.problemStatement}
          </p>
        </div>
      </div>

      <OpportunityActions opportunity={opportunity} onChanged={() => void load()} />

      {opportunity.state === "AWAITING_HUMAN_VOTE" ? (
        <VotePanel opportunity={opportunity} onVoted={() => void load()} />
      ) : null}

      {opportunity.state === "APPROVED" && opportunity.build?.state !== "completed" ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-success/30 bg-success/5 px-4 py-3">
          <div className="flex items-center gap-2">
            <Hammer size={14} className="text-success" />
            <p className="text-xs text-success">
              Approved. The build begins automatically; you can also start it explicitly.
            </p>
          </div>
          <Link to={`/build/${opportunity.id}`}>
            <Button size="sm" variant="primary">
              Open Build Studio
            </Button>
          </Link>
        </div>
      ) : null}

      {opportunity.build ? (
        <div className="rounded border border-border bg-surface px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Badge
                tone={
                  opportunity.build.state === "completed"
                    ? "success"
                    : opportunity.build.state === "failed"
                      ? "danger"
                      : "accent"
                }
              >
                Build {opportunity.build.state}
              </Badge>
              <span className="text-2xs text-muted">
                {opportunity.build.files.length} files, {opportunity.build.attempts} attempt(s)
              </span>
            </div>
            <Link to={`/build/${opportunity.id}`}>
              <Button size="sm">Inspect build</Button>
            </Link>
          </div>
        </div>
      ) : null}

      <div className="border-b border-border">
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={
                "border-b-2 px-3 py-2 text-xs transition-colors " +
                (tab === t.key
                  ? "border-accent text-content"
                  : "border-transparent text-muted hover:text-content")
              }
            >
              {t.label}
              {t.key === "evidence" ? (
                <span className="tabular ml-1.5 text-subtle">{evidence.length}</span>
              ) : null}
            </button>
          ))}
        </nav>
      </div>

      {tab === "brief" ? <BriefTab opportunity={opportunity} /> : null}
      {tab === "evidence" ? <EvidenceTab evidence={evidence} /> : null}
      {tab === "jury" ? (
        <JuryPanel
          verdicts={opportunity.verdicts}
          deliberation={opportunity.deliberation}
          tally={opportunity.tally}
          humanVote={opportunity.humanVote}
        />
      ) : null}
      {tab === "history" ? <HistoryTab transitions={transitions} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function OpportunityActions({
  opportunity,
  onChanged,
}: {
  opportunity: Opportunity;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      // The phase continues server-side; the page polls for the result.
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const canResearch = opportunity.state === "DISCOVERING";
  const canJury = opportunity.state === "RESEARCHING" && Boolean(opportunity.brief);
  const canBuild = opportunity.state === "APPROVED";

  if (!canResearch && !canJury && !canBuild) {
    return error ? (
      <div className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
        {error}
      </div>
    ) : null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-surface px-4 py-3">
      <span className="text-2xs text-muted">Next step:</span>
      {canResearch ? (
        <Button
          size="sm"
          variant="primary"
          loading={busy === "research"}
          onClick={() => void run("research", () => api.runResearch(opportunity.id))}
        >
          Research this problem
        </Button>
      ) : null}
      {canJury ? (
        <Button
          size="sm"
          variant="primary"
          loading={busy === "jury"}
          onClick={() => void run("jury", () => api.runJury(opportunity.id))}
        >
          <Scale size={13} /> Convene the jury
        </Button>
      ) : null}
      {canBuild ? (
        <Button
          size="sm"
          variant="primary"
          loading={busy === "build"}
          onClick={() => void run("build", () => api.runBuild(opportunity.id))}
        >
          <Hammer size={13} /> Start build
        </Button>
      ) : null}
      {error ? <span className="text-2xs text-danger">{error}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function BriefTab({ opportunity }: { opportunity: Opportunity }) {
  const brief = opportunity.brief;
  if (!brief) {
    return (
      <EmptyState
        icon={<FileText size={18} />}
        title="No brief yet"
        description="The research team produces a brief once this problem is selected for research."
      />
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <section>
          <SectionHeader title="Problem" />
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted">
            {brief.problemStatement}
          </p>
        </section>

        <section>
          <SectionHeader title="Proposed solution" />
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted">
            {brief.proposedSolution}
          </p>
        </section>

        <section>
          <SectionHeader
            title="MVP features"
            description="What the builder is asked to ship, in priority order."
          />
          <ul className="divide-y divide-border rounded border border-border">
            {brief.mvpFeatures.map((feature) => (
              <li key={feature.title} className="px-3.5 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-content">{feature.title}</p>
                    <p className="mt-0.5 text-2xs leading-relaxed text-muted">
                      {feature.description}
                    </p>
                  </div>
                  <Badge
                    tone={
                      feature.priority === "must"
                        ? "accent"
                        : feature.priority === "should"
                          ? "neutral"
                          : "neutral"
                    }
                  >
                    {feature.priority}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <SectionHeader title="Risks" />
          <ul className="space-y-1.5">
            {brief.risks.map((risk) => (
              <li key={risk} className="flex gap-2 text-xs leading-relaxed text-muted">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warning" />
                {risk}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <aside className="space-y-5">
        <div className="rounded border border-border bg-surface p-3.5">
          <p className="text-2xs font-medium uppercase tracking-wider text-subtle">
            Confidence
          </p>
          <div className="mt-2">
            <ScoreBar score={brief.confidence} />
          </div>
        </div>

        <div className="rounded border border-border bg-surface p-3.5">
          <p className="text-2xs font-medium uppercase tracking-wider text-subtle">
            Target users
          </p>
          <ul className="mt-2 space-y-1">
            {brief.targetUsers.map((user) => (
              <li key={user} className="text-xs text-muted">
                {user}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded border border-border bg-surface p-3.5">
          <p className="text-2xs font-medium uppercase tracking-wider text-subtle">
            Business model
          </p>
          <p className="mt-2 text-xs leading-relaxed text-muted">{brief.businessModel}</p>
        </div>

        {opportunity.market ? (
          <div className="rounded border border-border bg-surface p-3.5">
            <p className="text-2xs font-medium uppercase tracking-wider text-subtle">
              Market
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Badge
                tone={
                  opportunity.market.demand === "high"
                    ? "success"
                    : opportunity.market.demand === "low"
                      ? "danger"
                      : "warning"
                }
              >
                {opportunity.market.demand} demand
              </Badge>
              <span className="tabular text-2xs text-muted">
                {opportunity.market.confidence}/100
              </span>
            </div>
            <p className="mt-2 text-2xs leading-relaxed text-muted">
              {opportunity.market.reasoning}
            </p>
            {opportunity.market.evidenceGaps.length > 0 ? (
              <div className="mt-2.5 border-t border-border pt-2.5">
                <p className="text-2xs font-medium text-subtle">Evidence gaps</p>
                <ul className="mt-1 space-y-0.5">
                  {opportunity.market.evidenceGaps.map((gap) => (
                    <li key={gap} className="text-2xs leading-relaxed text-muted">
                      · {gap}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {opportunity.competitors ? (
          <div className="rounded border border-border bg-surface p-3.5">
            <p className="text-2xs font-medium uppercase tracking-wider text-subtle">
              Competitors
            </p>
            {opportunity.competitors.competitors.length === 0 ? (
              <p className="mt-2 text-2xs text-muted">None identified in the evidence.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {opportunity.competitors.competitors.slice(0, 6).map((c) => (
                  <li key={c.name}>
                    <p className="text-xs text-content">{c.name}</p>
                    {c.weaknesses.length > 0 ? (
                      <p className="text-2xs leading-relaxed text-muted">
                        {c.weaknesses[0]}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2.5 border-t border-border pt-2.5 text-2xs leading-relaxed text-muted">
              {opportunity.competitors.differentiation}
            </p>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function EvidenceTab({ evidence }: { evidence: EvidenceRow[] }) {
  if (evidence.length === 0) {
    return (
      <EmptyState
        icon={<MessageSquare size={18} />}
        title="No evidence stored"
        description="Evidence is captured during discovery and kept with the opportunity."
      />
    );
  }

  const hn = evidence.filter((e) => e.source === "hacker-news").length;
  const gh = evidence.length - hn;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-2xs text-muted">
        <span>
          {evidence.length} sources: {hn} Hacker News, {gh} GitHub
        </span>
        <span className="text-subtle">
          Every item keeps its URL and the exact time it was retrieved.
        </span>
      </div>
      <ul className="divide-y divide-border rounded border border-border">
        {evidence.map((item) => (
          <li key={item.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="group flex min-w-0 items-start gap-1.5"
              >
                <span className="text-xs font-medium text-content group-hover:text-accent">
                  {item.title}
                </span>
                <ExternalLink
                  size={11}
                  className="mt-1 shrink-0 text-subtle group-hover:text-accent"
                />
              </a>
              <Badge>{item.source === "hacker-news" ? "HN" : "GitHub"}</Badge>
            </div>
            {item.excerpt ? (
              <p className="mt-1.5 line-clamp-2 text-2xs leading-relaxed text-muted">
                {item.excerpt}
              </p>
            ) : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-3 text-2xs text-subtle">
              <span className="tabular">
                retrieved {new Date(item.retrievedAt).toLocaleString()}
              </span>
              {item.author ? <span>by {item.author}</span> : null}
              {item.score !== undefined ? <span>score {item.score}</span> : null}
              {item.commentCount !== undefined ? (
                <span>{item.commentCount} comments</span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HistoryTab({ transitions }: { transitions: TransitionRow[] }) {
  if (transitions.length === 0) {
    return <EmptyState title="No transitions recorded yet" />;
  }

  return (
    <ol className="relative space-y-0 border-l border-border pl-5">
      {transitions
        .slice()
        .reverse()
        .map((t) => (
          <li key={t.id} className="relative pb-5 last:pb-0">
            <span className="absolute -left-[1.4rem] top-1 h-1.5 w-1.5 rounded-full bg-border-strong" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-2xs text-subtle">{t.from}</span>
              <span className="text-subtle">→</span>
              <StateBadge state={t.to} />
              <span className="text-2xs text-subtle">{relativeTime(t.at)}</span>
            </div>
            <p className="mt-1 text-xs text-muted">{t.reason}</p>
            <p className="mt-0.5 text-2xs text-subtle">by {t.actor}</p>
          </li>
        ))}
    </ol>
  );
}
