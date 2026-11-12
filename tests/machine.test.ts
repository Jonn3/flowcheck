import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, TRANSITIONS, TRANSITION_REASON, checkTransition, assertTransition, InvalidTransitionError } from '../src/engine/machine.ts';
import { validateRules, hasErrors, RULES } from '../src/engine/rules.ts';
import { scenarioById } from '../src/engine/scenarios.ts';
import type { Task, State } from '../src/engine/types.ts';

const data = scenarioById('approval').build(2202);
const { policy, approvers } = data;

function task(state: State, over: Partial<Task> = {}): Task {
  return {
    id: 'T-1', deliveryId: 'D-1', idempotencyKey: 'K', customerId: 'kestrel', title: 't', skill: 'api',
    effortMin: 60, requiresApproval: false, createdAt: 0, dueAt: 480, state, ownerTeamId: null,
    assignedAt: null, startedAt: null, completedAt: null, workedMin: 0, misroutedMin: 0,
    approval: null, exception: null, ...over,
  };
}

test('every state has a row in the transition table and every edge is documented', () => {
  for (const s of STATES) {
    assert.ok(Array.isArray(TRANSITIONS[s]), `missing row for ${s}`);
    for (const to of TRANSITIONS[s]) {
      assert.ok(STATES.includes(to));
      assert.ok(TRANSITION_REASON[`${s}>${to}`], `no documented reason for ${s}>${to}`);
    }
  }
  assert.equal(Object.keys(TRANSITION_REASON).length, STATES.reduce((n, s) => n + TRANSITIONS[s].length, 0));
});

test('Complete and Canceled are terminal', () => {
  assert.deepEqual(TRANSITIONS.Complete, []);
  assert.deepEqual(TRANSITIONS.Canceled, []);
  for (const to of STATES) {
    assert.equal(checkTransition(task('Complete'), to, policy, approvers).ok, false);
    assert.equal(checkTransition(task('Canceled'), to, policy, approvers).ok, false);
  }
});

test('transitions outside the table are rejected with a readable reason', () => {
  const skips: [State, State][] = [
    ['Requested', 'Assigned'], ['Requested', 'Complete'], ['NeedsValidation', 'InProgress'],
    ['NeedsValidation', 'Complete'], ['Assigned', 'Complete'], ['Blocked', 'InProgress'], ['Blocked', 'Complete'],
    ['InProgress', 'Assigned'], ['AwaitingApproval', 'InProgress'],
  ];
  for (const [from, to] of skips) {
    const c = checkTransition(task(from), to, policy, approvers);
    assert.equal(c.ok, false, `${from}>${to} should be rejected`);
    if (!c.ok) {
      assert.equal(c.code, 'NOT_ALLOWED');
      assert.match(c.reason, /not an allowed transition/);
    }
  }
  assert.throws(() => assertTransition(task('Requested'), 'Complete', policy, approvers), InvalidTransitionError);
});

test('guard G-APPROVAL: no decision, no release', () => {
  const t = task('AwaitingApproval', { requiresApproval: true, approval: { requestedAt: 0, requestedFrom: 'dana', decidedAt: null, decidedBy: null, decision: null } });
  for (const to of ['Assigned', 'Blocked'] as State[]) {
    const c = checkTransition(t, to, policy, approvers);
    assert.equal(c.ok, false);
    if (!c.ok) assert.equal(c.code, 'G-APPROVAL');
  }
  // Canceling does not need an approval.
  assert.equal(checkTransition(t, 'Canceled', policy, approvers).ok, true);
});

test('guard G-APPROVAL: a decision from an unauthorized role does not count', () => {
  const t = task('AwaitingApproval', { requiresApproval: true, approval: { requestedAt: 0, requestedFrom: 'dana', decidedAt: 50, decidedBy: 'jordan', decision: 'approved' } });
  assert.equal(checkTransition(t, 'Assigned', policy, approvers).ok, false);
  t.approval!.decidedBy = 'nobody';
  assert.equal(checkTransition(t, 'Assigned', policy, approvers).ok, false);
});

test('guard G-APPROVAL: an authorized approval releases the task, a rejection does not', () => {
  const t = task('AwaitingApproval', { requiresApproval: true, approval: { requestedAt: 0, requestedFrom: 'dana', decidedAt: 50, decidedBy: 'sam', decision: 'approved' } });
  assert.equal(checkTransition(t, 'Assigned', policy, approvers).ok, true);
  t.approval!.decision = 'rejected';
  assert.equal(checkTransition(t, 'Assigned', policy, approvers).ok, false);
});

test('guard G-APPROVAL also covers the Blocked side door', () => {
  const t = task('Blocked', { requiresApproval: true });
  const c = checkTransition(t, 'Assigned', policy, approvers);
  assert.equal(c.ok, false);
});

test('rule editor validation: bounds, whole numbers, known modes', () => {
  const good = scenarioById('duplicate').baselineRules;
  assert.deepEqual(validateRules(good), []);

  const cases: [string, (r: any) => void, string][] = [
    ['window too small', (r) => (r.dedupe.windowMin = 0), 'dedupe.windowMin'],
    ['window too large', (r) => (r.dedupe.windowMin = 241), 'dedupe.windowMin'],
    ['fractional threshold', (r) => (r.escalation.afterMin = 30.5), 'escalation.afterMin'],
    ['text threshold', (r) => (r.escalation.afterMin = 'soon'), 'escalation.afterMin'],
    ['NaN retention', (r) => (r.dedupe.keyRetentionMin = NaN), 'dedupe.keyRetentionMin'],
    ['negative queue limit', (r) => (r.assignment.queueLimit = -1), 'assignment.queueLimit'],
    ['unknown mode', (r) => (r.dedupe.mode = 'magic'), 'dedupe.mode'],
  ];
  for (const [name, mutate, path] of cases) {
    const r = structuredClone(good);
    mutate(r);
    const issues = validateRules(r);
    assert.ok(hasErrors(issues), name);
    assert.ok(issues.some((i) => i.path === path && i.severity === 'error' && i.message.length > 10), name);
  }
  assert.ok(hasErrors(validateRules(null)));
  assert.ok(hasErrors(validateRules({})));
});

test('auto-approve is a warning, not an error: it runs and the guard stops it', () => {
  const r = structuredClone(scenarioById('approval').baselineRules);
  r.escalation.mode = 'auto-approve';
  const issues = validateRules(r);
  assert.equal(hasErrors(issues), false);
  assert.ok(issues.some((i) => i.severity === 'warning' && /G-APPROVAL/.test(i.message)));
});

test('rule catalog entries are complete', () => {
  for (const [id, r] of Object.entries(RULES)) {
    assert.equal(r.id, id);
    assert.ok(r.name && r.text);
  }
});
