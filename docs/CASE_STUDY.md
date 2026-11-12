# FlowCheck case study

*All companies, people and data in this case study are fictional. All results are simulated outcomes.*

## The problem

Fernhollow Software is onboarding a logistics customer, Kestrel Freight. Close to go-live, Kestrel's project lead raises three complaints with the implementation manager:

1. "We got the same kickoff notice three times, and our credential rotation is late."
2. "Who is approving our data import? Nobody has told us anything for two days."
3. "You said single sign-on work had started. Nothing has moved."

The implementation manager needs three things for each complaint: what happened, which rule would have prevented it, and what that rule costs.

## Requirements

| ID | Requirement | Acceptance criterion |
|---|---|---|
| FR-1 | A repeated delivery of the same request must not create a second task or a second notice | One task and one notice per idempotency key, for 150 seeds |
| FR-2 | Approval-required work starts only after an authorized person approves it | No violation across 60 seeds × 4 escalation modes × 5 thresholds |
| FR-3 | Escalation surfaces overdue approvals and never decides them | Escalation entries carry no state change; auto-approve is rejected by the guard |
| FR-4 | A task that cannot be assigned is made visible and routed by an explicit rule | Zero hidden blocked time and zero wrong-team work under "flag and queue", for 150 seeds |
| FR-5 | Only documented transitions can happen | Others are rejected with a reason and logged |
| FR-6 | A scenario can be replayed exactly | Same seed and rules give an identical trace |
| FR-7 | Every number on screen traces to events | Metrics come from the trace and reconcile with task records |
| FR-8 | Reset returns the scenario to its start | A run changes neither its inputs nor its rules |

## Findings from the simulation (default seeds)

### A. Duplicate integration event

The customer's CRM delivered request `REQ-7781` three times: once, again after 4 minutes, and again after 42 minutes. A separate request with the same title and a different key arrived in between.

| Response | Duplicate tasks | Distinct requests dropped | Wasted work | Credential rotation (6 h target) |
|---|---|---|---|---|
| Baseline, no check | 2 | 0 | 5 h 48 min | 7 h 40 min, missed |
| Idempotency key | 0 | 0 | 0 | 4 h 43 min, met |
| Title match, 15 min | 1 | 0 | 2 h 54 min | 5 h 6 min, met |
| Title match, 45 min | 0 | 1 | 0 | 2 h 39 min, met |

The 45-minute window looks best on speed because it silently dropped a real request. A test confirms that no window width from 1 to 240 minutes gets both columns to zero. The key works because it identifies the request and not its appearance. Its own weakness is retention: with keys kept for 30 minutes, the 42-minute retry gets through.

### B. Approval bottleneck

The import needed a security approval. The primary approver left 10 minutes before the request arrived and returned two working days later.

| Response | Approval wait (4 h target) | Import completed (2 day target) | Rejected transitions |
|---|---|---|---|
| Baseline, no escalation | 18 h 55 min, missed | 23 h, missed | 0 |
| Escalate to backup after 2 h | 2 h 40 min, met | 6 h 45 min, met | 0 |
| Remind the same approver after 2 h | 18 h 55 min, missed | 23 h, missed | 0 |
| Auto-approve after 2 h | 18 h 55 min, missed | 23 h, missed | 1 |

The auto-approve rule attempted to release the task and the guard refused, because a timer is not an authorized approver. The escalation threshold has a cost too. At 60 minutes the backup is pulled into two requests the primary approver was already finishing. At 210 minutes the escalation fires too late to meet the 4-hour target.

### C. Assignment failure

Single sign-on arrived while the Integrations team was full. An EDI request needed a skill no team has. The baseline rule sent both to the default pool.

| Response | Blocked time nobody could see | Wasted work | SSO completed (8 h target) | Requests on target |
|---|---|---|---|---|
| Baseline, default pool | 9 h 26 min | 4 h | 10 h 46 min, missed | 3 of 5 |
| Flag and queue | 0 | 0 | 9 h 40 min, missed | 3 of 5 |
| Overflow to qualified team | 0 | 0 | 5 h 41 min, met | 3 of 5 |

"Requests on target" is 3 of 5 in every row, and that is the point of this scenario. Flagging the exception does not create capacity. It removes the hidden time and the wasted work. Overflow meets the SSO target by making another team's reporting task late. The EDI request stays blocked under every response, visible and labeled as a staffing gap, because no routing rule can supply a skill the company does not have.

## Design decisions

- **One transition table.** The engine, the on-screen map and the documentation all read the same constant.
- **Approval as two records.** A request and a decision are stored separately and the guard checks the decision. Blocked cannot be used as a side door, because leaving Awaiting approval for Blocked needs the same decision.
- **Metrics from the trace only.** A separate reconciliation step compares the trace with the task records, and the interface shows the result.
- **Ground truth kept away from the rules.** Each synthetic delivery is labeled original, retry or distinct. Only the metrics read that label, so a rule cannot cheat.
- **No backend.** Explained in the README.

## What this project does not show

Authentication, persistence, concurrency, real integrations, real customers or measured business impact. People are modeled with fixed response times and the clock has no calendar.
