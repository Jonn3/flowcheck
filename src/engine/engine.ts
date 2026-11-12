// The deterministic simulation engine.
//
// simulate(data, rules) is a pure function: the same inputs and rules always
// give the same run. It reads no wall clock and draws no random numbers.
// Every state change goes through move(), which asks the state machine first
// and writes a trace entry whether the change is applied or rejected.

import type {
  ScenarioData, RuleSet, Run, Task, TraceEntry, Notice, Escalation, State,
  RequestDelivery, InputEvent, Team,
} from './types.ts';
import { checkTransition, STATE_LABEL } from './machine.ts';
import { fmtClock } from './clock.ts';

interface Timer {
  at: number;
  seq: number;
  id: string;
  kind: 'input' | 'validate' | 'decision' | 'escalation-check' | 'triage-lead' | 'daily-triage' | 'work-complete' | 'misroute';
  taskId?: string;
  teamId?: string;
  approverId?: string;
  decision?: 'approved' | 'rejected';
  reviewStart?: number;
  duration?: number;
  input?: InputEvent;
}

const MAX_STEPS = 20000;

export function taskIdFor(deliveryId: string): string {
  return 'T-' + deliveryId.replace(/^D-/, '');
}

export function simulate(data: ScenarioData, rules: RuleSet): Run {
  const tasks: Task[] = [];
  const byId = new Map<string, Task>();
  const trace: TraceEntry[] = [];
  const notices: Notice[] = [];
  const escalations: Escalation[] = [];
  const timers: Timer[] = [];
  const queues = new Map<string, string[]>();
  const keyStore = new Map<string, { at: number; deliveryId: string }>();
  const accepted: RequestDelivery[] = [];
  const noticed = new Set<string>();
  let seq = 0;
  let now = 0;

  for (const t of data.teams) queues.set(t.id, []);
  const team = (id: string): Team => data.teams.find((t) => t.id === id)!;
  const customerName = (id: string) => data.customers.find((c) => c.id === id)?.name ?? id;
  const approver = (id: string) => data.approvers.find((a) => a.id === id);

  function schedule(t: Omit<Timer, 'seq'>): void {
    timers.push({ ...t, seq: seq++ });
  }

  function log(e: Omit<TraceEntry, 'seq' | 'at'>): void {
    trace.push({ seq: trace.length, at: now, ...e });
  }

  /** The only place a task changes state. */
  function move(task: Task, to: State, action: string, ruleId: string, causeId: string, detail: string, teamId?: string): boolean {
    const from = task.state;
    const check = checkTransition(task, to, data.policy, data.approvers);
    if (!check.ok) {
      log({
        causeId, ruleId, action: 'transition.rejected', outcome: 'rejected', taskId: task.id, from, to,
        detail: `${detail} Rejected by ${check.code === 'G-APPROVAL' ? 'guard G-APPROVAL' : 'the transition table'}: ${check.reason} The task stays in ${STATE_LABEL[from]}.`,
      });
      return false;
    }
    task.state = to;
    log({ causeId, ruleId, action, outcome: 'applied', taskId: task.id, teamId, from, to, detail });
    return true;
  }

  const inProgress = (teamId: string) => tasks.filter((t) => t.state === 'InProgress' && t.ownerTeamId === teamId).length;
  const backlog = (teamId: string) => inProgress(teamId) + queues.get(teamId)!.length;

  // ---- intake -------------------------------------------------------------

  function onDelivery(d: RequestDelivery): void {
    const mode = rules.dedupe.mode;
    if (mode === 'key') {
      const seen = keyStore.get(d.idempotencyKey);
      if (seen && now - seen.at <= rules.dedupe.keyRetentionMin) {
        log({
          causeId: d.id, ruleId: 'R-DEDUP-KEY', action: 'delivery.suppressed', outcome: 'suppressed',
          detail: `Delivery ${d.id} carries key ${d.idempotencyKey}, first seen on ${seen.deliveryId} at ${fmtClock(seen.at)}. No task created and no notice sent.`,
        });
        return;
      }
      const expired = !!seen;
      keyStore.set(d.idempotencyKey, { at: now, deliveryId: d.id });
      log({
        causeId: d.id, ruleId: 'R-DEDUP-KEY', action: 'delivery.accepted', outcome: 'noted',
        detail: expired
          ? `Key ${d.idempotencyKey} was seen on ${seen!.deliveryId}, but it left the store after ${rules.dedupe.keyRetentionMin} min. Delivery ${d.id} is accepted as new.`
          : `Key ${d.idempotencyKey} is new. Delivery ${d.id} accepted.`,
      });
    } else if (mode === 'window') {
      const match = accepted.find((a) => a.customerId === d.customerId && a.title === d.title && now - a.at <= rules.dedupe.windowMin);
      if (match) {
        log({
          causeId: d.id, ruleId: 'R-DEDUP-WINDOW', action: 'delivery.suppressed', outcome: 'suppressed',
          detail: `Delivery ${d.id} has the same customer and title as ${match.id}, received ${now - match.at} min earlier. Inside the ${rules.dedupe.windowMin} min window, so no task is created. Keys are not compared (${d.idempotencyKey} vs ${match.idempotencyKey}).`,
        });
        return;
      }
      log({
        causeId: d.id, ruleId: 'R-DEDUP-WINDOW', action: 'delivery.accepted', outcome: 'noted',
        detail: `No accepted delivery with the same customer and title in the last ${rules.dedupe.windowMin} min. Delivery ${d.id} accepted.`,
      });
    } else {
      log({
        causeId: d.id, ruleId: 'R-DEDUP-NONE', action: 'delivery.accepted', outcome: 'noted',
        detail: `Delivery ${d.id} accepted without a duplicate check (key ${d.idempotencyKey}).`,
      });
    }
    accepted.push(d);

    const task: Task = {
      id: taskIdFor(d.id), deliveryId: d.id, idempotencyKey: d.idempotencyKey, customerId: d.customerId,
      title: d.title, skill: d.skill, effortMin: d.effortMin, requiresApproval: d.requiresApproval,
      createdAt: now, dueAt: now + d.targetMin, state: 'Requested', ownerTeamId: null,
      assignedAt: null, startedAt: null, completedAt: null, workedMin: 0, misroutedMin: 0,
      approval: null, exception: null,
    };
    tasks.push(task);
    byId.set(task.id, task);
    log({
      causeId: d.id, ruleId: 'R-INTAKE-01', action: 'task.created', outcome: 'applied', taskId: task.id, to: 'Requested',
      detail: `Task ${task.id} created for ${customerName(d.customerId)}: ${d.title}.`,
    });
    move(task, 'NeedsValidation', 'validation.started', 'R-INTAKE-02', d.id, `${task.id} sent to validation.`);
    schedule({ at: now + data.constants.validationMin, id: `validate:${task.id}`, kind: 'validate', taskId: task.id });
  }

  // ---- validation and approval -------------------------------------------

  function onValidate(task: Task, causeId: string): void {
    if (task.state !== 'NeedsValidation') return;
    const d = data.inputs.find((i) => i.id === task.deliveryId) as RequestDelivery;
    if (!data.customers.some((c) => c.id === task.customerId) || !task.skill) {
      move(task, 'Canceled', 'task.canceled', 'R-VALID-01', causeId, `${task.id} fails validation: unknown customer or missing skill.`);
      return;
    }
    if (!task.requiresApproval) {
      route(task, causeId);
      return;
    }
    const primary = approver(data.policy.primaryApproverId)!;
    const review = d.reviewMin ?? 60;
    let start = now;
    const ooo = primary.outOfOffice;
    const away = !!ooo && now < ooo.to && now + review > ooo.from;
    if (away) start = ooo!.to;
    const ok = move(
      task, 'AwaitingApproval', 'approval.requested', 'R-APPR-01', causeId,
      `Approval requested from ${primary.name} (${primary.role}).` +
        (away ? ` ${primary.name} is out of office from ${fmtClock(ooo!.from)} until ${fmtClock(ooo!.to)}.` : ''),
    );
    if (!ok) return;
    task.approval = { requestedAt: now, requestedFrom: primary.id, decidedAt: null, decidedBy: null, decision: null };
    schedule({
      at: start + review, id: `decision:${primary.id}:${task.id}`, kind: 'decision', taskId: task.id,
      approverId: primary.id, decision: 'approved', reviewStart: start,
    });
    if (rules.escalation.mode !== 'none') {
      schedule({ at: now + rules.escalation.afterMin, id: `escalation-check:${task.id}`, kind: 'escalation-check', taskId: task.id });
    }
  }

  function onDecision(task: Task, approverId: string, decision: 'approved' | 'rejected', causeId: string): void {
    const who = approver(approverId);
    if (!who || !data.policy.authorizedRoles.includes(who.role)) {
      log({
        causeId, ruleId: 'R-APPR-02', action: 'approval.decision.rejected', outcome: 'rejected', taskId: task.id,
        detail: `${who ? `${who.name} (${who.role})` : approverId} is not an authorized approver. The decision is ignored and ${task.id} stays in ${STATE_LABEL[task.state]}.`,
      });
      return;
    }
    if (task.state !== 'AwaitingApproval' || !task.approval) {
      log({
        causeId, ruleId: 'R-APPR-03', action: 'approval.decision.redundant', outcome: 'noted', taskId: task.id,
        detail: `${who.name} finished a review of ${task.id}, but the request was already closed. The review was not needed.`,
      });
      return;
    }
    task.approval.decidedAt = now;
    task.approval.decidedBy = who.id;
    task.approval.decision = decision;
    log({
      causeId, ruleId: 'R-APPR-02', action: 'approval.decided', outcome: 'applied', taskId: task.id,
      detail: `${who.name} (${who.role}) ${decision} ${task.id} after ${now - task.approval.requestedAt} min. The decision is recorded. The state changes in the next step.`,
    });
    // Close the request for anyone who has not started reviewing it.
    for (let i = timers.length - 1; i >= 0; i--) {
      const t = timers[i];
      if (t.kind === 'decision' && t.taskId === task.id && (t.reviewStart ?? 0) >= now) {
        timers.splice(i, 1);
        log({
          causeId, ruleId: 'R-APPR-03', action: 'approval.request.withdrawn', outcome: 'noted', taskId: task.id,
          detail: `Request removed from ${approver(t.approverId!)?.name ?? t.approverId}'s queue before review started.`,
        });
      }
    }
    if (decision === 'approved') route(task, causeId);
    else move(task, 'Canceled', 'task.canceled', 'R-APPR-02', causeId, `${task.id} canceled after the request was rejected.`);
  }

  function onEscalationCheck(task: Task, causeId: string): void {
    const mode = rules.escalation.mode;
    if (task.state !== 'AwaitingApproval' || !task.approval) {
      log({
        causeId, ruleId: mode === 'backup' ? 'R-ESC-BACKUP' : mode === 'remind' ? 'R-ESC-REMIND' : 'R-ESC-AUTO',
        action: 'escalation.skipped', outcome: 'noted', taskId: task.id,
        detail: `Threshold of ${rules.escalation.afterMin} min reached, but ${task.id} was already decided. Nothing sent.`,
      });
      return;
    }
    const primary = approver(data.policy.primaryApproverId)!;
    const backup = approver(data.policy.backupApproverId)!;
    const waited = now - task.approval.requestedAt;
    if (mode === 'remind') {
      const away = !!primary.outOfOffice && now >= primary.outOfOffice.from && now < primary.outOfOffice.to;
      escalations.push({ at: now, taskId: task.id, type: 'reminder', to: primary.id });
      log({
        causeId, ruleId: 'R-ESC-REMIND', action: 'escalation.sent', outcome: 'applied', taskId: task.id,
        detail: `Waited ${waited} min. Reminder sent to ${primary.name}.` +
          (away ? ` ${primary.name} is out of office until ${fmtClock(primary.outOfOffice!.to)}, so nobody reads it.` : '') +
          ` ${task.id} stays in Awaiting approval.`,
      });
    } else if (mode === 'backup') {
      escalations.push({ at: now, taskId: task.id, type: 'backup', to: backup.id });
      log({
        causeId, ruleId: 'R-ESC-BACKUP', action: 'escalation.sent', outcome: 'applied', taskId: task.id,
        detail: `Waited ${waited} min. Request surfaced to ${backup.name} (${backup.role}), who is authorized to decide. ${task.id} stays in Awaiting approval until a person decides.`,
      });
      schedule({
        at: now + data.policy.backupReviewMin, id: `decision:${backup.id}:${task.id}`, kind: 'decision', taskId: task.id,
        approverId: backup.id, decision: 'approved', reviewStart: now,
      });
    } else if (mode === 'auto-approve') {
      escalations.push({ at: now, taskId: task.id, type: 'auto-approve-attempt', to: 'system' });
      move(task, 'Assigned', 'task.assigned', 'R-ESC-AUTO', causeId, `Waited ${waited} min. The timeout rule tried to release ${task.id} without a decision.`);
    }
  }

  // ---- assignment ---------------------------------------------------------

  function route(task: Task, causeId: string): void {
    const primaryId = data.routing[task.skill];
    const mode = rules.assignment.mode;
    const pool = data.teams.find((t) => t.isDefaultPool)!;
    if (primaryId) {
      const p = team(primaryId);
      if (backlog(primaryId) < p.capacity + rules.assignment.queueLimit) {
        assign(task, primaryId, 'R-ASSIGN-01', causeId, `${task.id} assigned to ${p.name}, the primary team for skill "${task.skill}" (${backlog(primaryId)} of ${p.capacity + rules.assignment.queueLimit} backlog places used).`, false);
        return;
      }
    }
    const why = primaryId
      ? `${team(primaryId).name} is at capacity (${inProgress(primaryId)} of ${team(primaryId).capacity} slots busy, queue limit ${rules.assignment.queueLimit})`
      : `no team has skill "${task.skill}"`;
    if (mode === 'default-pool') {
      const qualified = pool.skills.includes(task.skill);
      assign(task, pool.id, 'R-ASSIGN-DEFAULT', causeId,
        `${why[0].toUpperCase()}${why.slice(1)}. ${task.id} sent to ${pool.name}, the default pool.` +
          (qualified ? '' : ` ${pool.name} does not have skill "${task.skill}". Nobody is told.`), false);
      return;
    }
    if (mode === 'overflow' && primaryId) {
      const other = data.teams.find((t) => t.id !== primaryId && t.skills.includes(task.skill) && backlog(t.id) < t.capacity);
      if (other) {
        const factor = other.efficiency?.[task.skill] ?? 1;
        assign(task, other.id, 'R-ASSIGN-OVERFLOW', causeId,
          `${why[0].toUpperCase()}${why.slice(1)}. ${other.name} also has skill "${task.skill}" and a free slot, so ${task.id} overflows there` +
            (factor !== 1 ? ` (effort ×${factor}).` : '.'), false);
        return;
      }
    }
    const code = primaryId ? 'TEAM_AT_CAPACITY' : 'NO_QUALIFIED_OWNER';
    const ok = move(task, 'Blocked', 'exception.raised', 'R-ASSIGN-FLAG', causeId,
      `${why[0].toUpperCase()}${why.slice(1)}.` +
        (mode === 'overflow' && primaryId ? ' No other qualified team has a free slot.' : '') +
        ` ${task.id} is blocked with exception ${code}, shown on the exception queue and routed to the triage lead.`);
    if (!ok) return;
    task.exception = { code, occurredAt: now, raisedAt: now, routedTo: 'Triage lead', resolvedAt: null };
    schedule({ at: now + data.constants.triageLeadResponseMin, id: `triage-lead:${task.id}`, kind: 'triage-lead', taskId: task.id });
  }

  function assign(task: Task, teamId: string, ruleId: string, causeId: string, detail: string, priority: boolean): void {
    if (!move(task, 'Assigned', 'task.assigned', ruleId, causeId, detail, teamId)) return;
    task.ownerTeamId = teamId;
    if (task.assignedAt === null) task.assignedAt = now;
    if (!noticed.has(task.id)) {
      noticed.add(task.id);
      notices.push({ at: now, taskId: task.id, customerId: task.customerId, kind: 'kickoff' });
      log({
        causeId, ruleId: 'R-NOTIFY-01', action: 'notice.sent', outcome: 'applied', taskId: task.id,
        detail: `Kickoff notice sent to ${customerName(task.customerId)} for ${task.id}.`,
      });
    }
    const q = queues.get(teamId)!;
    if (priority) q.unshift(task.id);
    else q.push(task.id);
    dispatch(teamId, causeId);
  }

  function dispatch(teamId: string, causeId: string): void {
    const t = team(teamId);
    const q = queues.get(teamId)!;
    while (q.length > 0 && inProgress(teamId) < t.capacity) {
      const task = byId.get(q.shift()!)!;
      const slot = `slot ${inProgress(teamId) + 1} of ${t.capacity}`;
      if (!move(task, 'InProgress', 'work.started', 'R-WORK-01', causeId, `${t.name} starts ${task.id} (${slot}).`, teamId)) continue;
      if (task.startedAt === null) task.startedAt = now;
      if (t.skills.includes(task.skill)) {
        const duration = Math.ceil(task.effortMin * (t.efficiency?.[task.skill] ?? 1));
        schedule({ at: now + duration, id: `work-complete:${task.id}`, kind: 'work-complete', taskId: task.id, teamId, duration });
      } else {
        const duration = data.constants.misrouteDiscoveryMin;
        schedule({ at: now + duration, id: `misroute:${task.id}`, kind: 'misroute', taskId: task.id, teamId, duration });
      }
    }
  }

  function onWorkComplete(task: Task, tm: Timer): void {
    if (task.state !== 'InProgress') return;
    if (!move(task, 'Complete', 'work.completed', 'R-WORK-02', tm.id, `${team(tm.teamId!).name} completes ${task.id} after ${tm.duration} min of work.`, tm.teamId)) return;
    task.workedMin += tm.duration!;
    task.completedAt = now;
    dispatch(tm.teamId!, tm.id);
  }

  function onMisroute(task: Task, tm: Timer): void {
    if (task.state !== 'InProgress') return;
    const t = team(tm.teamId!);
    if (!move(task, 'Blocked', 'work.stopped', 'R-WORK-03', tm.id,
      `${t.name} stops ${task.id} after ${tm.duration} min: the team does not have skill "${task.skill}". The task is marked Blocked. No exception is raised, so nobody outside the team knows.`, tm.teamId)) return;
    task.workedMin += tm.duration!;
    task.misroutedMin += tm.duration!;
    task.ownerTeamId = null;
    task.exception = { code: 'WRONG_TEAM', occurredAt: now, raisedAt: null, routedTo: null, resolvedAt: null };
    dispatch(tm.teamId!, tm.id);
  }

  // ---- exception handling -------------------------------------------------

  function onTriageLead(task: Task, causeId: string): void {
    if (task.state !== 'Blocked' || !task.exception) return;
    const primaryId = data.routing[task.skill];
    if (!primaryId) {
      log({
        causeId, ruleId: 'R-TRIAGE-02', action: 'exception.acknowledged', outcome: 'noted', taskId: task.id,
        detail: `Triage lead confirms no team has skill "${task.skill}" and records a staffing gap for the implementation manager. ${task.id} stays Blocked and visible.`,
      });
      return;
    }
    task.exception.resolvedAt = now;
    assign(task, primaryId, 'R-TRIAGE-02', causeId,
      `Triage lead puts ${task.id} at the front of the ${team(primaryId).name} queue. It starts when a slot frees up.`, true);
  }

  function onDailyTriage(causeId: string): void {
    for (const task of tasks) {
      if (task.state !== 'Blocked' || !task.exception || task.exception.raisedAt !== null) continue;
      task.exception.raisedAt = now;
      task.exception.routedTo = 'Triage lead';
      const primaryId = data.routing[task.skill];
      if (!primaryId) task.exception.code = 'NO_QUALIFIED_OWNER';
      log({
        causeId, ruleId: 'R-TRIAGE-01', action: 'exception.raised', outcome: 'applied', taskId: task.id,
        detail: `Daily review finds ${task.id}, blocked and unreported since ${fmtClock(task.exception.occurredAt)} (${now - task.exception.occurredAt} min).` +
          (primaryId ? '' : ` No team has skill "${task.skill}". It stays Blocked, now visible, as a staffing gap.`),
      });
      if (primaryId) {
        task.exception.resolvedAt = now;
        assign(task, primaryId, 'R-TRIAGE-02', causeId, `Triage lead moves ${task.id} to the front of the ${team(primaryId).name} queue by hand.`, true);
      }
    }
  }

  // ---- main loop ----------------------------------------------------------

  [...data.inputs]
    .map((input, i) => ({ input, i }))
    .sort((a, b) => a.input.at - b.input.at || a.i - b.i)
    .forEach(({ input }) => schedule({ at: input.at, id: input.id, kind: 'input', input }));
  for (const at of data.constants.dailyTriageAt) schedule({ at, id: `daily-triage:${at}`, kind: 'daily-triage' });

  let steps = 0;
  let lastWorkAt = 0;
  while (timers.length > 0) {
    if (++steps > MAX_STEPS) throw new Error('Simulation exceeded its step limit.');
    let best = 0;
    for (let i = 1; i < timers.length; i++) {
      const a = timers[i];
      const b = timers[best];
      if (a.at < b.at || (a.at === b.at && a.seq < b.seq)) best = i;
    }
    const tm = timers.splice(best, 1)[0];
    now = tm.at;
    const before = trace.length;
    const task = tm.taskId ? byId.get(tm.taskId) : undefined;
    if (tm.kind === 'input') {
      const input = tm.input!;
      if (input.kind === 'request.delivered') onDelivery(input);
      else {
        const target = byId.get(input.taskId);
        if (target) onDecision(target, input.approverId, input.decision, input.id);
        else log({ causeId: input.id, ruleId: 'R-APPR-03', action: 'approval.decision.rejected', outcome: 'rejected', detail: `Decision refers to unknown task ${input.taskId}.` });
      }
    } else if (tm.kind === 'validate' && task) onValidate(task, tm.id);
    else if (tm.kind === 'decision' && task) onDecision(task, tm.approverId!, tm.decision!, tm.id);
    else if (tm.kind === 'escalation-check' && task) onEscalationCheck(task, tm.id);
    else if (tm.kind === 'triage-lead' && task) onTriageLead(task, tm.id);
    else if (tm.kind === 'daily-triage') onDailyTriage(tm.id);
    else if (tm.kind === 'work-complete' && task) onWorkComplete(task, tm);
    else if (tm.kind === 'misroute' && task) onMisroute(task, tm);
    if (trace.length > before) lastWorkAt = now;
  }

  return { scenarioId: data.id, seed: data.seed, rules, data, tasks, trace, notices, escalations, endAt: lastWorkAt };
}
