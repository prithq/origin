# Origin

An autonomous venture studio that starts from problems, not ideas.

Origin reads public discussion, clusters real complaints into candidate problems,
researches them against the evidence it actually retrieved, puts each one to an
independent three-agent jury, and then builds an MVP only when the human founder
agrees. The whole collaboration runs through **SWITCH** rooms, with ten distinct
agents as real participants.

The guiding constraint is honesty about evidence. Every claim traces back to a
source URL with a retrieval timestamp, and an agent that invents a competitor or
a statistic is a bug, not a creative flourish.

---

## The journey

```
Discovery  ->  Clustering  ->  Research  ->  Opportunity brief
                                              |
                                              v
                             Independent 3-agent jury (Investor,
                             Technical Architect, Customer Advocate)
                                              |
                                              v
                             Human founder vote, verified through SWITCH
                                              |
                                    (2 of 3 AI yes AND human yes)
                                              |
                                              v
                             Autonomous build (OpenCode, sandboxed)
                                              |
                                              v
                                   QA tests, fix loop, MVP
```

## What is genuinely real

| Layer | Implementation |
|---|---|
| Discovery | Live Hacker News and GitHub APIs |
| Clustering, research, jury | Live DeepSeek via DeepRelay, Zod-validated |
| Collaboration | Live SWITCH agent protocol: ten agents, three bridged rooms |
| Human vote | A real Mattermost message arriving as a SWITCH event |
| Build | Live `opencode run` inside bubblewrap |
| QA | The generated project's own tests, executed with no network |
| Dashboard | Real backend data over REST plus server-sent events |

There is no mock mode. Origin always calls the model live, and a failure surfaces
rather than being replaced with generated text.

---

## Architecture

```
apps/web    React + Vite + TypeScript + Tailwind        (port 5173)
apps/server Express + TypeScript + Zod                  (port 8787)
packages/contracts  Shared Zod schemas and domain types
data/       Persisted state and SWITCH agent credentials (gitignored)
workspace/  Generated MVP projects and builder runtime   (gitignored)
```

The server owns three things the frontend never does: it decides transitions, it
counts votes, and it talks to the SWITCH bridge.

### Modules

```
apps/server/src/
├── agents/           runtime, discovery/clustering, research, jury
├── build/            sandbox (bwrap), pipeline (builder + QA loop)
├── discovery/        Hacker News and GitHub retrieval
├── llm/              provider abstraction (DeepRelay live, deterministic mock)
├── switch/           protocol client, hub, registry, vote gate, guards, router
├── workflow/         state machine, tally, engine, orchestrator, run tracking
├── db/               atomic JSON persistence
└── lib/              logger, activity recording, SSE fan-out
```

---

## Setup

### Prerequisites

- Node.js 22 or newer
- pnpm 11
- OpenCode 2.x (`opencode --version`)
- bubblewrap, for the build sandbox: `sudo apt install bubblewrap` or equivalent
- A running SWITCH server with a Mattermost bridge

### 1. Install

```bash
pnpm install
```

### 2. Configure

```bash
cp .env.example .env
```

Fill in the values described in [Environment](#environment). `.env` is gitignored
and must never be committed.

### 3. Verify SWITCH before anything else

```bash
pnpm switch:check
```

This registers the agents, creates the three rooms, connects every agent, posts in
each room and prints a pass or fail per agent. It exits non-zero on failure, so it
is safe to use as a gate.

### 4. Run

```bash
pnpm dev
```

- Dashboard: http://localhost:5173
- API: http://localhost:8787

The server refuses to start in live mode if the model key or SWITCH registration
token is missing. That is deliberate: it will not pretend to work.

---

## Environment

| Variable | Purpose |
|---|---|
| `DEEPRELAY_API_KEY` | Model credential. Server-side only |
| `DEEPRELAY_MODEL` | Default `deepseek-v4.1-flash` |
| `LLM_MAX_OUTPUT_TOKENS` | Output budget. The model is a reasoning model, so thinking counts |
| `SWITCH_MODE` | `live` uses the real bridge; `offline` is development only |
| `SWITCH_BRIDGE_URL` | `switch-core` address, default `http://127.0.0.1:43059` |
| `SWITCH_REGISTRATION_TOKEN` | Deployment registration key. Server-side only |
| `HUMAN_OPERATOR_TOKEN` | Enables the console vote fallback |
| `GITHUB_TOKEN` | Optional; raises GitHub from 60 to 5000 requests per hour |
| `OPENCODE_BIN` | OpenCode executable. Resolved to an absolute path at build time |
| `OPENCODE_MODEL` | Model string passed to `opencode --model` |
| `BUILD_TIMEOUT_MS` | Hard limit on a build attempt |
| `MAX_QA_RETRIES` | Fix attempts after a QA failure |

---

## SWITCH integration

Origin implements the SWITCH **agent protocol** directly. It does not use the
official OpenCode connector, because that connector drives an OpenCode session
*from* a room, whereas Origin decides what to build and then invokes OpenCode as a
sandboxed subprocess.

### Agents

Ten agents, each a distinct SWITCH participant with its own registration, API key
and WebSocket:

| Team | Agents | Room |
|---|---|---|
| Discovery | Social Scout, Developer Scout | `#discovery-lab` |
| Research | Market Researcher, Competitor Analyst, Product Strategist | `#startup-council` |
| Jury | Investor, Technical Architect, Customer Advocate | `#startup-council` |
| Build | Builder, QA Agent | `#build-studio` |

QA is a tenth agent because the build loop depends on it. The brief enumerated
nine roles but listed ten entities.

### Protocol details that matter

Three details are easy to get wrong, and each produces a silent failure:

1. Frames use `{"event": "...", "data": {...}}`, not `type`.
2. Most operation responses are wrapped as `{ "result": ... }`.
3. Room-bound operations require the `X-Switch-Connection-Id` header.

The client also answers every `ping` with a `pong` carrying its cursor, resumes
from that cursor after a drop, and stops permanently on `taken_over` rather than
fighting another client.

### Why one process hosts ten connections

Each agent is a real participant, but a single Node process holds all ten
sockets. The alternative — ten processes — adds operational cost without changing
what SWITCH sees.

### Human participation

The three rooms are bridged to Mattermost. The founder participates as a real
messaging-app user, and their message arrives at the agents as a genuine SWITCH
event.

---

## Voting

Four voters: three AI jurors and the human founder.

A build starts only when **both** conditions hold:

- at least two of the three AI jurors vote yes
- the human founder votes yes

If the jury approves but the founder rejects, the opportunity is rejected. If the
jury does not reach two yes votes, the founder's yes cannot approve it, and the
interface says so plainly rather than appearing broken.

### How the human vote is protected

Five independent layers stop an agent from voting on the founder's behalf:

1. **Structural.** Agent senders are `@switch-agent-<id>`; bridged humans are
   `@switch-<platform>-<bridge>-user`. An agent cannot emit the latter, because
   SWITCH assigns the localpart from the client row.
2. **Authoritative classification.** The room's participants are read from SWITCH
   and `type === "user"` decides.
3. **Uniqueness.** If a human and an agent share a display name, the vote is
   refused as ambiguous rather than guessed.
4. **Token binding.** A vote must name the opportunity, so an old approval cannot
   be replayed against a different one.
5. **Schema.** The juror verdict schema has no human-vote field, so no model
   output can resemble a human decision.

Accepted votes record the SWITCH sender id, message id and timestamp, which the
dashboard displays as provenance.

### Casting a vote

In `#startup-council`:

```
APPROVE opp_7c58349e8d42
REJECT  opp_7c58349e8d42
```

The opportunity id is shown in the interface. A vote is accepted only while the
opportunity is awaiting one, so a duplicated or replayed message cannot trigger a
second build.

---

## Build and sandbox security

Two stages are isolated differently, because they have different needs.

**Build stage.** OpenCode writes files into a disposable workspace. It needs the
model API, so it gets network access and a temporary OpenCode home. The provider
key is passed as an environment variable; the generated config contains only a
`{env:DEEPRELAY_API_KEY}` placeholder, so no credential is ever written to disk
inside the sandbox. The host home, the repository and `data/` are not mounted.

**QA stage.** This is the stage that runs untrusted generated code, so it gets no
network, no credentials and no filesystem access beyond the project directory.

Both run under `bwrap` with all namespaces unshared, the system mounted
read-only, a private `/tmp`, and a hard timeout. If `bwrap` is unavailable, the
builder refuses to run rather than falling back to the host shell.

Verified: generated code inside the sandbox cannot read the repository `.env` and
cannot see the host home directory.

---

## Testing

```bash
pnpm typecheck                 # every package
pnpm test                      # unit tests
pnpm --filter @origin/server typecheck
pnpm switch:check              # live SWITCH connectivity and participation
```

Unit tests cover the vote gate, the approval tally, and the duplicate/loop
guards. The vote-gate suite includes agent impersonation, ambiguous identity, and
cross-opportunity replay.

---

## Demo walkthrough

Verified twice from a clean reset. Measured timings on a warm server:

| Step | Time | What you see |
|---|---|---|
| Discover | ~60 s | Real Hacker News and GitHub signals clustered into 4 problems |
| Research | ~2–3 min | 4 briefs produced in parallel, each grounded in retrieved evidence |
| Jury | ~75 s | 12 independent verdicts; typically one opportunity clears 2/3 |
| Vote | instant | `APPROVE <id>` in Mattermost flips state to BUILDING |
| Build + QA | 60–80 s | Files appear, QA runs, state reaches COMPLETED |

Total for the full journey: **roughly 5–7 minutes**, dominated by model latency.

### Running the demo

1. **Overview.** Ten agents connected, three rooms on the bridge, sandbox ready.
2. **Run discovery.** Signals stream into `#discovery-lab`; four clusters appear
   with source counts.
3. **Open an opportunity.** Inspect the evidence tab: every row links to the
   original post and shows when it was retrieved.
4. **Research.** The brief, market assessment and competitor map appear.
5. **Convene the jury.** Three verdicts appear independently, then the
   deliberation names where they disagree.
6. **Vote in Mattermost.** In the bridged `#startup-council`, type
   `APPROVE <opportunity-id>`. The dashboard updates because the event arrived
   over SWITCH, and the vote record shows the SWITCH sender and message id.
7. **Watch the build.** Approval starts the Builder automatically. Build Studio
   shows files appearing, then the QA report with each check.
8. **Inspect the MVP.** Read the generated source and its passing tests.

### Notes for presenting

- The jury is genuinely strict: expect roughly one in four candidates to reach
  2/3. Research all four clusters in parallel rather than one, so there is a
  candidate to approve. This is the system working, not a failure.
- If no opportunity reaches 2/3, run discovery again — the signal mix differs
  each time — or approve a 1/3 candidate to show the rule *refusing* approval,
  which is a legitimate and informative demo of the guard.
- A 1/3 opportunity plus a founder "yes" produces REJECTED. That is worth
  showing: the founder cannot override the jury, and the interface explains why.

### Reset between runs

```bash
./scripts/reset.sh          # clears opportunities, evidence and workspaces
./scripts/reset.sh --full   # also forgets room ids
```

SWITCH agents and rooms are preserved, so a reset takes seconds and needs no
re-registration. Restart the server after a reset.

## Known limitations

- **The jury is strict.** Most publicly discovered problems score 1-3 of 3. This
  is the system working, but it means a demo should research several candidates
  and approve one that clears two votes.
- **Latency.** A full journey takes roughly two to four minutes.
- **GitHub without a token** is capped at 60 requests per hour. The limit is
  reported, not hidden.
- **The generated MVP is a Node.js library or CLI**, not a web application. The
  build contract deliberately excludes frameworks so QA can run offline with no
  install step.
- **One server process** delivers SWITCH events. Two processes driving the same
  agents must use different connection-id prefixes or they will evict each other.
- **JSON persistence** is adequate for a single-process demo and is not a
  database.

---

## Repository layout

```
apps/
  server/     Express API, agents, workflow, SWITCH client, build pipeline
  web/        React dashboard
packages/
  contracts/  Shared Zod schemas and domain types
```

`DEVELOPMENT.md` tracks the implementation checklist.
