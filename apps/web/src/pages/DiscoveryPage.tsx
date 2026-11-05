/**
 * Discovery.
 *
 * What the scouts actually retrieved, with the source link and the exact
 * retrieval time for every item. This page exists to make the evidence
 * inspectable rather than asserted.
 */

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Play, Radio } from "lucide-react";
import { api, type OpportunityListItem } from "../lib/api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  relativeTime,
  SectionHeader,
  Skeleton,
  StateBadge,
} from "../components/primitives";
import { Link } from "react-router-dom";

export function DiscoveryPage() {
  const [opportunities, setOpportunities] = useState<OpportunityListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.opportunities();
      setOpportunities(result.opportunities);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [load]);

  const run = async () => {
    setStarting(true);
    try {
      await api.runDiscovery();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  if (error && !opportunities) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Discovery</h1>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
            The Social Scout reads Hacker News and the Developer Scout reads GitHub issues.
            Signals are clustered into problems, and every cluster keeps its sources.
          </p>
        </div>
        <Button variant="primary" onClick={run} loading={starting}>
          <Play size={14} />
          Run discovery
        </Button>
      </div>

      {error ? (
        <div className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
          {error}
        </div>
      ) : null}

      <SectionHeader
        title="Problem clusters"
        description="Each cluster links to the exact public items that produced it."
      />

      {!opportunities ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : opportunities.length === 0 ? (
        <EmptyState
          icon={<Radio size={18} />}
          title="Nothing discovered yet"
          description="Run discovery to retrieve real signals from Hacker News and GitHub, then cluster them into candidate problems."
          action={
            <Button variant="primary" size="sm" onClick={run} loading={starting}>
              Run discovery
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {opportunities.map((opportunity) => (
            <li
              key={opportunity.id}
              className="rounded border border-border bg-surface px-4 py-3.5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/opportunities/${opportunity.id}`}
                      className="truncate text-xs font-medium text-content hover:underline"
                    >
                      {opportunity.title}
                    </Link>
                    <StateBadge state={opportunity.state} />
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-2xs leading-relaxed text-muted">
                    {opportunity.problem}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-2xs text-subtle">
                    <Badge>{opportunity.signalCount} signals</Badge>
                    <span>{relativeTime(opportunity.updatedAt)}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setEvidenceId(evidenceId === opportunity.id ? null : opportunity.id)
                      }
                      className="text-accent hover:underline"
                    >
                      {evidenceId === opportunity.id ? "Hide evidence" : "Show evidence"}
                    </button>
                  </div>
                </div>
              </div>

              {evidenceId === opportunity.id ? (
                <EvidenceList opportunityId={opportunity.id} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EvidenceList({ opportunityId }: { opportunityId: string }) {
  const [rows, setRows] = useState<
    Awaited<ReturnType<typeof api.evidence>> | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .evidence(opportunityId)
      .then(setRows)
      .catch((err: Error) => setError(err.message));
  }, [opportunityId]);

  if (error) {
    return <p className="mt-3 text-2xs text-danger">{error}</p>;
  }
  if (!rows) {
    return <Skeleton className="mt-3 h-16 w-full" />;
  }

  return (
    <div className="mt-3 max-h-72 overflow-y-auto rounded border border-border">
      <ul className="divide-y divide-border">
        {rows.evidence.map((item) => (
          <li key={item.id} className="px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="group flex min-w-0 items-start gap-1.5 text-2xs text-content hover:text-accent"
              >
                <span className="line-clamp-2">{item.title}</span>
                <ExternalLink
                  size={10}
                  className="mt-0.5 shrink-0 text-subtle group-hover:text-accent"
                />
              </a>
              <span className="shrink-0 text-2xs text-subtle">
                {item.source === "hacker-news" ? "HN" : "GitHub"}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-subtle">
              <span className="tabular">retrieved {relativeTime(item.retrievedAt)}</span>
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
