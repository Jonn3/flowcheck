// "Inside the project": how FlowCheck is built, how it is tested and what it
// does not do. Tables on this page are generated from the engine's own
// constants where possible.

import { STATES, TRANSITIONS, TRANSITION_REASON } from '../engine/machine.ts';
import { RULES, BOUNDS } from '../engine/rules.ts';
import { METRIC_DEFS } from '../engine/metrics.ts';
import { COMPANY } from '../engine/scenarios.ts';
import { h, s, table, mono, stateChip } from './dom.ts';

declare const FLOWCHECK_VERIFICATION: { ranAt: string; node: string; tests: number; pass: number; fail: number } | null;

const REQUIREMENTS: [string, string, string, string][] = [
  ['FR-1', 'A repeated delivery of the same request must not create a second task or a second customer notice.', 'With the idempotency key rule, every run has one task and one notice per key, for 150 seeds.', 'A idempotency key holds for every seed'],
  ['FR-2', 'Work that requires approval starts only after an authorized person approves it.', 'For 60 seeds × 4 escalation modes × 5 thresholds, no approval-required task reaches Assigned before an approved decision from an authorized role.', 'B no rule, threshold or seed lets approval-required work start…'],
  ['FR-3', 'Escalation surfaces overdue approvals. It never decides them.', 'Escalation trace entries carry no state change, and the task is still in Awaiting approval afterwards. An auto-approve attempt is rejected by guard G-APPROVAL.', 'B the escalation itself never changes state; B auto-approve is rejected…'],
  ['FR-4', 'A task that cannot be assigned is made visible and routed by an explicit rule.', 'Under flag and queue, blocked time nobody could see is 0 and no team starts a task it lacks the skill for, for 150 seeds.', 'C flag and queue: every block is raised in the same step…'],
  ['FR-5', 'Only documented state transitions can happen.', 'Transitions outside the table are rejected with a reason. Every applied transition in every trace is in the table.', 'transitions outside the table are rejected…; every trace entry names a known rule…'],
  ['FR-6', 'A scenario can be replayed exactly.', 'The same seed and rules produce an identical trace and task list.', 'replaying a seed gives the same run, entry for entry'],
  ['FR-7', 'Every number on screen can be traced to events.', 'Metrics are computed from the trace, then reconciled against task records for every scenario, option and 50 seeds.', 'metrics reconcile with the event records…'],
  ['FR-8', 'Reset returns the scenario to its starting point.', 'A run does not change its inputs or rules, and a baseline run after a revised run matches the first baseline.', 'reset: a run leaves no state behind…'],
  ['NFR-1', 'The public demo sends nothing anywhere and collects nothing.', 'The page ships a content security policy of default-src none. The browser check records zero network requests after load and no storage writes.', 'tests/browser/smoke.cjs'],
  ['NFR-2', 'The main flow works with a keyboard and respects reduced motion.', 'The browser check completes the challenge with keyboard input only, and confirms no page-level horizontal scroll at 375 px.', 'tests/browser/smoke.cjs'],
];

const DATA_MODEL: [string, string][] = [
  ['Customer', 'id, name, segment'],
  ['Team', 'id, name, skills[], capacity, efficiency per skill, isDefaultPool'],
  ['Approver', 'id, name, role, outOfOffice {from, to}'],
  ['ApprovalPolicy', 'authorizedRoles[], primaryApproverId, backupApproverId, decisionTargetMin, backupReviewMin'],
  ['RequestDelivery (input event)', 'id, at, idempotencyKey, customerId, title, skill, effortMin, requiresApproval, targetMin, reviewMin, truth'],
  ['Task', 'id, deliveryId, idempotencyKey, state, ownerTeamId, createdAt, dueAt, assignedAt, startedAt, completedAt, workedMin, misroutedMin, approval, exception'],
  ['ApprovalRecord', 'requestedAt, requestedFrom, decidedAt, decidedBy, decision'],
  ['ExceptionRecord', 'code, occurredAt, raisedAt, routedTo, resolvedAt'],
  ['RuleSet', 'dedupe {mode, windowMin, keyRetentionMin}, escalation {mode, afterMin}, assignment {mode, queueLimit}'],
  ['TraceEntry', 'seq, at, causeId, ruleId, action, outcome, taskId, teamId, from, to, detail'],
];

function architecture(): SVGElement {
  const box = (x: number, y: number, w: number, title: string, sub: string, cls = '') =>
    s('g', { class: `arch-box ${cls}` },
      s('rect', { x, y, width: w, height: 62, rx: 8 }),
      s('text', { x: x + 12, y: y + 25, class: 'arch-title' }, title),
      s('text', { x: x + 12, y: y + 45, class: 'arch-sub' }, sub));
  const arrow = (x1: number, y1: number, x2: number, y2: number) =>
    s('line', { x1, y1, x2, y2, class: 'edge', 'marker-end': 'url(#arch-arrow)' });
  return s('svg', { viewBox: '0 0 880 300', class: 'arch', role: 'img', 'aria-label': 'Architecture: a seed and a rule set go into the scenario builder and rule validation, then the engine, which checks every state change with the state machine and writes a trace. Metrics, reconciliation and the interface all read the trace.' },
    s('defs', null, s('marker', { id: 'arch-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' }, s('path', { d: 'M0 0 L10 5 L0 10 z', class: 'arrow-head' }))),
    box(10, 20, 230, 'Scenario builder', 'seed → typed input events'),
    box(10, 120, 230, 'Rule editor + validation', 'bounded rule set'),
    box(320, 70, 240, 'Engine', 'event queue + simulated clock', 'arch-core'),
    box(320, 200, 240, 'State machine', 'transition table + guard G-APPROVAL'),
    box(640, 20, 230, 'Trace', 'cause → rule → state'),
    box(640, 120, 230, 'Metrics + reconciliation', 'computed from the trace'),
    box(640, 220, 230, 'Interface', 'map, timeline, comparison'),
    arrow(240, 51, 318, 88), arrow(240, 151, 318, 114), arrow(440, 132, 440, 198),
    arrow(560, 90, 638, 55), arrow(755, 82, 755, 118), arrow(755, 182, 755, 218),
  );
}

export function renderInside(): HTMLElement {
  const v = typeof FLOWCHECK_VERIFICATION === 'undefined' ? null : FLOWCHECK_VERIFICATION;
  const edges = STATES.flatMap((from) => TRANSITIONS[from].map((to) => [from, to] as const));

  return h('div', { class: 'inside' },
    h('header', { class: 'page-head' },
      h('p', { class: 'eyebrow' }, 'Inside the project'),
      h('h1', { id: 'view-title', tabindex: '-1' }, 'How FlowCheck works, and what it does not do'),
      h('p', { class: 'lede' }, `FlowCheck is a portfolio project by Jon Johnson. It simulates a failing customer onboarding process at ${COMPANY}, a fictional B2B software company, and lets you test a fix against the same inputs.`),
    ),

    h('section', { 'aria-labelledby': 'in-problem' },
      h('h2', { id: 'in-problem' }, 'The stakeholder problem'),
      h('p', null, `${COMPANY}’s implementation manager has one customer, Kestrel Freight, close to go-live and three complaints from its project lead: duplicate kickoff notices, a data import nobody is approving, and work that was “started” and then went quiet. The manager wants to know what happened in each case, what rule would have prevented it, and what that rule costs.`),
      h('p', null, 'The company, customers, people and requests are invented. No real organization is described and none has endorsed this project.'),
    ),

    h('section', { 'aria-labelledby': 'in-req' },
      h('h2', { id: 'in-req' }, 'Requirements and acceptance criteria'),
      table(['ID', 'Requirement', 'Acceptance criterion', 'Checked by'], REQUIREMENTS.map(([id, req, ac, by]) => [mono(id), req, ac, h('span', { class: 'small' }, by)]), { caption: 'Requirements' }),
    ),

    h('section', { 'aria-labelledby': 'in-arch' },
      h('h2', { id: 'in-arch' }, 'Architecture'),
      h('div', { class: 'diagram-wrap' }, architecture()),
      h('p', null, 'Everything runs in the browser as one HTML file. There is no server, database, login or analytics. The engine is a pure function: the same seed and rules always return the same run. It does not read the system clock and it draws no random numbers. The scenario builder draws them from the seed before the simulation starts.'),
    ),

    h('section', { 'aria-labelledby': 'in-states' },
      h('h2', { id: 'in-states' }, 'States and allowed transitions'),
      h('p', null, `${STATES.length} states and ${edges.length} allowed transitions. The table is generated from the same constant the engine checks. Anything not listed is rejected and logged.`),
      table(['From', 'To', 'When'], edges.map(([from, to]) => [stateChip(from), stateChip(to), TRANSITION_REASON[`${from}>${to}`]]), { caption: 'Allowed transitions' }),
      h('p', null, h('strong', null, 'Guard G-APPROVAL. '), 'A request for approval and an approval decision are separate records. A task that requires approval can enter Assigned, In progress or Complete only when an approved decision from an authorized role is on record. Leaving Awaiting approval for Blocked needs the same decision, so Blocked cannot be used to get around approval.'),
    ),

    h('section', { 'aria-labelledby': 'in-data' },
      h('h2', { id: 'in-data' }, 'Data model'),
      table(['Record', 'Fields'], DATA_MODEL.map(([n, f]) => [n, mono(f)]), { caption: 'Typed records' }),
      h('details', null,
        h('summary', null, `Rule catalog (${Object.keys(RULES).length} rules that can appear in a trace)`),
        table(['Rule', 'Name', 'What it does'], Object.values(RULES).map((r) => [mono(r.id), r.name, r.text]), { caption: 'Rules' }),
      ),
      h('details', null,
        h('summary', null, 'Rule editor bounds'),
        table(['Setting', 'Minimum', 'Maximum', 'Unit'], BOUNDS.map((b) => [b.label, b.min, b.max, b.unit]), { caption: 'Bounds' }),
      ),
      h('details', null,
        h('summary', null, `Metric definitions (${METRIC_DEFS.length})`),
        table(['Metric', 'Unit', 'Definition'], METRIC_DEFS.map((m) => [m.label, m.unit === 'min' ? 'working minutes' : m.unit === 'of-distinct' ? 'count of distinct requests' : m.unit === 'clock' ? 'simulated time' : m.unit === 'yesno' ? 'yes / no' : 'count', m.definition]), { caption: 'Metrics' }),
      ),
      h('p', null, 'Assumptions: time is counted in working minutes, 8 hours to a day, with no nights or weekends. A team works on up to its capacity of tasks at once and never pauses one. Each synthetic delivery carries a ground-truth label (original, retry or distinct) that only the metrics read. The rules never see it.'),
    ),

    h('section', { 'aria-labelledby': 'in-trade' },
      h('h2', { id: 'in-trade' }, 'One design tradeoff'),
      h('p', null, h('strong', null, 'A browser-only simulation instead of a client and a server. '), 'A backend would have made the project look more like production software. It would also have added hosting, a database and an API that a visitor cannot inspect, without changing a single result, because every scenario is a calculation on synthetic inputs. Keeping it in one file means anyone can open it, read the trace and rerun it offline. The cost is real: nothing here shows authentication, persistence, concurrency between users or a real integration, and the idempotency key store lives in memory for one run.'),
    ),

    h('section', { 'aria-labelledby': 'in-tests' },
      h('h2', { id: 'in-tests' }, 'Tests'),
      h('p', null, 'Run them with Node 22.18 or newer. No install step is needed for the engine tests.'),
      h('pre', { tabindex: '0' }, 'npm test          # engine and rule tests\nnpm run verify    # tests, then build with the result embedded\nnpm run test:browser   # optional, needs Playwright'),
      v
        ? h('p', { class: v.fail === 0 ? 'verified' : 'verified bad' },
            h('span', { 'aria-hidden': 'true' }, v.fail === 0 ? '✓ ' : '✕ '),
            `Last recorded run before this build: ${v.pass} of ${v.tests} tests passed, ${v.fail} failed (${v.ranAt}, Node ${v.node}).`)
        : h('p', { class: 'verified bad' }, 'This build was made without running the tests, so no result is recorded here.'),
      h('p', { class: 'small' }, 'That line is written by the build script from the actual test run. It is not typed by hand.'),
    ),

    h('section', { 'aria-labelledby': 'in-limits' },
      h('h2', { id: 'in-limits' }, 'Limitations'),
      h('ul', null,
        h('li', null, 'All outcomes are simulated. They say nothing about any real customer, cost, revenue or adoption.'),
        h('li', null, 'Three scenarios with one highlighted request each. Real implementations fail in more ways than this.'),
        h('li', null, 'People are modeled with fixed response times. A real approver or triage lead is less predictable.'),
        h('li', null, 'The clock has no calendar: no weekends, holidays or time zones.'),
        h('li', null, 'The rule editor changes three rule groups inside fixed bounds. It is not a general rules engine.'),
        h('li', null, 'Nothing is saved. Closing the page clears every run.'),
      ),
      h('h3', null, 'Future work (not built)'),
      h('ul', null,
        h('li', null, 'A fourth scenario: a customer changes scope mid-task.'),
        h('li', null, 'Calendar-aware service targets.'),
        h('li', null, 'Import and export of a scenario as JSON, so a reviewer can write their own failure.'),
      ),
    ),

    h('section', { 'aria-labelledby': 'in-contrib' },
      h('h2', { id: 'in-contrib' }, 'Contribution and AI assistance'),
      h('p', null, 'Jon Johnson defined the product concept, the three scenarios, the requirements, the integrity rules (synthetic data only, no metric that is not calculated, approval can never be bypassed) and the completion standard in a written specification.'),
      h('p', null, 'Claude, an AI model made by Anthropic, wrote the TypeScript, the tests and the first draft of the documentation from that specification. The commit history marks AI-authored commits.'),
      h('p', null, 'This project is independent student work. It is not affiliated with or endorsed by any university or company.'),
    ),
  );
}
