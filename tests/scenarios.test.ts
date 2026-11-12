import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, scenarioById, validSeed } from '../src/engine/scenarios.ts';
import { simulate } from '../src/engine/engine.ts';
import { computeMetrics, reconcile, fingerprint, firstDivergence, snapshotAt } from '../src/engine/metrics.ts';
import { TRANSITIONS } from '../src/engine/machine.ts';
import { RULES, cloneRules } from '../src/engine/rules.ts';
import type { RuleSet, Run, RequestDelivery, State } from '../src/engine/types.ts';

const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);

function runOption(id: string, option: string | null, seed?: number, tweak?: (r: RuleSet) => void): Run {
  const s = scenarioById(id);
  let rules = cloneRules(s.baselineRules);
  if (option) rules = s.responses.find((r) => r.id === option)!.apply(rules);
  if (tweak) tweak(rules);
  return simulate(s.build(seed ?? s.defaultSeed), rules);
}

// ---- A. Duplicate integration event --------------------------------------

test('A baseline: the repeated event creates duplicate work and the focal request misses its target', () => {
  const m = computeMetrics(runOption('duplicate', null));
  assert.equal(m.deliveries, 6);
  assert.equal(m.distinctRequests, 4);
  assert.equal(m.tasksCreated, 6);
  assert.equal(m.duplicateTasks, 2);
  assert.equal(m.duplicateNotices, 2);
  assert.equal(m.wastedWorkMin, 348);
  assert.equal(m.focalCycleMin, 460);
  assert.equal(m.focalOnTarget, false);
  assert.equal(m.onTarget, 3);
});

test('A idempotency key: no duplicate task, no duplicate notice, nothing lost', () => {
  const run = runOption('duplicate', 'key');
  const m = computeMetrics(run);
  assert.equal(m.duplicateTasks, 0);
  assert.equal(m.duplicateNotices, 0);
  assert.equal(m.lostRequests, 0);
  assert.equal(m.wastedWorkMin, 0);
  assert.equal(m.suppressed, 2);
  assert.equal(m.focalCycleMin, 283);
  assert.equal(m.onTarget, 4);
  const suppressed = run.trace.filter((e) => e.action === 'delivery.suppressed');
  assert.deepEqual(suppressed.map((e) => e.causeId), ['D-102', 'D-104']);
  assert.ok(suppressed.every((e) => e.ruleId === 'R-DEDUP-KEY' && e.outcome === 'suppressed'));
});

test('A idempotency key holds for every seed: one task and one notice per key', () => {
  for (const seed of SEEDS) {
    const run = runOption('duplicate', 'key', seed);
    const keys = run.tasks.map((t) => t.idempotencyKey);
    assert.equal(new Set(keys).size, keys.length, `seed ${seed}: duplicate key among tasks`);
    assert.equal(run.notices.length, run.tasks.length, `seed ${seed}`);
    const m = computeMetrics(run);
    assert.equal(m.duplicateTasks, 0);
    assert.equal(m.lostRequests, 0);
  }
});

test('A title window of 15 min lets the late retry through', () => {
  const m = computeMetrics(runOption('duplicate', 'window-15'));
  assert.equal(m.duplicateTasks, 1);
  assert.equal(m.duplicateNotices, 1);
  assert.equal(m.lostRequests, 0);
  assert.equal(m.wastedWorkMin, 174);
});

test('A title window of 45 min suppresses a distinct request', () => {
  const run = runOption('duplicate', 'window-45');
  const m = computeMetrics(run);
  assert.equal(m.duplicateTasks, 0);
  assert.equal(m.lostRequests, 1);
  assert.equal(m.onTarget, 3);
  assert.ok(!run.tasks.some((t) => t.deliveryId === 'D-103'), 'the second business unit request never became a task');
});

test('A no title window gets both right: every width from 1 to 240 leaves a duplicate or loses a request', () => {
  for (let w = 1; w <= 240; w++) {
    const m = computeMetrics(runOption('duplicate', null, undefined, (r) => { r.dedupe.mode = 'window'; r.dedupe.windowMin = w; }));
    assert.ok(m.duplicateTasks + m.lostRequests >= 1, `window ${w}`);
  }
});

test('A key retention shorter than the retry delay lets the late retry through, and the trace says why', () => {
  const run = runOption('duplicate', 'key', undefined, (r) => { r.dedupe.keyRetentionMin = 30; });
  const m = computeMetrics(run);
  assert.equal(m.duplicateTasks, 1);
  const late = run.trace.find((e) => e.causeId === 'D-104' && e.action === 'delivery.accepted')!;
  assert.match(late.detail, /left the store after 30 min/);
});

// ---- B. Approval bottleneck ----------------------------------------------

test('B baseline: the approval waits for the absent approver and both targets are missed', () => {
  const m = computeMetrics(runOption('approval', null));
  assert.equal(m.approvalWaitMin, 1135);
  assert.equal(m.approvalOnTarget, false);
  assert.equal(m.focalCycleMin, 1380);
  assert.equal(m.focalOnTarget, false);
  assert.equal(m.escalations, 0);
  assert.equal(m.onTarget, 3);
});

test('B backup escalation: decided by an authorized person inside the target', () => {
  const run = runOption('approval', 'backup');
  const m = computeMetrics(run);
  assert.equal(m.approvalWaitMin, 160);
  assert.equal(m.approvalOnTarget, true);
  assert.equal(m.focalCycleMin, 405);
  assert.equal(m.escalations, 1);
  assert.equal(m.redundantReviews, 0);
  assert.equal(m.onTarget, 4);
  const t = run.tasks.find((x) => x.id === 'T-203')!;
  assert.equal(t.approval!.decidedBy, 'sam');
  assert.equal(t.state, 'Complete');
});

test('B the escalation itself never changes state', () => {
  for (const option of ['backup', 'remind']) {
    const run = runOption('approval', option);
    const sent = run.trace.filter((e) => e.action === 'escalation.sent');
    assert.ok(sent.length >= 1);
    for (const e of sent) {
      assert.equal(e.to, undefined, 'an escalation entry must not carry a state change');
      assert.equal(snapshotAt(run, e.seq).tasks.get(e.taskId!)!.state, 'AwaitingApproval');
    }
  }
});

test('B reminder to an absent approver changes nothing but the count', () => {
  const base = computeMetrics(runOption('approval', null));
  const m = computeMetrics(runOption('approval', 'remind'));
  assert.equal(m.escalations, 1);
  assert.equal(m.approvalWaitMin, base.approvalWaitMin);
  assert.equal(m.focalCycleMin, base.focalCycleMin);
});

test('B auto-approve is rejected by the guard and the task keeps waiting for a person', () => {
  const run = runOption('approval', 'auto');
  const rejected = run.trace.filter((e) => e.outcome === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].ruleId, 'R-ESC-AUTO');
  assert.equal(rejected[0].taskId, 'T-203');
  assert.match(rejected[0].detail, /guard G-APPROVAL/);
  assert.equal(snapshotAt(run, rejected[0].seq).tasks.get('T-203')!.state, 'AwaitingApproval');
  const m = computeMetrics(run);
  assert.equal(m.approvalWaitMin, 1135, 'still decided by the primary approver on return');
  assert.equal(run.tasks.find((t) => t.id === 'T-203')!.approval!.decidedBy, 'dana');
});

test('B no rule, threshold or seed lets approval-required work start without an authorized decision', () => {
  const modes = ['none', 'remind', 'backup', 'auto-approve'] as const;
  const thresholds = [15, 45, 60, 120, 480];
  const work: State[] = ['Assigned', 'InProgress', 'Complete'];
  for (const seed of SEEDS.slice(0, 60)) {
    for (const mode of modes) {
      for (const afterMin of thresholds) {
        const run = runOption('approval', null, seed, (r) => { r.escalation = { mode, afterMin }; });
        for (const t of run.tasks.filter((x) => x.requiresApproval)) {
          const firstWork = run.trace.find((e) => e.taskId === t.id && e.outcome === 'applied' && e.to && work.includes(e.to));
          if (!firstWork) continue;
          const decided = run.trace.find((e) => e.taskId === t.id && e.action === 'approval.decided');
          assert.ok(decided && decided.seq < firstWork.seq, `seed ${seed} ${mode}@${afterMin}: ${t.id} worked before a decision`);
          const who = run.data.approvers.find((a) => a.id === t.approval!.decidedBy)!;
          assert.ok(run.data.policy.authorizedRoles.includes(who.role));
          assert.equal(t.approval!.decision, 'approved');
        }
      }
    }
  }
});

test('B a low threshold costs redundant reviews', () => {
  const m = computeMetrics(runOption('approval', 'backup', undefined, (r) => { r.escalation.afterMin = 60; }));
  assert.equal(m.escalations, 3);
  assert.equal(m.redundantReviews, 2);
});

test('B a decision from an unauthorized role is rejected and recorded', () => {
  const s = scenarioById('approval');
  const data = s.build(s.defaultSeed);
  data.inputs.push({ kind: 'approval.decision.submitted', id: 'X-1', at: 170, taskId: 'T-203', approverId: 'jordan', decision: 'approved' });
  const run = simulate(data, cloneRules(s.baselineRules));
  const e = run.trace.find((x) => x.causeId === 'X-1')!;
  assert.equal(e.outcome, 'rejected');
  assert.match(e.detail, /not an authorized approver/);
  assert.equal(snapshotAt(run, e.seq).tasks.get('T-203')!.state, 'AwaitingApproval');
});

test('B an authorized rejection cancels the task and no work happens', () => {
  const s = scenarioById('approval');
  const data = s.build(s.defaultSeed);
  data.inputs.push({ kind: 'approval.decision.submitted', id: 'X-2', at: 170, taskId: 'T-203', approverId: 'sam', decision: 'rejected' });
  const run = simulate(data, cloneRules(s.baselineRules));
  const t = run.tasks.find((x) => x.id === 'T-203')!;
  assert.equal(t.state, 'Canceled');
  assert.equal(t.workedMin, 0);
  assert.equal(t.startedAt, null);
});

// ---- C. Assignment failure -----------------------------------------------

test('C baseline: work goes to an unqualified team and sits blocked where nobody can see it', () => {
  const run = runOption('assignment', null);
  const m = computeMetrics(run);
  assert.equal(m.wastedWorkMin, 240);
  assert.equal(m.hiddenBlockedMin, 566);
  assert.equal(m.focalCycleMin, 646);
  assert.equal(m.focalOnTarget, false);
  assert.equal(m.blockedAtEnd, 1);
  assert.equal(m.onTarget, 3);
  const stopped = run.trace.filter((e) => e.action === 'work.stopped');
  assert.deepEqual(stopped.map((e) => e.taskId), ['T-303', 'T-304']);
});

test('C flag and queue: every block is raised in the same step and nobody works on the wrong task', () => {
  for (const seed of SEEDS) {
    const run = runOption('assignment', 'flag', seed);
    const m = computeMetrics(run);
    assert.equal(m.hiddenBlockedMin, 0, `seed ${seed}`);
    assert.equal(m.wastedWorkMin, 0, `seed ${seed}`);
    for (const e of run.trace.filter((x) => x.outcome === 'applied' && x.to === 'InProgress')) {
      const task = run.tasks.find((t) => t.id === e.taskId)!;
      const team = run.data.teams.find((t) => t.id === e.teamId)!;
      assert.ok(team.skills.includes(task.skill), `seed ${seed}: ${team.name} started ${task.id} without the skill`);
    }
  }
  const run = runOption('assignment', 'flag');
  const t303 = run.tasks.find((t) => t.id === 'T-303')!;
  assert.equal(t303.exception!.code, 'TEAM_AT_CAPACITY');
  assert.equal(t303.exception!.raisedAt, t303.exception!.occurredAt);
  assert.equal(t303.ownerTeamId, 'integrations');
  assert.equal(computeMetrics(run).focalCycleMin, 580);
});

test('C a request with no qualified owner stays blocked and visible instead of being worked on', () => {
  const run = runOption('assignment', 'flag');
  const t = run.tasks.find((x) => x.id === 'T-304')!;
  assert.equal(t.state, 'Blocked');
  assert.equal(t.exception!.code, 'NO_QUALIFIED_OWNER');
  assert.equal(t.exception!.raisedAt, 92);
  assert.equal(t.workedMin, 0);
  assert.ok(run.trace.some((e) => e.taskId === 'T-304' && e.action === 'exception.acknowledged'));
});

test('C overflow: the focal task finishes on target and the second team pays for it', () => {
  const run = runOption('assignment', 'overflow');
  const m = computeMetrics(run);
  assert.equal(run.tasks.find((t) => t.id === 'T-303')!.ownerTeamId, 'solutions');
  assert.equal(m.focalCycleMin, 341);
  assert.equal(m.focalOnTarget, true);
  const reporting = run.tasks.find((t) => t.id === 'T-305')!;
  assert.ok(reporting.completedAt! > reporting.dueAt, 'the Solutions team task is now late');
  const flag = runOption('assignment', 'flag').tasks.find((t) => t.id === 'T-305')!;
  assert.ok(flag.completedAt! <= flag.dueAt, 'it was on time under flag and queue');
  assert.equal(m.onTarget, 3);
});

test('C teams never exceed capacity at any point in any run', () => {
  for (const s of SCENARIOS) {
    for (const option of [null, ...s.responses.map((r) => r.id)]) {
      const run = runOption(s.id, option);
      for (let i = 0; i < run.trace.length; i++) {
        const snap = snapshotAt(run, i);
        for (const team of run.data.teams) {
          const busy = [...snap.tasks.values()].filter((t) => t.state === 'InProgress' && t.teamId === team.id).length;
          assert.ok(busy <= team.capacity, `${s.id}/${option}: ${team.name} at ${busy}/${team.capacity}`);
        }
      }
    }
  }
});

// ---- determinism, reset, reconciliation ----------------------------------

test('replaying a seed gives the same run, entry for entry', () => {
  for (const s of SCENARIOS) {
    for (const option of [null, ...s.responses.map((r) => r.id)]) {
      const a = runOption(s.id, option);
      const b = runOption(s.id, option);
      assert.deepEqual(a.trace, b.trace);
      assert.deepEqual(a.tasks, b.tasks);
      assert.equal(fingerprint(a), fingerprint(b));
    }
  }
});

test('a different seed gives different inputs, and the baseline failure still occurs', () => {
  for (const s of SCENARIOS) {
    const prints = new Set(SEEDS.slice(0, 40).map((seed) => fingerprint(runOption(s.id, null, seed))));
    assert.ok(prints.size > 10, `${s.id}: seeds should vary the run`);
  }
  for (const seed of SEEDS) {
    assert.equal(computeMetrics(runOption('duplicate', null, seed)).duplicateTasks, 2);
    assert.equal(computeMetrics(runOption('duplicate', null, seed)).focalOnTarget, false);
    assert.equal(computeMetrics(runOption('duplicate', 'key', seed)).focalOnTarget, true);
    assert.equal(computeMetrics(runOption('approval', null, seed)).approvalOnTarget, false);
    assert.equal(computeMetrics(runOption('approval', 'backup', seed)).approvalOnTarget, true);
    assert.equal(computeMetrics(runOption('approval', 'backup', seed)).redundantReviews, 0);
    assert.equal(computeMetrics(runOption('assignment', null, seed)).wastedWorkMin, 240);
    assert.equal(computeMetrics(runOption('assignment', 'overflow', seed)).focalOnTarget, true);
  }
});

test('reset: a run leaves no state behind and does not change its inputs', () => {
  const s = scenarioById('duplicate');
  const data = s.build(s.defaultSeed);
  const rules = cloneRules(s.baselineRules);
  const dataBefore = JSON.stringify(data);
  const rulesBefore = JSON.stringify(rules);
  const first = simulate(data, rules);
  assert.equal(JSON.stringify(data), dataBefore);
  assert.equal(JSON.stringify(rules), rulesBefore);
  simulate(s.build(s.defaultSeed), s.responses[0].apply(rules)); // a revised run in between
  const again = simulate(data, rules);
  assert.equal(fingerprint(again), fingerprint(first));
  assert.equal(JSON.stringify(s.baselineRules), rulesBefore, 'applying a response must not edit the baseline rules');
});

test('metrics reconcile with the event records for every scenario, option and seed', () => {
  for (const s of SCENARIOS) {
    for (const option of [null, ...s.responses.map((r) => r.id)]) {
      for (const seed of SEEDS.slice(0, 50)) {
        const run = runOption(s.id, option, seed);
        const failed = reconcile(run).filter((c) => !c.ok);
        assert.deepEqual(failed, [], `${s.id}/${option}/seed ${seed}`);
        // Independent recount from the task records.
        const m = computeMetrics(run);
        const deliveries = run.data.inputs.filter((i): i is RequestDelivery => i.kind === 'request.delivered');
        const retryIds = new Set(deliveries.filter((d) => d.truth === 'retry').map((d) => d.id));
        assert.equal(m.duplicateTasks, run.tasks.filter((t) => retryIds.has(t.deliveryId)).length);
        assert.equal(m.tasksCreated + m.suppressed, deliveries.length);
        assert.equal(m.openAtEnd, run.tasks.filter((t) => t.state !== 'Complete' && t.state !== 'Canceled').length);
        const wasted = run.tasks.reduce((n, t) => n + (retryIds.has(t.deliveryId) ? t.workedMin : t.misroutedMin), 0);
        assert.equal(m.wastedWorkMin, wasted);
        const onTarget = deliveries.filter((d) => d.truth !== 'retry').filter((d) => {
          const t = run.tasks.find((x) => x.deliveryId === d.id);
          return !!t && t.completedAt !== null && t.completedAt <= t.dueAt;
        }).length;
        assert.equal(m.onTarget, onTarget);
      }
    }
  }
});

test('every trace entry names a known rule, time never runs backwards, applied changes are in the table', () => {
  for (const s of SCENARIOS) {
    for (const option of [null, ...s.responses.map((r) => r.id)]) {
      const run = runOption(s.id, option);
      let last = 0;
      run.trace.forEach((e, i) => {
        assert.equal(e.seq, i);
        assert.ok(RULES[e.ruleId], `unknown rule ${e.ruleId}`);
        assert.ok(e.at >= last);
        assert.ok(e.detail.length > 0 && e.causeId.length > 0);
        last = e.at;
        if (e.outcome === 'applied' && e.from && e.to) assert.ok(TRANSITIONS[e.from].includes(e.to));
      });
    }
  }
});

test('firstDivergence points at the delivery the fix handled differently', () => {
  const d = firstDivergence(runOption('duplicate', null), runOption('duplicate', 'key'))!;
  assert.equal(d.base!.causeId, 'D-101');
  assert.equal(d.base!.ruleId, 'R-DEDUP-NONE');
  assert.equal(d.revised!.ruleId, 'R-DEDUP-KEY');
  assert.equal(firstDivergence(runOption('duplicate', null), runOption('duplicate', null)), null);
});

test('a request for an unknown customer is canceled at validation', () => {
  const s = scenarioById('duplicate');
  const data = s.build(s.defaultSeed);
  data.inputs.push({ kind: 'request.delivered', id: 'D-199', at: 100, idempotencyKey: 'REQ-X', customerId: 'ghost', title: 'x', skill: 'api', effortMin: 30, requiresApproval: false, targetMin: 480, truth: 'distinct' });
  const run = simulate(data, cloneRules(s.baselineRules));
  const t = run.tasks.find((x) => x.id === 'T-199')!;
  assert.equal(t.state, 'Canceled');
  assert.equal(run.notices.filter((n) => n.taskId === 'T-199').length, 0);
});

test('seed validation', () => {
  assert.ok(validSeed(1) && validSeed(999999));
  for (const bad of [0, -5, 1.5, 1000000, NaN, '7', null]) assert.equal(validSeed(bad), false);
  assert.throws(() => scenarioById('nope'), /Unknown scenario/);
});
