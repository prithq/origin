# Origin — Implementation Status

Accurate as of the final verification run. Everything marked verified was
executed, not inferred.

## Verified end to end, twice from a clean reset

| Step | Result | Evidence |
|---|---|---|
| Discovery | 4 problem clusters, 60-80 s | Live Hacker News + GitHub; per-source counts in activity |
| Evidence provenance | checked | Every item has a canonical URL and retrieval timestamp |
| Research | 4 briefs, 2-3 min | Market, competitors and MVP scope persisted per opportunity |
| Jury | 12 independent verdicts, ~75 s | Split verdicts with named disagreements |
| Human vote | instant | Real Mattermost message, verified against SWITCH participants |
| Approval rule | checked | 2/3 AI + human approved; 1/3 + human correctly rejected |
| Auto build | immediate | Approval flipped state to BUILDING with no second gate |
| Build | 60-80 s, one attempt each run | 5 files written by OpenCode in bwrap |
| QA | passed both runs | 5/5 generated tests plus 4 structural checks |
| Dashboard | 6 pages, no console errors | Chrome, 1440x1000, dark and light |

Measured total for the full journey: **5-7 minutes**, dominated by model latency.

## Feature status

### Working and verified

- SWITCH agent protocol client: registration, operations, WebSocket, ping/pong,
  resume, gap and eviction handling
- 10 distinct SWITCH agents, 10/10 connected, three bridged rooms
- Live room transcripts read back from SWITCH, including the founder's vote
- Human identity verification via SWITCH participant classification
- Vote provenance: sender id, message id, timestamp, channel
- Hacker News and GitHub discovery with source URLs and retrieval times
- Problem clustering with provenance validation (invented evidence ids rejected)
- Market research, competitor analysis, product strategy brief
- Three independent jurors, concurrent, Zod-validated, identity-checked
- Deliberation naming genuine disagreements
- Backend-calculated approval tally
- 20 REST endpoints with Zod validation
- JSON persistence with atomic writes; state recovers on restart
- SSE live activity, verified reaching the browser
- Autonomous Builder via OpenCode inside bwrap
- QA execution with no network and no credentials
- QA retry loop with a fix prompt
- Dashboard: 7 routes, design tokens, dark and light themes
- Sandbox isolation: `.env`, agent keys and host home unreachable; no network

### Deliberately simplified

| Area | Decision |
|---|---|
| Generated MVP | Fixed template: the agent writes `src/core.mjs` and `core.test.mjs`; harness, `package.json` and README are pre-written. Keeps the build under 90 s and makes QA dependable |
| Build scope | A Node module with a CLI harness, not a web app. No install step, so QA runs offline |
| Preview | Serves static `index.html` when a build produces one. Generated projects are CLIs, so the UI explains that instead of pretending |
| Agent-to-agent routing | Collaboration is demonstrated by shared rooms and broadcast messages, which is genuine. The unused hop-budget abstraction was removed |
| Mock mode | Removed. It had no fixtures and could never have worked, so it was misleading rather than useful |

### Known limitations

- One server process delivers SWITCH events. Two processes driving the same
  agents must use different connection-id prefixes.
- GitHub without a token is limited to 60 requests per hour; the limit is
  reported, not hidden.
- JSON persistence suits a single-process demo; it is not a database.
- The jury is strict: expect roughly one in four candidates to clear 2/3.
- A build can occasionally take a second attempt if the model stalls, though
  both final verification runs completed on the first attempt.

## Commits and review

Non-merge commits: 26. See the repository history for the phase-by-phase record.
Pull requests are left open for review; nothing is merged without approval.
