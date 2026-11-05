/**
 * Build Studio.
 *
 * Shows the build as it happened: the generated files, the QA report with each
 * check, and the provenance of every failure. This is the screen that proves
 * the MVP is real rather than described.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  FileCode2,
  FolderOpen,
  Hammer,
  XCircle,
} from "lucide-react";
import type { Opportunity } from "@origin/contracts";
import { api } from "../lib/api";
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

export function BuildStudioPage() {
  const { id } = useParams<{ id?: string }>();
  const [opportunities, setOpportunities] = useState<Opportunity[] | null>(null);
  const [selected, setSelected] = useState<string | null>(id ?? null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.opportunities();
      const detailed = await Promise.all(
        list.opportunities
          .filter(
            (o) =>
              o.state === "APPROVED" ||
              o.state === "BUILDING" ||
              o.state === "TESTING" ||
              o.state === "COMPLETED" ||
              (o.state === "FAILED" && o.buildState !== null),
          )
          .map((o) => api.opportunity(o.id)),
      );
      const items = detailed.map((d) => d.opportunity);
      setOpportunities(items);
      if (!selected && items.length > 0) setSelected(items[0]!.id);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selected]);

  useEffect(() => {
    void load();
    const interval = setInterval(load, 6000);
    return () => clearInterval(interval);
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  if (!opportunities) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (opportunities.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Build Studio</h1>
          <p className="mt-1 text-xs text-muted">
            Approved opportunities are built here by the Builder agent.
          </p>
        </div>
        <EmptyState
          icon={<Hammer size={18} />}
          title="Nothing has been approved yet"
          description="When the jury and the founder both approve an opportunity, the Builder generates an MVP in an isolated workspace and QA tests it."
          action={
            <Link to="/opportunities">
              <Button size="sm">Review opportunities</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const current = opportunities.find((o) => o.id === selected) ?? opportunities[0]!;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Build Studio</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
          Generated projects run inside bubblewrap with no host filesystem access. QA executes
          them with no network and reports failures back to the Builder.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {opportunities.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => setSelected(o.id)}
            className={
              "max-w-[18rem] truncate rounded border px-2.5 py-1 text-2xs transition-colors " +
              (o.id === current.id
                ? "border-border-strong bg-surface text-content"
                : "border-transparent text-muted hover:bg-surface hover:text-content")
            }
          >
            {o.brief?.title ?? o.cluster.label}
          </button>
        ))}
      </div>

      <BuildDetail opportunity={current} />
    </div>
  );
}

function BuildDetail({ opportunity }: { opportunity: Opportunity }) {
  const [files, setFiles] = useState<Array<{ path: string; bytes: number }>>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    api
      .files(opportunity.id)
      .then((r) => {
        setFiles(r.files);
        if (r.files.length > 0 && !activeFile) setActiveFile(r.files[0]!.path);
      })
      .catch(() => setFiles([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opportunity.id]);

  useEffect(() => {
    if (!activeFile) {
      setContent(null);
      return;
    }
    api
      .file(opportunity.id, activeFile)
      .then((r) => {
        setContent(r.content);
        setFileError(null);
      })
      .catch((err: Error) => {
        setContent(null);
        setFileError(err.message);
      });
  }, [opportunity.id, activeFile]);

  const build = opportunity.build;
  const qa = build?.qa;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded border border-border bg-surface px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge state={opportunity.state} />
            {build ? (
              <Badge
                tone={
                  build.state === "completed"
                    ? "success"
                    : build.state === "failed"
                      ? "danger"
                      : "accent"
                }
              >
                {build.state}
              </Badge>
            ) : (
              <Badge>not started</Badge>
            )}
            {build ? (
              <span className="text-2xs text-muted">
                {build.attempts} attempt(s) · {build.files.length} files
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 text-sm font-medium text-content">
            {opportunity.brief?.title ?? opportunity.cluster.label}
          </p>
        </div>
        <Link to={`/opportunities/${opportunity.id}`}>
          <Button size="sm">Open opportunity</Button>
        </Link>
      </div>

      {!build ? (
        <EmptyState
          icon={<Hammer size={18} />}
          title="The build has not started"
          description="Approval triggers the build automatically. If you have just approved it, this view updates within a few seconds."
        />
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-5">
            <section className="lg:col-span-2">
              <SectionHeader
                title="Generated files"
                description={`${files.length} file(s) in the isolated workspace`}
              />
              {files.length === 0 ? (
                <EmptyState
                  icon={<FolderOpen size={16} />}
                  title="No files yet"
                  description="Files appear once the Builder writes them."
                />
              ) : (
                <ul className="max-h-80 overflow-y-auto rounded border border-border">
                  {files.map((file) => (
                    <li key={file.path}>
                      <button
                        type="button"
                        onClick={() => setActiveFile(file.path)}
                        className={
                          "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-2xs transition-colors " +
                          (activeFile === file.path
                            ? "bg-surface-hover text-content"
                            : "text-muted hover:bg-surface hover:text-content")
                        }
                      >
                        <FileCode2 size={11} className="shrink-0 text-subtle" />
                        <span className="truncate">{file.path}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="lg:col-span-3">
              <SectionHeader
                title={activeFile ?? "File contents"}
                description={
                  fileError ? fileError : "Read directly from the generated project"
                }
              />
              <pre className="max-h-80 overflow-auto rounded border border-border bg-bg p-3 text-2xs leading-relaxed text-muted">
                {content ?? (fileError ? fileError : "Select a file to view it.")}
              </pre>
            </section>
          </div>

          {qa ? (
            <section>
              <SectionHeader
                title="QA report"
                description="Run by the QA Agent inside the sandbox."
                action={
                  <Badge tone={qa.passed ? "success" : "danger"}>
                    {qa.passed ? "passed" : "failed"}
                  </Badge>
                }
              />
              <ul className="divide-y divide-border rounded border border-border">
                {qa.checks.map((check) => (
                  <li key={check.name} className="flex items-start gap-2.5 px-3.5 py-2.5">
                    {check.status === "passed" ? (
                      <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-success" />
                    ) : (
                      <XCircle size={13} className="mt-0.5 shrink-0 text-danger" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-xs text-content">{check.name}</p>
                        <span className="text-2xs text-subtle">{check.status}</span>
                      </div>
                      {check.detail ? (
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-2xs leading-relaxed text-muted">
                          {check.detail}
                        </pre>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-2xs text-muted">{qa.summary}</p>
            </section>
          ) : null}

          {build.error ? (
            <div className="rounded border border-danger/30 bg-danger/5 px-3 py-2.5">
              <p className="text-2xs font-medium text-danger">Build error</p>
              <p className="mt-1 whitespace-pre-wrap text-2xs leading-relaxed text-muted">
                {build.error}
              </p>
            </div>
          ) : null}

          {build.state === "completed" ? (
            <MvpPreview opportunityId={opportunity.id} />
          ) : null}

          {build.state !== "completed" && build.state !== "failed" ? (
            <div className="rounded border border-accent/25 bg-accent/5 px-3 py-2.5 text-2xs text-accent">
              Build in progress. This page refreshes automatically.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The MVP result.
 *
 * A generated Node app has no page to render, so this shows the artifact
 * honestly: what it is, how to run it, and its entry point. If the build did
 * produce static HTML, it is offered as a real preview link.
 */
function MvpPreview({ opportunityId }: { opportunityId: string }) {
  const [hasHtml, setHasHtml] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .files(opportunityId)
      .then((r) => setHasHtml(r.files.some((f) => f.path === "index.html")))
      .catch(() => setHasHtml(false));
  }, [opportunityId]);

  return (
    <section>
      <SectionHeader
        title="MVP result"
        description="Produced by the Builder and verified by QA."
      />
      <div className="rounded border border-success/25 bg-success/[0.04] px-4 py-3">
        <p className="text-xs text-success">
          The MVP built and passed its own test suite.
        </p>
        <p className="mt-1.5 text-2xs leading-relaxed text-muted">
          The generated project is a Node.js application. Inspect its files above, or run it
          locally from{" "}
          <code className="rounded bg-surface px-1 py-0.5 font-mono">
            workspace/{opportunityId}
          </code>{" "}
          with <code className="rounded bg-surface px-1 py-0.5 font-mono">node src/index.mjs</code>{" "}
          and <code className="rounded bg-surface px-1 py-0.5 font-mono">node --test</code>.
        </p>
        {hasHtml ? (
          <a
            href={`/api/opportunities/${opportunityId}/preview`}
            target="_blank"
            rel="noreferrer"
            className="mt-2.5 inline-block text-2xs text-accent hover:underline"
          >
            Open the generated page
          </a>
        ) : null}
      </div>
    </section>
  );
}
