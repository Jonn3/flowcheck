# Predict, then run

A practice exercise for explaining FlowCheck. For each row, open **Explore**, pick the scenario, set the rule in the rule editor, and **write your prediction down before you press Run**. Then compare it with the result and find the trace entry that explains any difference.

All runs use the default seed for the scenario.

| # | Scenario | Rule editor change | Question |
|---|---|---|---|
| 1 | A. Duplicate integration event | Mode: idempotency key. Key retention: 30 min | How many duplicate tasks are created? |
| 2 | A. Duplicate integration event | Mode: customer and title window. Window: 30 min | How many duplicate tasks? How many distinct requests are wrongly suppressed? |
| 3 | B. Approval bottleneck | Mode: escalate to backup approver. Threshold: 60 min | How many escalations are sent? How many redundant reviews? |
| 4 | B. Approval bottleneck | Mode: escalate to backup approver. Threshold: 210 min | Is the focal approval decided within the 4 h target? |
| 5 | C. Assignment failure | Mode: send to default pool. Queue limit: 1 | Which task is still sent to a team without the skill, and why only that one? |

<details>
<summary>Answers (open only after predicting)</summary>

1. **1 duplicate.** The late retry of `REQ-7781` arrives 42 minutes after the first delivery. The key left the store after 30 minutes, so the retry is accepted as new. The trace entry for `D-104` says so.
2. **1 duplicate and 1 wrongly suppressed.** `D-103` (a different request with the same title) arrives 20 minutes after `D-101` and is suppressed. `D-104` arrives 42 minutes after `D-101`, and the only accepted match is older than 30 minutes, so it gets through.
3. **3 escalations, 2 redundant reviews.** The focal approval is decided in 1 h 40 min, but the backup approver is also pulled into two requests the primary approver was already finishing.
4. **No.** The escalation fires at 210 minutes and the backup needs 40 minutes to review: 250 minutes against a 240-minute target.
5. **Only the EDI request (`T-304`).** With one queue place, single sign-on waits in the Integrations queue instead of being sent to the default pool. No team has the EDI skill, so a longer queue cannot help it: 2 h of wasted work and 4 h 28 min blocked before anyone sees it.

</details>

These answers were computed by running the engine. If a code change makes one of them wrong, update this file in the same pull request.
