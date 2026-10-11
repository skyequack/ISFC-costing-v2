---
name: feature-team
description: Assemble the ISFC feature team (architect, backend, database, optimisation, frontend, security, QA, domain analyst) to find the best implementation strategy for a new feature Omer describes. Use every time a new feature is discussed, before any code is written.
---

# /feature-team <feature description>

Follow `docs/FEATURES.md` (process, brief template, output formats). Arguments are Omer's description of the feature.

1. **Brief.** Read `CLAUDE.md`, `docs/FEATURES.md`, `docs/PROGRESS.md`, and the `DECISIONS.md` tail. Spawn the `architect` agent in framing mode with the description; get back the filled brief and the likely modules. If a fact only Omer can supply is missing and changes the design, ask him (AskUserQuestion) before fanning out; otherwise state the assumption.
2. **Fan out in one message** (parallel, background not needed): `backend-engineer`, `database-engineer`, `optimisation-engineer`, `frontend-engineer`, `security-engineer`, `qa-engineer`, `domain-analyst`. Give each the same brief verbatim plus "design phase, read-only". Drop a role only if it plainly has nothing to say (e.g. no UI, no DB) and say so; add other roles if the feature needs one.
3. **Synthesis.** Send all proposals to `architect` in synthesis mode (a fresh agent call containing the proposals). Return its output to Omer, edited only for length: strategy, slices, DECISIONS rows, perf target, open questions. Surface disagreements between roles rather than hiding them.
4. **Stop and wait for Omer's decision.** Do not edit code or schema in this skill. After approval: record the DECISIONS row(s) and the `docs/FEATURES.md` feature-log row, then implement slice by slice, each ending with the gates in `docs/FEATURES.md`.

Keep the user-facing summary short; the full role proposals can be offered on request.
