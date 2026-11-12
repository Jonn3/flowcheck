// FlowCheck interface: landing page, guided challenge, explore workspace.

import type { Run, RuleSet, TraceEntry, RequestDelivery } from '../engine/types.ts';
import { STATE_LABEL } from '../engine/machine.ts';
import { fmtClock, fmtDuration } from '../engine/clock.ts';
import { simulate } from '../engine/engine.ts';
import { RULES, BOUNDS, validateRules, hasErrors, cloneRules, sameRules, describeRuleChange, type RuleIssue } from '../engine/rules.ts';
import { computeMetrics, reconcile, fingerprint, firstDivergence, snapshotAt, METRIC_DEFS, type Metrics, type MetricDef } from '../engine/metrics.ts';
import { SCENARIOS, validSeed, COMPANY, type Scenario } from '../engine/scenarios.ts';
import { h, table, record, mono, stateChip, type Child } from './dom.ts';
import { renderMap } from './map.ts';
import { renderInside } from './inside.ts';

type View = 'home' | 'challenge' | 'explore' | 'inside';
type Filter = 'key' | 'all' | 'focal' | 'flagged';

const STEPS = ['See the failure', 'Inspect the evidence', 'Choose a fix', 'Compare the result'];
const QUIET_ACTIONS = ['validation.started', 'delivery.accepted', 'approval.request.withdrawn', 'escalation.skipped'];

const app = {
  view: 'home' as View,
  scenario: SCENARIOS[0] as Scenario,
  seed: SCENARIOS[0].defaultSeed,
  seedError: null as string | null,
  step: 0,
  optionId: null as string | null,
  draft: cloneRules(SCENARIOS[0].baselineRules) as RuleSet,
  issues: [] as RuleIssue[],
  runMessage: null as string | null,
  baseline: null as Run | null,
  revised: null as Run | null,
  showing: 'baseline' as 'baseline' | 'revised',
  cursor: 0,
  playing: false,
  filter: 'key' as Filter,
  error: null as string | null,
  announce: '',
};

let root: HTMLElement;
let timer: number | null = null;
const narrowQuery = window.matchMedia('(max-width: 700px)');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const replayHosts: { map?: HTMLElement; entry?: HTMLElement; tasks?: HTMLElement; capacity?: HTMLElement; timeline?: HTMLElement; slider?: HTMLInputElement; position?: HTMLElement; play?: HTMLButtonElement } = {};

// ---- state changes --------------------------------------------------------

function culpritIndex(run: Run): number {
  const c = app.scenario.culprit;
  const i = run.trace.findIndex((e) => e.action === c.action && e.taskId === c.taskId);
  return i >= 0 ? i : 0;
}

function loadScenario(scenario: Scenario, seed: number): void {
  stopPlay();
  app.scenario = scenario;
  app.seed = seed;
  app.seedError = null;
  app.step = 0;
  app.optionId = null;
  app.draft = cloneRules(scenario.baselineRules);
  app.issues = [];
  app.runMessage = null;
  app.revised = null;
  app.showing = 'baseline';
  app.filter = 'key';
  app.error = null;
  try {
    app.baseline = simulate(scenario.build(seed), cloneRules(scenario.baselineRules));
    app.cursor = culpritIndex(app.baseline);
  } catch (err) {
    app.baseline = null;
    app.error = `The simulation could not run: ${(err as Error).message} Use Reset to return to the default seed.`;
  }
}

function shownRun(): Run {
  return app.showing === 'revised' && app.revised ? app.revised : app.baseline!;
}

function runFix(): void {
  app.issues = validateRules(app.draft);
  if (hasErrors(app.issues)) {
    app.runMessage = 'The rule set has errors. Fix the highlighted fields, then run again.';
    render();
    const first = app.issues.find((i) => i.severity === 'error');
    if (first) document.getElementById(`rule-${first.path.replace('.', '-')}`)?.focus();
    return;
  }
  if (sameRules(app.draft, app.scenario.baselineRules)) {
    app.runMessage = 'That rule set is the baseline. Pick a response or change a rule first.';
    render();
    document.getElementById('run-message')?.focus();
    return;
  }
  stopPlay();
  try {
    app.revised = simulate(app.scenario.build(app.seed), cloneRules(app.draft));
  } catch (err) {
    app.error = `The simulation could not run: ${(err as Error).message} Use Reset to start again.`;
    render();
    return;
  }
  app.runMessage = null;
  app.showing = 'revised';
  const d = firstDivergence(app.baseline!, app.revised);
  app.cursor = d ? Math.min(d.index, app.revised.trace.length - 1) : 0;
  app.step = 3;
  app.announce = 'Fix applied. Comparison ready.';
  render();
  focusId('compare-title');
}

function resetScenario(): void {
  loadScenario(app.scenario, app.scenario.defaultSeed);
  app.announce = `Scenario ${app.scenario.letter} reset to its baseline and default seed.`;
  render();
  focusId('view-title');
}

function go(view: View, scenario?: Scenario): void {
  stopPlay();
  app.view = view;
  if (view === 'challenge' || view === 'explore') loadScenario(scenario ?? (view === 'challenge' ? SCENARIOS[0] : app.scenario), (scenario ?? (view === 'challenge' ? SCENARIOS[0] : app.scenario)).defaultSeed);
  const hash = view === 'home' ? '' : view;
  if (location.hash.replace('#', '') !== hash) {
    try { location.hash = hash; } catch { /* sandboxed frame: the view still changes */ }
  }
  render();
  window.scrollTo(0, 0);
  focusId('view-title');
}

function focusId(id: string): void {
  const el = document.getElementById(id);
  if (el) el.focus({ preventScroll: false });
}

// ---- replay ---------------------------------------------------------------

function stopPlay(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  app.playing = false;
}

function setCursor(i: number): void {
  const run = shownRun();
  app.cursor = Math.max(0, Math.min(run.trace.length - 1, i));
  updateReplay();
}

function togglePlay(): void {
  const run = shownRun();
  if (reduceMotion.matches) {
    setCursor(run.trace.length - 1);
    return;
  }
  if (app.playing) {
    stopPlay();
    updateReplay();
    return;
  }
  if (app.cursor >= run.trace.length - 1) app.cursor = 0;
  app.playing = true;
  timer = window.setInterval(() => {
    if (app.cursor >= shownRun().trace.length - 1) stopPlay();
    else app.cursor++;
    updateReplay();
  }, 550);
  updateReplay();
}

function focalDelivery(run: Run): RequestDelivery | undefined {
  return run.data.inputs.find((i): i is RequestDelivery => i.kind === 'request.delivered' && !!i.focal);
}

function focalTaskId(run: Run): string | null {
  const f = focalDelivery(run);
  return f ? 'T-' + f.id.replace('D-', '') : null;
}

function markerIndex(run: Run): { index: number; label: string } | null {
  if (run === app.baseline) return { index: culpritIndex(run), label: 'Failure starts here' };
  const d = firstDivergence(app.baseline!, run);
  return d ? { index: Math.min(d.index, run.trace.length - 1), label: 'First difference from baseline' } : null;
}

function outcomeChip(e: TraceEntry): HTMLElement | null {
  if (e.outcome === 'applied') return null;
  const text = { suppressed: '⦸ Suppressed', rejected: '✕ Rejected', noted: '· Note' }[e.outcome];
  return h('span', { class: `outcome oc-${e.outcome}` }, text);
}

function visibleEntries(run: Run): number[] {
  const focal = focalTaskId(run);
  const focalD = focalDelivery(run)?.id;
  const out: number[] = [];
  run.trace.forEach((e, i) => {
    const keep =
      app.filter === 'all' ? true
        : app.filter === 'focal' ? e.taskId === focal || e.causeId === focalD
          : app.filter === 'flagged' ? e.outcome === 'rejected' || e.outcome === 'suppressed' || e.action.startsWith('exception') || e.action.startsWith('escalation') || e.action === 'work.stopped'
            : !QUIET_ACTIONS.includes(e.action);
    if (keep || i === app.cursor) out.push(i);
  });
  return out;
}

function renderEntry(run: Run): HTMLElement {
  const e = run.trace[app.cursor];
  const rule = RULES[e.ruleId];
  return h('div', { class: `entry-card oc-${e.outcome}` },
    h('p', { class: 'entry-meta' }, mono(fmtClock(e.at)), ' · caused by ', mono(e.causeId), outcomeChip(e)),
    h('p', { class: 'entry-detail' }, e.detail),
    h('p', { class: 'entry-rule' }, h('strong', null, mono(rule.id), ' ', rule.name, ': '), rule.text),
    e.from && e.to
      ? h('p', { class: 'entry-move' }, stateChip(e.from), h('span', { class: 'move-arrow' }, e.outcome === 'rejected' ? ' ✕ not moved to ' : ' → '), stateChip(e.to))
      : null,
  );
}

function renderTasks(run: Run): HTMLElement {
  const snap = snapshotAt(run, app.cursor);
  const focal = focalTaskId(run);
  const rows: Child[][] = [];
  for (const t of run.tasks) {
    const now = snap.tasks.get(t.id);
    if (!now) continue;
    const team = now.teamId ? run.data.teams.find((x) => x.id === now.teamId)?.name ?? '' : '—';
    const end = t.completedAt !== null
      ? (t.completedAt <= t.dueAt ? `✓ Done ${fmtClock(t.completedAt)}, on target` : `✕ Done ${fmtClock(t.completedAt)}, ${fmtDuration(t.completedAt - t.dueAt)} late`)
      : t.state === 'Canceled' ? '⊘ Canceled' : `✕ Not completed (${STATE_LABEL[t.state]})`;
    rows.push([
      h('span', null, mono(t.id), t.id === focal ? h('span', { class: 'tag' }, 'focal') : null),
      h('span', null, t.title, h('span', { class: 'sub' }, run.data.customers.find((c) => c.id === t.customerId)?.name ?? t.customerId)),
      stateChip(now.state), team, mono(fmtClock(t.dueAt)), end,
    ]);
  }
  if (rows.length === 0) return h('p', { class: 'empty' }, 'No tasks exist yet at this point in the run.');
  return table(['Task', 'Request', 'State at this point', 'Team', 'Due', 'By end of run'], rows, { caption: 'Task queue' });
}

function renderCapacity(run: Run): HTMLElement {
  const snap = snapshotAt(run, app.cursor);
  const all = [...snap.tasks.values()];
  return h('ul', { class: 'capacity' }, run.data.teams.map((team) => {
    const busy = all.filter((t) => t.state === 'InProgress' && t.teamId === team.id).length;
    const queued = all.filter((t) => t.state === 'Assigned' && t.teamId === team.id).length;
    const slots = Array.from({ length: team.capacity }, (_, i) => h('span', { class: `slot${i < busy ? ' busy' : ''}` }));
    return h('li', { class: busy >= team.capacity ? 'full' : '' },
      h('div', { class: 'cap-head' }, h('strong', null, team.name), h('span', { class: 'slots', 'aria-hidden': 'true' }, slots)),
      h('div', { class: 'cap-text' }, `${busy} of ${team.capacity} slots busy`, busy >= team.capacity ? ' (full)' : '', queued ? ` · ${queued} queued` : ''),
      h('div', { class: 'cap-skills' }, 'Skills: ', team.skills.join(', ')),
    );
  }));
}

function renderTimeline(run: Run): HTMLElement {
  const marker = markerIndex(run);
  return h('ol', { class: 'timeline' }, visibleEntries(run).map((i) => {
    const e = run.trace[i];
    const isMarker = marker?.index === i;
    return h('li', { class: `${i === app.cursor ? 'current ' : ''}${isMarker ? 'marker ' : ''}oc-${e.outcome}` },
      h('button', { type: 'button', class: 'tl-btn', 'aria-current': i === app.cursor ? 'true' : null, 'data-index': i, onclick: () => { stopPlay(); setCursor(i); } },
        h('span', { class: 'tl-time mono' }, fmtClock(e.at)),
        h('span', { class: 'tl-body' },
          isMarker ? h('span', { class: `flag ${run === app.baseline ? 'flag-bad' : 'flag-diff'}` }, run === app.baseline ? '⚑ ' : '◆ ', marker!.label) : null,
          h('span', { class: 'tl-rule mono' }, e.ruleId), outcomeChip(e),
          h('span', { class: 'tl-detail' }, e.detail)),
      ));
  }));
}

function updateReplay(): void {
  if (!app.baseline || !replayHosts.map) return;
  const run = shownRun();
  if (app.cursor > run.trace.length - 1) app.cursor = run.trace.length - 1;
  replayHosts.map.replaceChildren(renderMap(snapshotAt(run, app.cursor), run.trace[app.cursor], focalTaskId(run), narrowQuery.matches));
  replayHosts.entry!.replaceChildren(renderEntry(run));
  replayHosts.tasks!.replaceChildren(renderTasks(run));
  replayHosts.capacity!.replaceChildren(renderCapacity(run));
  const hadFocus = replayHosts.timeline!.contains(document.activeElement);
  replayHosts.timeline!.replaceChildren(renderTimeline(run));
  const cur = replayHosts.timeline!.querySelector<HTMLElement>('[aria-current="true"]');
  if (cur) {
    const box = replayHosts.timeline!;
    const li = cur.parentElement as HTMLElement;
    if (li.offsetTop < box.scrollTop || li.offsetTop + li.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, li.offsetTop - 60);
    if (hadFocus) cur.focus({ preventScroll: true });
  }
  replayHosts.slider!.max = String(run.trace.length - 1);
  replayHosts.slider!.value = String(app.cursor);
  replayHosts.slider!.setAttribute('aria-valuetext', `Event ${app.cursor + 1} of ${run.trace.length}, ${fmtClock(run.trace[app.cursor].at)}`);
  replayHosts.position!.textContent = `Event ${app.cursor + 1} of ${run.trace.length} · ${fmtClock(run.trace[app.cursor].at)}`;
  replayHosts.play!.textContent = reduceMotion.matches ? 'Go to end' : app.playing ? '❚❚ Pause' : '► Play';
}

// ---- metrics and targets --------------------------------------------------

function fmtMetric(def: MetricDef, m: Metrics): string {
  const v = m[def.id];
  if (v === null) return def.id === 'approvalWaitMin' ? 'No decision' : def.id === 'approvalOnTarget' ? 'n/a' : 'Not completed';
  if (def.unit === 'min') return fmtDuration(v as number);
  if (def.unit === 'of-distinct') return `${v} of ${m.distinctRequests}`;
  if (def.unit === 'clock') return fmtClock(v as number);
  if (def.unit === 'yesno') return v ? 'Yes' : 'No';
  return String(v);
}

function metricDirection(def: MetricDef, a: Metrics, b: Metrics): 'better' | 'worse' | 'same' | 'changed' {
  const x = a[def.id];
  const y = b[def.id];
  if (x === y) return 'same';
  if (def.better === 'none') return 'changed';
  if (def.unit === 'yesno') return y ? 'better' : 'worse';
  // A missing value means "never happened", which is the worst case for a duration.
  const num = (v: unknown) => (v === null ? Infinity : Number(v));
  const lowerIsBetter = def.better === 'lower';
  return (num(y) < num(x)) === lowerIsBetter ? 'better' : 'worse';
}

function directionChip(d: 'better' | 'worse' | 'same' | 'changed'): HTMLElement {
  const text = { better: '▲ Better', worse: '▼ Worse', same: '= Same', changed: '◆ Changed' }[d];
  return h('span', { class: `dir dir-${d}` }, text);
}

interface TargetRow { name: string; actual: string; met: boolean }

function targetsFor(scenario: Scenario, run: Run, m: Metrics): TargetRow[] {
  const f = focalDelivery(run)!;
  const rows: TargetRow[] = [{
    name: `Complete “${f.title}” within ${fmtDuration(f.targetMin)} of delivery`,
    actual: m.focalCycleMin === null ? 'Not completed' : fmtDuration(m.focalCycleMin),
    met: m.focalOnTarget,
  }];
  if (scenario.id === 'duplicate') {
    rows.push({ name: 'One task and one kickoff notice per request', actual: `${m.duplicateTasks} duplicate tasks, ${m.duplicateNotices} duplicate notices`, met: m.duplicateTasks === 0 && m.duplicateNotices === 0 });
    rows.push({ name: 'No distinct request dropped', actual: `${m.lostRequests} dropped`, met: m.lostRequests === 0 });
  } else if (scenario.id === 'approval') {
    const t = run.tasks.find((x) => x.id === focalTaskId(run));
    const who = run.data.approvers.find((a) => a.id === t?.approval?.decidedBy);
    const released = !!t && t.assignedAt !== null;
    rows.push({ name: `Approval decision within ${fmtDuration(run.data.policy.decisionTargetMin)} of the request`, actual: m.approvalWaitMin === null ? 'No decision' : fmtDuration(m.approvalWaitMin), met: m.approvalOnTarget === true });
    rows.push({
      name: 'Work starts only after an authorized approver decides',
      actual: who ? `Approved by ${who.name} (${who.role})` : 'Not released',
      met: !released || (!!who && run.data.policy.authorizedRoles.includes(who.role)),
    });
  } else {
    rows.push({ name: 'Blocked work is visible to a person immediately', actual: `${fmtDuration(m.hiddenBlockedMin)} hidden`, met: m.hiddenBlockedMin === 0 });
    rows.push({ name: 'No team works on a task it lacks the skill for', actual: `${fmtDuration(m.wastedWorkMin)} wasted`, met: m.wastedWorkMin === 0 });
  }
  rows.push({ name: `All ${m.distinctRequests} distinct requests completed on target`, actual: `${m.onTarget} of ${m.distinctRequests}`, met: m.onTarget === m.distinctRequests });
  return rows;
}

function targetCell(r: TargetRow): HTMLElement {
  return h('span', { class: `target ${r.met ? 'met' : 'missed'}` }, h('strong', null, r.met ? '✓ Met' : '✕ Missed'), h('span', { class: 'sub' }, r.actual));
}

// ---- workspace sections ---------------------------------------------------

function sectionSituation(run: Run, m: Metrics): HTMLElement {
  const sc = app.scenario;
  const rows = targetsFor(sc, run, m);
  return h('section', { class: 'panel', 'aria-labelledby': 'sec-situation' },
    h('h2', { id: 'sec-situation' }, 'The situation'),
    h('p', { class: 'problem' }, sc.problem),
    h('p', { class: 'quote' }, sc.stakeholder),
    h('p', null, h('strong', null, 'Baseline rule: '), sc.baselineBehavior),
    table(['Service target', 'Baseline result'], rows.map((r) => [r.name, targetCell(r)]), { caption: 'Service targets' }),
  );
}

function sectionReplay(run: Run): HTMLElement {
  const marker = markerIndex(run);
  const mapHost = h('div', { class: 'map-host' });
  const entryHost = h('div', { 'aria-live': 'off' });
  const tasksHost = h('div', null);
  const capacityHost = h('div', null);
  const timelineHost = h('div', { class: 'timeline-box', tabindex: '0', role: 'group', 'aria-label': 'Event timeline' });
  const slider = h('input', {
    type: 'range', id: 'replay-slider', min: '0', max: String(run.trace.length - 1), step: '1', value: String(app.cursor), 'aria-label': 'Replay position',
    oninput: (ev: Event) => { stopPlay(); setCursor(Number((ev.target as HTMLInputElement).value)); },
  }) as HTMLInputElement;
  const position = h('span', { class: 'position mono' });
  const play = h('button', { type: 'button', class: 'btn', id: 'replay-play', onclick: togglePlay }) as HTMLButtonElement;
  Object.assign(replayHosts, { map: mapHost, entry: entryHost, tasks: tasksHost, capacity: capacityHost, timeline: timelineHost, slider, position, play });

  const toggle = app.revised
    ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Which run to replay' },
        (['baseline', 'revised'] as const).map((which) => h('button', {
          type: 'button', class: 'seg-btn', 'aria-pressed': String(app.showing === which),
          onclick: () => { stopPlay(); app.showing = which; app.cursor = (markerIndex(shownRun())?.index) ?? 0; render(); focusId('sec-replay'); },
        }, which === 'baseline' ? 'Baseline run' : 'Your fix')))
    : null;

  const filter = h('label', { class: 'filter' }, 'Show ',
    h('select', { id: 'trace-filter', onchange: (ev: Event) => { app.filter = (ev.target as HTMLSelectElement).value as Filter; updateReplay(); } },
      ([['key', 'Key events'], ['focal', 'Focal request only'], ['flagged', 'Exceptions and rejections'], ['all', 'Every trace entry']] as const)
        .map(([v, label]) => h('option', { value: v, selected: app.filter === v }, label))));

  return h('section', { class: 'panel', 'aria-labelledby': 'sec-replay' },
    h('div', { class: 'panel-head' },
      h('h2', { id: 'sec-replay', tabindex: '-1' }, app.showing === 'revised' && app.revised ? 'Replay: your fix' : 'Replay: baseline'),
      toggle),
    h('p', { class: 'hint' }, 'Each node is a workflow state. The number is how many tasks are in it at this point, with their task numbers below. Step through the events or pick one from the timeline.'),
    mapHost,
    h('div', { class: 'controls' },
      h('button', { type: 'button', class: 'btn', id: 'replay-back', 'aria-label': 'Previous event', onclick: () => { stopPlay(); setCursor(app.cursor - 1); } }, '‹ Back'),
      play,
      h('button', { type: 'button', class: 'btn', id: 'replay-next', 'aria-label': 'Next event', onclick: () => { stopPlay(); setCursor(app.cursor + 1); } }, 'Next ›'),
      slider,
      marker ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { stopPlay(); setCursor(marker.index); } }, run === app.baseline ? 'Go to the failure' : 'Go to the first difference') : null,
      position),
    entryHost,
    h('div', { class: 'two-col' },
      h('div', null, h('div', { class: 'sub-head' }, h('h3', null, 'Timeline'), filter), timelineHost),
      h('div', null, h('h3', null, 'Team capacity at this point'), capacityHost)),
    h('h3', null, 'Task queue at this point'),
    tasksHost,
  );
}

function sectionEvidence(run: Run): HTMLElement {
  const sc = app.scenario;
  const data = run.data;
  const deliveries = data.inputs.filter((i): i is RequestDelivery => i.kind === 'request.delivered');
  let body: Child;
  if (sc.id === 'duplicate') {
    const count = new Map<string, number>();
    deliveries.forEach((d) => count.set(d.idempotencyKey, (count.get(d.idempotencyKey) ?? 0) + 1));
    const kestrel = deliveries.filter((d) => d.customerId === 'kestrel');
    body = [
      table(['Delivery', 'Received', 'Idempotency key', 'Title', 'What it was'],
        kestrel.map((d) => [
          mono(d.id), mono(fmtClock(d.at)),
          h('span', { class: count.get(d.idempotencyKey)! > 1 ? 'key-repeat' : '' }, mono(d.idempotencyKey), count.get(d.idempotencyKey)! > 1 ? h('span', { class: 'tag tag-warn' }, `seen ${count.get(d.idempotencyKey)}×`) : null),
          d.title, d.note ?? '',
        ]), { caption: 'Deliveries received from Kestrel Freight', rowClass: (i) => (count.get(kestrel[i].idempotencyKey)! > 1 ? 'row-flag' : null) }),
      h('p', null, `Baseline created ${run.tasks.filter((t) => t.customerId === 'kestrel').length} tasks from these ${kestrel.length} deliveries and sent ${run.notices.filter((n) => n.customerId === 'kestrel').length} kickoff notices to Kestrel Freight.`),
    ];
  } else if (sc.id === 'approval') {
    const t = run.tasks.find((x) => x.id === focalTaskId(run))!;
    const name = (id: string | null | undefined) => { const a = data.approvers.find((x) => x.id === id); return a ? `${a.name} (${a.role})` : '—'; };
    body = h('div', { class: 'records' },
      record(`Approval request for ${t.id}`, [
        ['Request', t.title],
        ['Requested', mono(t.approval ? fmtClock(t.approval.requestedAt) : '—')],
        ['Sent to', name(t.approval?.requestedFrom)],
        ['Decision', t.approval?.decidedAt != null ? `${t.approval.decision} by ${name(t.approval.decidedBy)} at ${fmtClock(t.approval.decidedAt)}` : 'None recorded'],
        ['Decision target', fmtDuration(data.policy.decisionTargetMin)],
      ], 'The request and the decision are separate records. The request alone never releases work.'),
      record('Approver calendar', data.approvers.filter((a) => data.policy.authorizedRoles.includes(a.role)).map((a) => [
        `${a.name}, ${a.role}`, a.outOfOffice ? `Out of office ${fmtClock(a.outOfOffice.from)} to ${fmtClock(a.outOfOffice.to)}` : 'Available',
      ])),
      record('Approval policy', [
        ['Roles allowed to decide', data.policy.authorizedRoles.join(', ')],
        ['Primary approver', name(data.policy.primaryApproverId)],
        ['Backup approver', name(data.policy.backupApproverId)],
        ['Not allowed to decide', 'Implementation manager, the workflow system'],
      ]),
    );
  } else {
    const snap = snapshotAt(run, culpritIndex(app.baseline!));
    const all = [...snap.tasks.values()];
    const skills = [...new Set(deliveries.map((d) => d.skill))];
    body = [
      table(['Team', 'Skills', 'Capacity', `Busy at ${fmtClock(snap.at)}`], data.teams.map((team) => {
        const busy = all.filter((x) => x.state === 'InProgress' && x.teamId === team.id).length;
        return [team.name + (team.isDefaultPool ? ' (default pool)' : ''), team.skills.join(', '), team.capacity, busy >= team.capacity ? h('span', { class: 'tag tag-warn' }, `${busy} of ${team.capacity}, full`) : `${busy} of ${team.capacity}`];
      }), { caption: 'Teams when the request arrived' }),
      table(['Skill needed', 'Primary team', 'Other teams with the skill'], skills.map((sk) => {
        const primary = data.teams.find((x) => x.id === data.routing[sk]);
        const others = data.teams.filter((x) => x.skills.includes(sk) && x.id !== primary?.id).map((x) => x.name + (x.efficiency?.[sk] ? ` (effort ×${x.efficiency[sk]})` : ''));
        return [mono(sk), primary ? primary.name : h('span', { class: 'tag tag-warn' }, 'none'), others.join(', ') || '—'];
      }), { caption: 'Routing table' }),
    ];
  }
  return h('section', { class: 'panel', 'aria-labelledby': 'sec-evidence' },
    h('h2', { id: 'sec-evidence', tabindex: '-1' }, 'Evidence'),
    h('p', { class: 'hint' }, sc.evidenceHint),
    body,
  );
}

function issueText(path: string): HTMLElement | null {
  const list = app.issues.filter((i) => i.path === path);
  if (list.length === 0) return null;
  return h('span', { class: 'issues' }, list.map((i) => h('span', { class: `issue issue-${i.severity}` }, i.severity === 'error' ? '✕ ' : '! ', i.message)));
}

function ruleEditor(): HTMLElement {
  const patch = () => {
    app.optionId = 'custom';
    app.issues = validateRules(app.draft);
    app.runMessage = null;
    document.querySelectorAll<HTMLInputElement>('input[name="response"]').forEach((r) => { r.checked = false; });
    for (const b of [...BOUNDS.map((x) => x.path), 'dedupe.mode', 'escalation.mode', 'assignment.mode']) {
      const id = `rule-${b.replace('.', '-')}`;
      const host = document.getElementById(`${id}-issues`);
      const field = document.getElementById(id);
      if (host) host.replaceChildren(issueText(b) ?? '');
      if (field) field.setAttribute('aria-invalid', String(app.issues.some((i) => i.path === b && i.severity === 'error')));
    }
  };
  const select = (group: 'dedupe' | 'escalation' | 'assignment', label: string, options: [string, string][]) => {
    const id = `rule-${group}-mode`;
    return h('div', { class: 'field' },
      h('label', { for: id }, label),
      h('select', { id, onchange: (ev: Event) => { (app.draft[group] as { mode: string }).mode = (ev.target as HTMLSelectElement).value; patch(); } },
        options.map(([v, text]) => h('option', { value: v, selected: app.draft[group].mode === v }, text))),
      h('span', { id: `${id}-issues`, 'aria-live': 'polite' }, issueText(`${group}.mode`)));
  };
  const number = (path: string) => {
    const b = BOUNDS.find((x) => x.path === path)!;
    const [group, key] = path.split('.') as ['dedupe', 'windowMin'];
    const id = `rule-${path.replace('.', '-')}`;
    const value = (app.draft[group] as unknown as Record<string, number>)[key];
    return h('div', { class: 'field' },
      h('label', { for: id }, `${b.label} `, h('span', { class: 'sub' }, `${b.min} to ${b.max} ${b.unit}`)),
      h('input', {
        id, type: 'text', inputmode: 'numeric', autocomplete: 'off', value: Number.isNaN(value) ? '' : String(value), 'aria-describedby': `${id}-issues`,
        oninput: (ev: Event) => {
          const raw = (ev.target as HTMLInputElement).value.trim();
          (app.draft[group] as unknown as Record<string, number>)[key] = raw === '' ? NaN : Number(raw);
          patch();
        },
      }),
      h('span', { id: `${id}-issues`, 'aria-live': 'polite' }, issueText(path)));
  };
  return h('fieldset', { class: 'editor' },
    h('legend', null, 'Rule editor'),
    h('p', { class: 'hint' }, 'Change any rule inside its bounds, then run. Values outside the bounds are refused with a reason.'),
    h('div', { class: 'editor-grid' },
      h('div', { class: 'editor-group' }, h('h4', null, 'Duplicate check'),
        select('dedupe', 'Mode', [['none', 'None'], ['key', 'Idempotency key'], ['window', 'Customer and title window']]),
        number('dedupe.keyRetentionMin'), number('dedupe.windowMin')),
      h('div', { class: 'editor-group' }, h('h4', null, 'Approval escalation'),
        select('escalation', 'Mode', [['none', 'None'], ['remind', 'Remind primary approver'], ['backup', 'Escalate to backup approver'], ['auto-approve', 'Auto-approve on timeout']]),
        number('escalation.afterMin')),
      h('div', { class: 'editor-group' }, h('h4', null, 'Assignment when the primary team is full or missing'),
        select('assignment', 'Mode', [['default-pool', 'Send to default pool'], ['flag-and-queue', 'Flag and queue'], ['overflow', 'Overflow to qualified team']]),
        number('assignment.queueLimit'))),
  );
}

function sectionResponse(): HTMLElement {
  const sc = app.scenario;
  return h('section', { class: 'panel', 'aria-labelledby': 'sec-response' },
    h('h2', { id: 'sec-response', tabindex: '-1' }, 'Choose a response'),
    h('p', { class: 'hint' }, 'Each response changes one rule. The fix runs on exactly the same inputs as the baseline, so any difference comes from the rule.'),
    h('fieldset', { class: 'options' },
      h('legend', { class: 'visually-hidden' }, 'Responses'),
      sc.responses.map((o) => h('label', { class: 'option' },
        h('input', { type: 'radio', name: 'response', id: `opt-${o.id}`, value: o.id, checked: app.optionId === o.id,
          onchange: () => { app.optionId = o.id; app.draft = o.apply(sc.baselineRules); app.issues = validateRules(app.draft); app.runMessage = null; render(); focusId(`opt-${o.id}`); } }),
        h('span', { class: 'option-body' },
          h('strong', null, o.label),
          h('span', null, o.summary),
          h('span', { class: 'tradeoff' }, h('em', null, 'Tradeoff: '), o.tradeoff))))),
    app.view === 'explore' ? ruleEditor() : null,
    app.issues.filter((i) => i.severity === 'warning').length && app.view !== 'explore'
      ? h('p', { class: 'issue issue-warning' }, '! ', app.issues.find((i) => i.severity === 'warning')!.message) : null,
    h('div', { class: 'run-row' },
      h('button', { type: 'button', class: 'btn btn-primary', id: 'run-fix', onclick: runFix }, 'Run this fix on the same inputs'),
      h('span', { id: 'run-message', tabindex: '-1', role: 'alert', class: app.runMessage ? 'issue issue-error' : '' }, app.runMessage ?? '')),
  );
}

function sectionCompare(): HTMLElement | null {
  const base = app.baseline;
  const rev = app.revised;
  if (!base || !rev) return null;
  const sc = app.scenario;
  const mb = computeMetrics(base);
  const mr = computeMetrics(rev);
  const tb = targetsFor(sc, base, mb);
  const tr = targetsFor(sc, rev, mr);
  const option = sc.responses.find((o) => o.id === app.optionId);
  const defs = METRIC_DEFS.filter((d) => sc.metricIds.includes(d.id));
  const row = (d: MetricDef): Child[] => [
    h('span', null, d.label, h('span', { class: 'sub' }, d.definition)),
    fmtMetric(d, mb), fmtMetric(d, mr), directionChip(metricDirection(d, mb, mr)),
  ];
  const judged = METRIC_DEFS.filter((d) => d.better !== 'none');
  const better = judged.filter((d) => metricDirection(d, mb, mr) === 'better');
  const worse = judged.filter((d) => metricDirection(d, mb, mr) === 'worse');
  const listOf = (ds: MetricDef[]) => ds.length
    ? h('ul', null, ds.map((d) => h('li', null, `${d.label}: ${fmtMetric(d, mb)} → ${fmtMetric(d, mr)}`)))
    : h('p', { class: 'empty' }, 'Nothing.');
  const div = firstDivergence(base, rev);
  const checks = [...reconcile(base), ...reconcile(rev)];
  const okCount = checks.filter((c) => c.ok).length;
  const entryBox = (title: string, e: TraceEntry | null) => h('div', { class: 'diff-box' },
    h('h4', null, title),
    e ? [h('p', { class: 'entry-meta' }, mono(fmtClock(e.at)), ' · ', mono(e.ruleId), ' ', RULES[e.ruleId].name, outcomeChip(e)), h('p', null, e.detail)] : h('p', null, 'The run had already ended.'));
  const next = SCENARIOS[(SCENARIOS.indexOf(sc) + 1) % SCENARIOS.length];
  const change = describeRuleChange(sc.baselineRules, rev.rules);

  return h('section', { class: 'panel panel-compare', 'aria-labelledby': 'compare-title' },
    h('div', { class: 'panel-head' },
      h('h2', { id: 'compare-title', tabindex: '-1' }, 'Baseline and your fix, same inputs'),
      h('span', { class: 'tag tag-sim' }, 'Simulated outcome')),
    h('p', { class: 'verdict' }, `Service targets met: ${tb.filter((r) => r.met).length} of ${tb.length} in the baseline, ${tr.filter((r) => r.met).length} of ${tr.length} with your fix.`),
    h('p', null, h('strong', null, 'Rule changed: '), change.join('; ') || 'none', '.'),
    table(['Service target', 'Baseline', 'Your fix'], tb.map((r, i) => [r.name, targetCell(r), targetCell(tr[i])]), { caption: 'Service targets' }),
    table(['Metric', 'Baseline', 'Your fix', 'Change'], defs.map(row), { caption: 'Metrics for this scenario' }),
    h('div', { class: 'two-col' },
      h('div', { class: 'gain' }, h('h3', null, 'What got better'), listOf(better)),
      h('div', { class: 'cost' }, h('h3', null, 'What got worse'), listOf(worse),
        option ? h('p', { class: 'tradeoff' }, h('em', null, 'Tradeoff to defend: '), option.tradeoff) : null)),
    h('h3', null, 'Why the result changed'),
    div
      ? [h('p', { class: 'hint' }, 'Up to this point both runs made the same decisions. This is the first entry where they differ.'),
         h('div', { class: 'two-col' }, entryBox('Baseline', div.base), entryBox('Your fix', div.revised))]
      : h('p', null, 'The two traces are identical. This rule change had no effect on these inputs.'),
    h('details', null,
      h('summary', null, `All ${METRIC_DEFS.length} metrics with definitions`),
      table(['Metric', 'Baseline', 'Your fix', 'Change'], METRIC_DEFS.map(row), { caption: 'All metrics' })),
    h('details', null,
      h('summary', null, h('span', { class: okCount === checks.length ? 'ok-text' : 'bad-text' }, okCount === checks.length ? '✓ ' : '✕ '), `${okCount} of ${checks.length} reconciliation checks pass`),
      h('p', { class: 'hint' }, 'Each check counts something from the trace and compares it with the task records.'),
      table(['Run', 'Check', 'From trace', 'From records', 'Result'], checks.map((c, i) => [i < checks.length / 2 ? 'Baseline' : 'Your fix', c.name, mono(c.fromTrace), mono(c.fromRecords), c.ok ? '✓ Match' : '✕ Mismatch']), { caption: 'Reconciliation' })),
    h('p', { class: 'small' }, `Seed ${app.seed}. Baseline run `, mono(fingerprint(base)), ', revised run ', mono(fingerprint(rev)), '. Reset and run the same fix again and both fingerprints will match.'),
    h('div', { class: 'run-row' },
      h('button', { type: 'button', class: 'btn', id: 'reset-bottom', onclick: resetScenario }, '↺ Reset and replay'),
      app.view === 'challenge'
        ? h('button', { type: 'button', class: 'btn', onclick: () => { app.step = 2; app.showing = 'baseline'; render(); focusId('sec-response'); } }, 'Try a different response')
        : null,
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => go(app.view, next) }, `Next: ${next.letter}. ${next.title}`),
      app.view === 'challenge' ? h('button', { type: 'button', class: 'btn', onclick: () => go('explore', sc) }, 'Open the rule editor') : null),
  );
}

function coach(): HTMLElement {
  const text = [
    'Read what went wrong, then press “Go to the failure” to see the event that started it.',
    'These are the records behind the failure. Find what the baseline rule missed.',
    'Pick one response. Read its tradeoff before you run it.',
    'Check what improved, what it cost, and the trace entry where the runs split.',
  ][app.step];
  const set = (n: number) => { app.step = n; if (n < 3) app.showing = 'baseline'; render(); focusId('coach-title'); window.scrollTo(0, 0); };
  return h('div', { class: 'coach' },
    h('ol', { class: 'steps', 'aria-label': 'Challenge steps' }, STEPS.map((label, i) => h('li', { class: i === app.step ? 'on' : i < app.step ? 'done' : '', 'aria-current': i === app.step ? 'step' : null }, h('span', { class: 'step-n' }, i < app.step ? '✓' : String(i + 1)), label))),
    h('div', { class: 'coach-row' },
      h('p', { id: 'coach-title', tabindex: '-1' }, h('strong', null, `Step ${app.step + 1} of 4. `), text),
      h('div', { class: 'coach-btns' },
        app.step > 0 ? h('button', { type: 'button', class: 'btn', onclick: () => set(app.step - 1) }, '‹ Back') : null,
        app.step < 2 ? h('button', { type: 'button', class: 'btn btn-primary', id: 'coach-next', onclick: () => set(app.step + 1) }, 'Next ›') : null)),
  );
}

function workspace(): HTMLElement {
  const sc = app.scenario;
  const guided = app.view === 'challenge';
  const head = h('header', { class: 'page-head' },
    h('p', { class: 'eyebrow' }, guided ? 'The 60-second challenge' : 'Explore the system'),
    h('h1', { id: 'view-title', tabindex: '-1' }, `${sc.letter}. ${sc.title}`),
    h('div', { class: 'scenario-bar' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Scenario' }, SCENARIOS.map((x) => h('button', {
        type: 'button', class: 'seg-btn', 'aria-pressed': String(x.id === sc.id), onclick: () => go(app.view, x),
      }, `${x.letter}. ${x.title}`))),
      !guided ? h('form', { class: 'seed', onsubmit: (ev: Event) => {
        ev.preventDefault();
        const raw = (document.getElementById('seed-input') as HTMLInputElement).value.trim();
        const n = Number(raw);
        if (raw === '' || !validSeed(n)) { app.seedError = 'Seed must be a whole number from 1 to 999999.'; render(); focusId('seed-input'); return; }
        loadScenario(sc, n);
        app.announce = `Seed ${n} loaded.`;
        render();
        focusId('sec-replay');
      } },
        h('label', { for: 'seed-input' }, 'Seed'),
        h('input', { id: 'seed-input', type: 'text', inputmode: 'numeric', autocomplete: 'off', value: String(app.seed), 'aria-describedby': 'seed-error', 'aria-invalid': String(!!app.seedError) }),
        h('button', { type: 'submit', class: 'btn' }, 'Load seed'),
        h('span', { id: 'seed-error', role: 'alert', class: app.seedError ? 'issue issue-error' : '' }, app.seedError ?? '')) : null,
      h('button', { type: 'button', class: 'btn', id: 'reset-top', onclick: resetScenario }, '↺ Reset')));

  if (app.error || !app.baseline) {
    return h('div', { class: 'workspace' }, head, h('div', { class: 'panel error', role: 'alert' }, h('h2', null, 'Something went wrong'), h('p', null, app.error ?? 'No run is loaded.')));
  }
  const run = shownRun();
  const mb = computeMetrics(app.baseline);
  const show = (n: number[]) => !guided || n.includes(app.step);
  return h('div', { class: 'workspace' },
    head,
    guided ? coach() : null,
    show([0]) ? sectionSituation(app.baseline, mb) : null,
    show([3]) ? sectionCompare() : null,
    show([0, 3]) ? sectionReplay(run) : null,
    show([1]) ? sectionEvidence(app.baseline) : null,
    show([2]) ? sectionResponse() : null,
    !guided ? sectionCompare() : null,
  );
}

// ---- home -----------------------------------------------------------------

function home(): HTMLElement {
  const sc = SCENARIOS[0];
  const run = simulate(sc.build(sc.defaultSeed), cloneRules(sc.baselineRules));
  const i = run.trace.findIndex((e) => e.action === sc.culprit.action && e.taskId === sc.culprit.taskId);
  const e = run.trace[i];
  return h('div', { class: 'home' },
    h('section', { class: 'hero' },
      h('p', { class: 'eyebrow' }, 'Interactive workflow simulation'),
      h('h1', { id: 'view-title', tabindex: '-1' }, 'Can you rescue this customer implementation?'),
      h('p', { class: 'lede' }, 'Investigate the failure. Change the workflow. See what your decision changes.'),
      h('div', { class: 'hero-btns' },
        h('button', { type: 'button', class: 'btn btn-primary btn-lg', id: 'start-challenge', onclick: () => go('challenge') }, 'Try the 60-second challenge'),
        h('button', { type: 'button', class: 'btn btn-lg', id: 'start-explore', onclick: () => go('explore', SCENARIOS[0]) }, 'Explore the system')),
      h('p', { class: 'small' }, `No login. Nothing is sent or saved. ${COMPANY} and its customers are fictional, and every result is a simulated outcome.`)),
    h('section', { class: 'panel preview', 'aria-labelledby': 'preview-title' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'preview-title' }, 'Where the first failure starts'), h('span', { class: 'tag tag-sim' }, 'Live from the simulation')),
      h('div', { class: 'map-host' }, renderMap(snapshotAt(run, i), e, 'T-105', narrowQuery.matches)),
      h('p', { class: 'entry-meta' }, mono(fmtClock(e.at)), ' · ', mono(e.ruleId), ' ', RULES[e.ruleId].name),
      h('p', null, `${e.detail} The request it belongs to already had a task. Nothing checked.`)),
    h('section', { 'aria-labelledby': 'scn-title' },
      h('h2', { id: 'scn-title' }, 'Three failures in one onboarding'),
      h('div', { class: 'cards' }, SCENARIOS.map((x) => h('article', { class: 'card' },
        h('p', { class: 'eyebrow' }, `Scenario ${x.letter}`),
        h('h3', null, x.title),
        h('p', null, x.problem),
        h('button', { type: 'button', class: 'btn', onclick: () => go('explore', x) }, `Open scenario ${x.letter}`))))),
    h('section', { class: 'about-strip' },
      h('p', null, 'Every state change in FlowCheck is checked against a documented transition table and written to a trace with the rule that caused it. Every number is calculated from that trace.'),
      h('button', { type: 'button', class: 'btn', onclick: () => go('inside') }, 'See inside the project')),
  );
}

// ---- shell ----------------------------------------------------------------

function render(): void {
  const nav = (view: View, label: string) => h('button', { type: 'button', class: 'nav-btn', 'aria-current': app.view === view ? 'page' : null, onclick: () => go(view, view === 'explore' ? app.scenario : undefined) }, label);
  let main: HTMLElement;
  try {
    main = app.view === 'home' ? home() : app.view === 'inside' ? renderInside() : workspace();
  } catch (err) {
    main = h('div', { class: 'panel error', role: 'alert' }, h('h1', { id: 'view-title', tabindex: '-1' }, 'Something went wrong'), h('p', null, `The page hit an error: ${(err as Error).message} Reload the page to start again.`));
  }
  root.replaceChildren(
    h('a', { class: 'skip', href: '#main' }, 'Skip to content'),
    h('header', { class: 'top' },
      h('button', { type: 'button', class: 'brand', onclick: () => go('home'), 'aria-label': 'FlowCheck home' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, '◆'), 'FlowCheck'),
      h('nav', { 'aria-label': 'Main' }, nav('challenge', 'Challenge'), nav('explore', 'Explore'), nav('inside', 'Inside the project'))),
    h('main', { id: 'main' }, main),
    h('footer', { class: 'foot' },
      h('p', null, 'FlowCheck is a portfolio project by Jon Johnson. Synthetic data, simulated outcomes. It runs entirely in your browser and sends or stores nothing.')),
    h('div', { class: 'visually-hidden', 'aria-live': 'polite', id: 'announcer' }, app.announce),
  );
  app.announce = '';
  if (app.view === 'challenge' || app.view === 'explore') updateReplay();
}

function viewFromHash(): View {
  const v = location.hash.replace('#', '');
  return v === 'challenge' || v === 'explore' || v === 'inside' ? v : 'home';
}

export function start(): void {
  root = document.getElementById('app')!;
  app.view = viewFromHash();
  if (app.view === 'challenge' || app.view === 'explore') loadScenario(SCENARIOS[0], SCENARIOS[0].defaultSeed);
  render();
  window.addEventListener('hashchange', () => {
    const v = viewFromHash();
    if (v !== app.view) go(v);
  });
  narrowQuery.addEventListener('change', () => render());
}

start();
