/**
 * The vote panel.
 *
 * Two genuine ways for the founder to vote, and a clear statement of which one
 * is primary:
 *
 *   - In the SWITCH room, by typing an APPROVE/REJECT command. This is the
 *     primary path and the vote is verified against SWITCH's participant list.
 *   - Here, with the operator token. This is the authenticated fallback.
 *
 * The panel states the rule explicitly so a rejection caused by an insufficient
 * jury is never mistaken for a bug.
 */

import { useState } from "react";
import { Check, Info, X } from "lucide-react";
import type { Opportunity } from "@origin/contracts";
import { api } from "../lib/api";
import { Button } from "./primitives";

export function VotePanel({
  opportunity,
  onVoted,
}: {
  opportunity: Opportunity;
  onVoted: () => void;
}) {
  const [token, setToken] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ approved: boolean; reason: string } | null>(null);

  const yes = opportunity.verdicts.filter((v) => v.vote === "yes").length;
  const juryCleared = yes >= 2;

  const vote = async (decision: "yes" | "no") => {
    setBusy(decision);
    setError(null);
    try {
      const response = await api.vote(opportunity.id, decision, token, note || undefined);
      setResult({ approved: response.approved, reason: response.reason });
      setToken("");
      setNote("");
      onVoted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded border border-warning/30 bg-warning/[0.04]">
      <div className="flex items-center gap-2 border-b border-warning/20 px-4 py-2.5">
        <Info size={13} className="text-warning" />
        <p className="text-xs font-medium text-warning">Awaiting the founder's decision</p>
      </div>

      <div className="grid gap-5 px-4 py-4 lg:grid-cols-2">
        <div>
          <p className="text-2xs font-medium uppercase tracking-wider text-subtle">
            Primary: vote in the SWITCH room
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            In <span className="font-mono text-content">#startup-council</span>, post one of
            these as your own message. Origin reads the real SWITCH event and verifies you
            against the room participants.
          </p>
          <div className="mt-2.5 space-y-1 rounded border border-border bg-bg px-3 py-2 font-mono text-2xs">
            <p className="text-success">APPROVE {opportunity.id}</p>
            <p className="text-danger">REJECT {opportunity.id}</p>
          </div>
          <p className="mt-2 text-2xs leading-relaxed text-subtle">
            Agent messages are refused by the vote gate. A vote is only accepted while an
            opportunity is awaiting one, so a repeat cannot trigger a second build.
          </p>
        </div>

        <div className="border-l-0 border-t border-border pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <p className="text-2xs font-medium uppercase tracking-wider text-subtle">
            Fallback: vote here
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            Requires the operator token configured on the server. Recorded as a console vote,
            with a different channel than a SWITCH vote.
          </p>

          <label className="mt-2.5 block">
            <span className="text-2xs text-subtle">Operator token</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="from HUMAN_OPERATOR_TOKEN"
              className="mt-1 w-full rounded border border-border bg-bg px-2.5 py-1.5 text-xs text-content placeholder:text-subtle focus:border-border-strong focus:outline-none"
            />
          </label>

          <label className="mt-2 block">
            <span className="text-2xs text-subtle">Note (optional)</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why you decided this"
              className="mt-1 w-full rounded border border-border bg-bg px-2.5 py-1.5 text-xs text-content placeholder:text-subtle focus:border-border-strong focus:outline-none"
            />
          </label>

          <div className="mt-2.5 flex gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={busy === "yes"}
              disabled={!token || busy !== null}
              onClick={() => void vote("yes")}
            >
              <Check size={13} /> Approve
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={busy === "no"}
              disabled={!token || busy !== null}
              onClick={() => void vote("no")}
            >
              <X size={13} /> Reject
            </Button>
          </div>

          <p className="mt-2.5 text-2xs leading-relaxed text-subtle">
            The rule: at least two of the three AI jurors must vote yes,{" "}
            <em>and</em> you must vote yes. Currently {yes}/3 jurors said yes
            {juryCleared ? ", so your vote decides it." : ", so approval is not reachable."}
          </p>
        </div>
      </div>

      {error ? (
        <p className="border-t border-warning/20 px-4 py-2 text-2xs text-danger">{error}</p>
      ) : null}
      {result ? (
        <p
          className={
            "border-t border-warning/20 px-4 py-2 text-2xs " +
            (result.approved ? "text-success" : "text-warning")
          }
        >
          {result.reason}
        </p>
      ) : null}
    </div>
  );
}
