// Metrics, reconciliation and run comparison.
//
// computeMetrics() reads only the trace and the scenario inputs. It never
// reads the final task records. reconcile() then checks the trace against the
// task records, so a metric on screen can always be followed back to events.

import type { Run, RequestDelivery, State, TraceEntry } from './types.ts';
import { TRANSITIONS } from './machine.ts';

export interface Metrics {
  deliveries: number;
  distinctRequests: number;
  tasksCreated: number;
  duplicateTasks: number;
  suppressed: number;
  lostRequests: number;
  duplicateNotices: number;
  wastedWorkMin: number;
  onTarget: number;
  focalDoneAt: number | null;
  focalCycleMin: number | null;
  focalOnTarget: boolean;
  approvalWaitMin: number | null;
  approvalOnTarget: boolean | null;
  escalations: number;
  redundantReviews: number;
  rejectedTransitions: number;
  hiddenBlockedMin: number;
  blockedAtEnd: number;
  openAtEnd: number;
}

export interface MetricDef {
  id: keyof Metrics;
  label: string;
  unit: 'count' | 'min' | 'of-distinct' | 'clock' | 'yesno';
  better: 'lower' | 'higher' | 'none';
  definition: string;
}

export const METRIC_DEFS: MetricDef[] = [
  { id: 'onTarget', label: 'Requests completed on target', unit: 'of-distinct', better: 'higher', definition: 'Distinct requests (retries excluded) whose task reached Complete at or before delivery time plus its completion target. A suppressed distinct request counts as missed.' },
  { id: 'focalDoneAt', label: 'Focal request completed', unit: 'clock', better: 'none', definition: 'Simulated time the highlighted request reached Complete. Blank if it never did.' },
  { id: 'focalCycleMin', label: 'Focal request cycle time', unit: 'min', better: 'lower', definition: 'Working minutes from delivery to Complete for the highlighted request.' },
  { id: 'duplicateTasks', label: 'Duplicate tasks created', unit: 'count', better: 'lower', definition: 'Tasks created from a delivery that the synthetic data labels as a retry of an earlier delivery.' },
  { id: 'duplicateNotices', label: 'Duplicate customer notices', unit: 'count', better: 'lower', definition: 'Kickoff notices sent for duplicate tasks.' },
  { id: 'lostRequests', label: 'Distinct requests wrongly suppressed', unit: 'count', better: 'lower', definition: 'Deliveries labeled as original or distinct that a duplicate rule suppressed.' },
  { id: 'wastedWorkMin', label: 'Wasted work', unit: 'min', better: 'lower', definition: 'Finished work minutes on duplicate tasks, plus minutes worked by a team that then stopped because it lacked the skill.' },
  { id: 'approvalWaitMin', label: 'Focal approval wait', unit: 'min', better: 'lower', definition: 'Working minutes from the approval request to a recorded decision for the highlighted request. Blank if no decision was recorded.' },
  { id: 'approvalOnTarget', label: 'Approval decided within target', unit: 'yesno', better: 'higher', definition: 'Whether the focal approval wait is at or under the decision target.' },
  { id: 'escalations', label: 'Escalations sent', unit: 'count', better: 'none', definition: 'Reminders, backup notifications and auto-approve attempts created by the escalation rule.' },
  { id: 'redundantReviews', label: 'Redundant approver reviews', unit: 'count', better: 'lower', definition: 'Approval reviews that finished after another approver had already closed the request.' },
  { id: 'rejectedTransitions', label: 'Transitions rejected', unit: 'count', better: 'none', definition: 'State changes the state machine or guard G-APPROVAL refused, plus decisions from unauthorized roles.' },
  { id: 'hiddenBlockedMin', label: 'Blocked time nobody could see', unit: 'min', better: 'lower', definition: 'For each time a task entered Blocked: minutes until an exception was raised to a person. Zero when the exception is raised in the same step.' },
  { id: 'blockedAtEnd', label: 'Still blocked at end', unit: 'count', better: 'lower', definition: 'Tasks in Blocked when the simulation ends.' },
  { id: 'openAtEnd', label: 'Open at end', unit: 'count', better: 'lower', definition: 'Tasks not in Complete or Canceled when the simulation ends.' },
  { id: 'tasksCreated', label: 'Tasks created', unit: 'count', better: 'none', definition: 'Count of task.created entries in the trace.' },
  { id: 'suppressed', label: 'Deliveries suppressed', unit: 'count', better: 'none', definition: 'Count of delivery.suppressed entries in the trace.' },
  { id: 'deliveries', label: 'Deliveries received', unit: 'count', better: 'none', definition: 'Request deliveries in the scenario input, including retries.' },
];

interface Life {
  taskId: string;
  deliveryId: string;
  state: State;
  completedAt: number | null;
  workMin: number;
  stoppedMin: number;
}

/** Rebuild each task's life from the trace alone. */
export function livesFromTrace(trace: TraceEntry[]): Map<string, Life> {
  const lives = new Map<string, Life>();
  const startedAt = new Map<string, number>();
  for (const e of trace) {
    if (e.action === 'task.created' && e.taskId) {
      lives.set(e.taskId, { taskId: e.taskId, deliveryId: e.causeId, state: 'Requested', completedAt: null, workMin: 0, stoppedMin: 0 });
      continue;
    }
    if (e.outcome !== 'applied' || !e.taskId || !e.to) continue;
    const life = lives.get(e.taskId);
    if (!life) continue;
    if (e.from === 'InProgress') {
      const seg = e.at - (startedAt.get(e.taskId) ?? e.at);
      if (e.to === 'Complete' || e.to === 'Blocked') life.workMin += seg;
      if (e.action === 'work.stopped') life.stoppedMin += seg;
    }
    if (e.to === 'InProgress') startedAt.set(e.taskId, e.at);
    if (e.to === 'Complete') life.completedAt = e.at;
    life.state = e.to;
  }
  return lives;
}

export function computeMetrics(run: Run): Metrics {
  const deliveries = run.data.inputs.filter((i): i is RequestDelivery => i.kind === 'request.delivered');
  const byDelivery = new Map(deliveries.map((d) => [d.id, d]));
  const lives = livesFromTrace(run.trace);
  const lifeByDelivery = new Map([...lives.values()].map((l) => [l.deliveryId, l]));
  const isDup = (taskId: string) => byDelivery.get(lives.get(taskId)?.deliveryId ?? '')?.truth === 'retry';

  const distinct = deliveries.filter((d) => d.truth !== 'retry');
  const suppressedIds = new Set(run.trace.filter((e) => e.action === 'delivery.suppressed').map((e) => e.causeId));

  let onTarget = 0;
  for (const d of distinct) {
    const life = lifeByDelivery.get(d.id);
    if (life && life.completedAt !== null && life.completedAt <= d.at + d.targetMin) onTarget++;
  }

  let wasted = 0;
  for (const l of lives.values()) wasted += byDelivery.get(l.deliveryId)?.truth === 'retry' ? l.workMin : l.stoppedMin;

  const focal = deliveries.find((d) => d.focal);
  const focalLife = focal ? lifeByDelivery.get(focal.id) : undefined;
  const focalDoneAt = focalLife?.completedAt ?? null;

  let approvalWait: number | null = null;
  if (focalLife) {
    const req = run.trace.find((e) => e.action === 'approval.requested' && e.taskId === focalLife.taskId);
    const dec = run.trace.find((e) => e.action === 'approval.decided' && e.taskId === focalLife.taskId);
    if (req && dec) approvalWait = dec.at - req.at;
  }
  const needsApproval = !!focal?.requiresApproval;

  let hidden = 0;
  run.trace.forEach((e, i) => {
    if (e.outcome !== 'applied' || e.to !== 'Blocked' || !e.taskId) return;
    if (e.action === 'exception.raised') return;
    const raised = run.trace.slice(i + 1).find((r) => r.action === 'exception.raised' && r.taskId === e.taskId);
    hidden += (raised ? raised.at : run.endAt) - e.at;
  });

  const states = [...lives.values()].map((l) => l.state);
  return {
    deliveries: deliveries.length,
    distinctRequests: distinct.length,
    tasksCreated: lives.size,
    duplicateTasks: [...lives.keys()].filter(isDup).length,
    suppressed: suppressedIds.size,
    lostRequests: distinct.filter((d) => suppressedIds.has(d.id)).length,
    duplicateNotices: run.trace.filter((e) => e.action === 'notice.sent' && e.taskId && isDup(e.taskId)).length,
    wastedWorkMin: wasted,
    onTarget,
    focalDoneAt,
    focalCycleMin: focal && focalDoneAt !== null ? focalDoneAt - focal.at : null,
    focalOnTarget: !!focal && focalDoneAt !== null && focalDoneAt <= focal.at + focal.targetMin,
    approvalWaitMin: approvalWait,
    approvalOnTarget: needsApproval ? approvalWait !== null && approvalWait <= run.data.policy.decisionTargetMin : null,
    escalations: run.trace.filter((e) => e.action === 'escalation.sent' || e.ruleId === 'R-ESC-AUTO' && e.action === 'transition.rejected').length,
    redundantReviews: run.trace.filter((e) => e.action === 'approval.decision.redundant').length,
    rejectedTransitions: run.trace.filter((e) => e.outcome === 'rejected').length,
    hiddenBlockedMin: hidden,
    blockedAtEnd: states.filter((s) => s === 'Blocked').length,
    openAtEnd: states.filter((s) => s !== 'Complete' && s !== 'Canceled').length,
  };
}

export interface ReconcileCheck {
  name: string;
  ok: boolean;
  fromTrace: number | string;
  fromRecords: number | string;
}

/** Compare what the trace says against the final task records. */
export function reconcile(run: Run): ReconcileCheck[] {
  const lives = livesFromTrace(run.trace);
  const checks: ReconcileCheck[] = [];
  const add = (name: string, a: number | string, b: number | string) => checks.push({ name, ok: a === b, fromTrace: a, fromRecords: b });

  add('Tasks created', lives.size, run.tasks.length);
  const deliveries = run.data.inputs.filter((i) => i.kind === 'request.delivered').length;
  const acceptedN = run.trace.filter((e) => e.action === 'delivery.accepted').length;
  const suppressedN = run.trace.filter((e) => e.action === 'delivery.suppressed').length;
  add('Deliveries = accepted + suppressed', acceptedN + suppressedN, deliveries);
  add('Accepted deliveries = tasks', acceptedN, run.tasks.length);

  let stateMismatch = 0;
  for (const t of run.tasks) if (lives.get(t.id)?.state !== t.state) stateMismatch++;
  add('Final state of every task', stateMismatch === 0 ? 'all match' : `${stateMismatch} differ`, 'all match');

  let illegal = 0;
  for (const e of run.trace) {
    if (e.outcome === 'applied' && e.from && e.to && !TRANSITIONS[e.from].includes(e.to)) illegal++;
  }
  add('Applied transitions inside the table', illegal === 0 ? 'all allowed' : `${illegal} illegal`, 'all allowed');

  const workTrace = [...lives.values()].reduce((s, l) => s + l.workMin, 0);
  const workRecords = run.tasks.reduce((s, t) => s + t.workedMin, 0);
  add('Work minutes', workTrace, workRecords);

  add('Completed tasks', [...lives.values()].filter((l) => l.state === 'Complete').length, run.tasks.filter((t) => t.state === 'Complete').length);
  add('Kickoff notices', run.trace.filter((e) => e.action === 'notice.sent').length, run.notices.length);
  add('Escalation records', run.trace.filter((e) => e.action === 'escalation.sent' || e.ruleId === 'R-ESC-AUTO' && e.action === 'transition.rejected').length, run.escalations.length);
  return checks;
}

/** Short stable hash of a run's trace, so a replay can be checked by eye. */
export function fingerprint(run: Run): string {
  let h = 0x811c9dc5;
  for (const e of run.trace) {
    const s = `${e.at}|${e.causeId}|${e.ruleId}|${e.action}|${e.outcome}|${e.taskId ?? ''}|${e.from ?? ''}|${e.to ?? ''}|${e.detail}\n`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0');
}

const signature = (e: TraceEntry) => `${e.at}|${e.causeId}|${e.ruleId}|${e.action}|${e.outcome}|${e.taskId ?? ''}|${e.to ?? ''}`;

/** The first point where two runs of the same inputs stop matching. */
export function firstDivergence(base: Run, revised: Run): { index: number; base: TraceEntry | null; revised: TraceEntry | null } | null {
  const n = Math.max(base.trace.length, revised.trace.length);
  for (let i = 0; i < n; i++) {
    const a = base.trace[i];
    const b = revised.trace[i];
    if (!a || !b || signature(a) !== signature(b)) return { index: i, base: a ?? null, revised: b ?? null };
  }
  return null;
}

export interface Snapshot {
  at: number;
  tasks: Map<string, { state: State; teamId: string | null }>;
}

/** State of every task after trace entries 0..index have been applied. */
export function snapshotAt(run: Run, index: number): Snapshot {
  const tasks = new Map<string, { state: State; teamId: string | null }>();
  let at = 0;
  for (let i = 0; i <= index && i < run.trace.length; i++) {
    const e = run.trace[i];
    at = e.at;
    if (e.outcome !== 'applied' || !e.taskId || !e.to) continue;
    const prev = tasks.get(e.taskId);
    const keepsTeam = e.to === 'InProgress' || e.to === 'Assigned' || e.to === 'Complete';
    tasks.set(e.taskId, { state: e.to, teamId: e.teamId ?? (keepsTeam ? prev?.teamId ?? null : null) });
  }
  return { at, tasks };
}
