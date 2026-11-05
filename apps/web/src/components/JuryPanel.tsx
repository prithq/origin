/**
 * Jury results.
 *
 * Shows the three verdicts side by side so the split is visible at a glance,
 * then the deliberation that names the disagreement, then the tally.
 *
 * The layout deliberately avoids implying consensus: each juror keeps their own
 * column and their own reasoning.
 */

import { Gavel, ThumbsDown, ThumbsUp } from "lucide-react";
import type {
  Deliberation,
  HumanVote,
  JurorVerdict,
  VoteTally,
} from "@origin/contracts";
import { Badge, EmptyState, ScoreBar, SectionHeader } from "./primitives";

const JUROR_LABEL: Record<string, string> = {
  investor: "Investor",
  "technical-architect": "Technical Architect",
  "customer-advocate": "Customer Advocate",
};

export function JuryPanel({
  verdicts,
  deliberation,
  tally,
  humanVote,
}: {
  verdicts: JurorVerdict[];
  deliberation?: Deliberation;
  tally?: VoteTally;
  humanVote?: HumanVote;
}) {
  if (verdicts.length === 0) {
    return (
      <EmptyState
        icon={<Gavel size={18} />}
        title="The jury has not convened"
        description="Once research produces a brief, the three jurors assess the same evidence independently."
      />
    );
  }

  return (
    <div className="space-y-7">
      <div className="grid gap-3 md:grid-cols-3">
        {verdicts.map((verdict) => (
          <article
            key={verdict.juror}
            className="flex flex-col rounded border border-border bg-surface"
          >
            <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
              <p className="text-xs font-medium text-content">
                {JUROR_LABEL[verdict.juror] ?? verdict.juror}
              </p>
              <Badge tone={verdict.vote === "yes" ? "success" : "danger"}>
                {verdict.vote === "yes" ? (
                  <ThumbsUp size={9} />
                ) : (
                  <ThumbsDown size={9} />
                )}
                {verdict.vote}
              </Badge>
            </div>

            <div className="border-b border-border px-3.5 py-2.5">
              <ScoreBar score={verdict.score} label="/ 100" />
            </div>

            <div className="flex-1 px-3.5 py-3">
              <p className="text-xs leading-relaxed text-muted">{verdict.summary}</p>
              <p className="mt-2 whitespace-pre-wrap text-2xs leading-relaxed text-muted">
                {verdict.reasoning}
              </p>

              {verdict.concerns.length > 0 ? (
                <div className="mt-3 border-t border-border pt-2.5">
                  <p className="text-2xs font-medium uppercase tracking-wider text-subtle">
                    Concerns
                  </p>
                  <ul className="mt-1 space-y-1">
                    {verdict.concerns.map((concern) => (
                      <li key={concern} className="text-2xs leading-relaxed text-muted">
                        · {concern}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {verdict.conditionsForApproval.length > 0 ? (
                <div className="mt-2.5 border-t border-border pt-2.5">
                  <p className="text-2xs font-medium uppercase tracking-wider text-subtle">
                    Conditions
                  </p>
                  <ul className="mt-1 space-y-1">
                    {verdict.conditionsForApproval.map((condition) => (
                      <li key={condition} className="text-2xs leading-relaxed text-muted">
                        · {condition}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>

      {deliberation ? (
        <section>
          <SectionHeader
            title="Deliberation"
            description="Chaired by the Product Strategist, who does not vote."
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded border border-border bg-surface p-3.5">
              <p className="text-2xs font-medium uppercase tracking-wider text-subtle">
                Summary
              </p>
              <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-muted">
                {deliberation.summary}
              </p>
            </div>

            <div className="space-y-3">
              {deliberation.disagreements.length > 0 ? (
                <div className="rounded border border-warning/25 bg-warning/[0.04] p-3.5">
                  <p className="text-2xs font-medium uppercase tracking-wider text-warning">
                    Disagreements
                  </p>
                  <ul className="mt-1.5 space-y-1.5">
                    {deliberation.disagreements.map((d) => (
                      <li key={d} className="text-2xs leading-relaxed text-muted">
                        · {d}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {deliberation.agreements.length > 0 ? (
                <div className="rounded border border-border bg-surface p-3.5">
                  <p className="text-2xs font-medium uppercase tracking-wider text-subtle">
                    Agreements
                  </p>
                  <ul className="mt-1.5 space-y-1.5">
                    {deliberation.agreements.map((a) => (
                      <li key={a} className="text-2xs leading-relaxed text-muted">
                        · {a}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {tally ? (
        <section>
          <SectionHeader
            title="Tally"
            description="Calculated by the backend. The human vote is counted separately from the AI votes."
          />
          <div className="rounded border border-border bg-surface p-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <TallyCell
                label="AI jurors"
                value={`${tally.aiYes} / 3 yes`}
                met={tally.aiYes >= tally.aiRequired}
                hint={`${tally.aiRequired} required`}
              />
              <TallyCell
                label="Founder"
                value={
                  tally.humanVote === "pending"
                    ? "pending"
                    : tally.humanVote === "yes"
                      ? "approved"
                      : "rejected"
                }
                met={tally.humanVote === "yes"}
                hint={
                  humanVote
                    ? `via ${humanVote.channel}`
                    : "vote in the council room"
                }
              />
              <TallyCell
                label="Outcome"
                value={tally.approved ? "Approved" : "Not approved"}
                met={tally.approved}
                hint={tally.approved ? "build authorised" : "no build"}
              />
            </div>
            <p className="mt-3 border-t border-border pt-3 text-2xs leading-relaxed text-muted">
              {tally.reason}
            </p>

            {humanVote ? (
              <div className="mt-3 border-t border-border pt-3">
                <p className="text-2xs font-medium uppercase tracking-wider text-subtle">
                  Human vote provenance
                </p>
                <dl className="mt-1.5 grid gap-1 text-2xs sm:grid-cols-2">
                  <Provenance label="Channel" value={humanVote.channel} />
                  <Provenance label="Voter" value={humanVote.voterName} />
                  <Provenance label="Cast at" value={new Date(humanVote.castAt).toLocaleString()} />
                  {humanVote.switchSenderId ? (
                    <Provenance label="SWITCH sender" value={humanVote.switchSenderId} mono />
                  ) : null}
                  {humanVote.switchMessageId ? (
                    <Provenance label="SWITCH message" value={humanVote.switchMessageId} mono />
                  ) : null}
                  {humanVote.note ? (
                    <Provenance label="Note" value={humanVote.note} />
                  ) : null}
                </dl>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function TallyCell({
  label,
  value,
  met,
  hint,
}: {
  label: string;
  value: string;
  met: boolean;
  hint: string;
}) {
  return (
    <div>
      <p className="text-2xs font-medium uppercase tracking-wider text-subtle">{label}</p>
      <p
        className={
          "mt-1 text-sm font-medium " + (met ? "text-success" : "text-warning")
        }
      >
        {value}
      </p>
      <p className="mt-0.5 text-2xs text-subtle">{hint}</p>
    </div>
  );
}

function Provenance({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <dt className="shrink-0 text-subtle">{label}:</dt>
      <dd className={"truncate text-muted " + (mono ? "font-mono" : "")} title={value}>
        {value}
      </dd>
    </div>
  );
}
