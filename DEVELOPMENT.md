# Origin — Development Checklist

Tracks implementation against the final acceptance criteria. Updated as work lands.

## Status legend
- [x] done and verified
- [~] implemented, needs end-to-end verification
- [ ] not started

## 1. SWITCH collaboration (live, not simulated)

- [x] Agent-protocol client: registration, ops, WebSocket, ping/pong, resume
- [x] Ten distinct SWITCH agents registered (spec enumerates 9 roles + QA = 10)
- [x] Three bridged rooms created and persisted
- [x] Room roles defined (`scout`, `researcher`, `juror`, `chair`)
- [ ] Agent-to-agent targeted handoffs wired into the workflow
- [ ] Event handler routing into the workflow engine
- [ ] Live room transcript retrieval API
- [ ] Duplicate message suppression by message id
- [ ] Loop prevention: addressed-only action + hop budget
- [ ] Human vote gate wired to the running server
- [ ] Duplicate vote rejection
- [ ] Live connection status exposed to the dashboard

## 2. Backend and workflow engine

- [x] Declarative state machine with actor restrictions
- [x] Approval tally (2-of-3 AI + human)
- [x] JSON persistence with atomic writes
- [ ] REST endpoints for the whole journey
- [ ] Zod request validation on every route
- [ ] SSE live activity stream (adapter exists, not fed by the workflow)
- [ ] Orchestrator: discovery → research → jury → vote → build
- [ ] Idempotent approval and build execution
- [ ] Restart recovery from persisted state

## 3. Discovery and research

- [x] Hacker News retrieval with URL + retrieval timestamp
- [x] GitHub issue retrieval
- [x] Problem clustering with provenance validation
- [x] Market research
- [x] Competitor analysis
- [x] Product strategy brief
- [ ] Pipeline exposed through the API

## 4. Jury

- [x] Three concurrent independent jurors
- [x] Structured, Zod-validated verdicts
- [x] Deliberation naming genuine disagreements
- [x] Backend-calculated tally
- [ ] Verdicts persisted with the opportunity and rendered in the UI

## 5. Builder and QA

- [x] bubblewrap sandbox with no network and no host home
- [ ] OpenCode builder invocation inside the sandbox
- [ ] Generated project stored in an isolated workspace
- [ ] QA runs the generated project's tests
- [ ] QA reports failures to the Builder through SWITCH
- [ ] Builder retry loop, maximum two retries
- [ ] Build results persisted
- [ ] MVP preview served

## 6. Frontend

- [ ] Vite + React + TS + Tailwind + shadcn/ui scaffold
- [ ] Design tokens, dark default and full light theme
- [ ] Overview dashboard
- [ ] Discovery feed
- [ ] Opportunity list
- [ ] Opportunity detail with evidence
- [ ] Startup Council and jury results
- [ ] Agent activity and SWITCH transcripts
- [ ] Build Studio
- [ ] MVP result and preview
- [ ] Loading, empty, error and offline states

## 7. Documentation

- [ ] README with setup, architecture, demo walkthrough
- [ ] Architecture document
- [ ] SWITCH integration guide
- [ ] Agent responsibilities
- [ ] Voting explanation
- [ ] Sandbox security explanation
- [ ] Known limitations

## 8. Acceptance

- [ ] Fresh setup per documented instructions
- [ ] End-to-end run verified twice from a reset state
- [ ] Tests and typechecks pass
- [ ] No secrets committed
