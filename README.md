# FlowCheck

**Can you rescue this customer implementation?**

FlowCheck is an interactive workflow simulation. A fictional B2B software company, Fernhollow Software, is onboarding a customer and the process is failing in three ways. You investigate each failure, change one rule and replay the same inputs to see what your decision changes.

It is a portfolio project by Jon Johnson. All companies, people and data are invented, and every result is a simulated outcome.

## What you can do

| Scenario | Baseline failure | Responses you can test |
|---|---|---|
| A. Duplicate integration event | The same request is delivered three times and becomes three tasks | Idempotency key; title match for 15 min; title match for 45 min |
| B. Approval bottleneck | An approval waits two days for an absent approver | Escalate to an authorized backup; remind the same approver; auto-approve (rejected by the guard) |
| C. Assignment failure | Work is dropped on a team without the skill and sits blocked, unseen | Flag and queue; overflow to another qualified team |

Each response has a real cost that the simulation measures. For example, no title-match window from 1 to 240 minutes handles scenario A correctly: every width either lets a retry through or suppresses a legitimate request. A test checks all 240.

## Run it

Requires Node 22.18 or newer. The engine and its tests have no dependencies.

```bash
npm test          # 39 engine and rule tests
npm run verify    # run the tests, record the result, build dist/index.html
open dist/index.html
```

`dist/index.html` is one self-contained file. It works from disk, offline.

Optional checks:

```bash
npm install                # installs TypeScript for type checking only
npm run typecheck
npm install --no-save playwright
npm run test:browser       # keyboard flow, 375 px layout, reduced motion, zero network requests
```

## How it works

```
seed ──► scenario builder ──► typed input events ─┐
                                                  ├─► engine ──► trace ──► metrics + reconciliation ──► interface
rule editor ──► validation ──► rule set ──────────┘      │
                                              state machine + guard G-APPROVAL
```

- **`src/engine/machine.ts`** has the eight states, the 18 allowed transitions and the approval guard. Everything else reads this table, including the workflow map on screen.
- **`src/engine/engine.ts`** is a pure function, `simulate(data, rules)`. It reads no system clock and draws no random numbers. Every state change goes through one function that asks the state machine first and writes a trace entry whether the change is applied or rejected.
- **`src/engine/scenarios.ts`** builds each scenario's inputs from a seed. The same seed always gives the same inputs.
- **`src/engine/metrics.ts`** computes every metric from the trace alone, then `reconcile()` checks the trace against the task records.
- **`src/engine/rules.ts`** holds the rule catalog, the editor bounds and validation.
- **`src/ui/`** is plain TypeScript and DOM calls. No framework.
- **`scripts/build.mjs`** strips types with Node's built-in `stripTypeScriptTypes` and writes one HTML file.

### Why there is no backend

Every scenario is a calculation on synthetic inputs. A server would add hosting, a database and an API that a visitor cannot inspect, and would not change one result. The cost of this choice is stated on the "Inside the project" page: nothing here demonstrates authentication, persistence, concurrent users or a real integration.

### Approval boundary

A request for approval and an approval decision are separate records. Guard G-APPROVAL allows an approval-required task into Assigned, In progress or Complete only when an approved decision from an authorized role is on record. Escalation creates a notification and never changes state. The "auto-approve after timeout" response exists so you can watch the guard reject it.

## What the tests cover

- Each scenario's baseline and every response, with exact expected values for the default seed
- Idempotency: one task and one notice per key across 150 seeds
- Approval: 60 seeds × 4 escalation modes × 5 thresholds, with no approval-required work before an authorized decision
- Invalid transitions, unauthorized approvers, rejected approvals, unknown customers
- Replay determinism, input immutability (reset), capacity never exceeded
- Metrics recomputed independently from task records for 50 seeds per option

`npm run verify` writes the real pass and fail counts to `verification.json`, and the build embeds them in the page.

## Limitations

- Simulated outcomes only. Nothing here measures a real customer, cost or saving.
- People are modeled with fixed response times.
- The clock counts working minutes, 8 hours a day, with no calendar.
- The rule editor changes three rule groups inside fixed bounds. It is not a general rules engine.
- Nothing is saved between visits.

## Documentation

- [Case study](docs/CASE_STUDY.md)
- [Contribution and AI assistance](docs/CONTRIBUTION.md)
- [Deployment preparation](docs/DEPLOYMENT.md)
- [Predict-then-run exercise](docs/EXERCISE.md)

## Privacy

The page makes no network requests, sets no cookies and writes nothing to browser storage. A content security policy of `default-src 'none'` enforces the first of these, and the browser check verifies all three.

This is independent student work. It is not affiliated with or endorsed by any university or company.
