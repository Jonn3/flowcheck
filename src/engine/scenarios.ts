// The fictional company, its customers and the three scenarios.
//
// Fernhollow Software and every customer, person and request below are
// invented for this simulation. Any resemblance to a real organization is
// coincidental.

import type { ScenarioData, RuleSet, Customer, Team, Approver, ApprovalPolicy, RequestDelivery, InputEvent } from './types.ts';
import type { Metrics } from './metrics.ts';
import { makeRng, rngInt } from './clock.ts';
import { cloneRules } from './rules.ts';

export const COMPANY = 'Fernhollow Software';
export const FOCAL_CUSTOMER = 'Kestrel Freight';

const CUSTOMERS: Customer[] = [
  { id: 'kestrel', name: 'Kestrel Freight', segment: 'Regional logistics' },
  { id: 'marlowe', name: 'Marlowe Supply', segment: 'Wholesale distribution' },
  { id: 'ostrander', name: 'Ostrander Labs', segment: 'Laboratory services' },
  { id: 'tallgrass', name: 'Tallgrass Dental', segment: 'Multi-site clinics' },
];

const TEAMS: Team[] = [
  { id: 'integrations', name: 'Integrations', skills: ['api', 'sso'], capacity: 2 },
  { id: 'data', name: 'Data Migration', skills: ['migration'], capacity: 2 },
  { id: 'onboarding', name: 'Onboarding', skills: ['config', 'training'], capacity: 3, isDefaultPool: true },
  { id: 'solutions', name: 'Solutions', skills: ['reporting', 'sso'], capacity: 1, efficiency: { sso: 1.5 } },
];

const ROUTING: Record<string, string> = {
  api: 'integrations',
  sso: 'integrations',
  migration: 'data',
  config: 'onboarding',
  training: 'onboarding',
  reporting: 'solutions',
};

const POLICY: ApprovalPolicy = {
  authorizedRoles: ['Security lead', 'Security manager'],
  primaryApproverId: 'dana',
  backupApproverId: 'sam',
  decisionTargetMin: 240,
  backupReviewMin: 40,
};

function approvers(primaryOut: { from: number; to: number } | null): Approver[] {
  return [
    { id: 'dana', name: 'Dana Reyes', role: 'Security lead', outOfOffice: primaryOut },
    { id: 'sam', name: 'Sam Whitfield', role: 'Security manager', outOfOffice: null },
    { id: 'jordan', name: 'Jordan Pike', role: 'Implementation manager', outOfOffice: null },
  ];
}

const CONSTANTS = { validationMin: 2, triageLeadResponseMin: 20, misrouteDiscoveryMin: 120, dailyTriageAt: [480, 960, 1440] };

function base(id: string, seed: number, inputs: InputEvent[], primaryOut: { from: number; to: number } | null): ScenarioData {
  return {
    id, seed,
    customers: CUSTOMERS.map((c) => ({ ...c })),
    teams: TEAMS.map((t) => ({ ...t, skills: [...t.skills], efficiency: t.efficiency ? { ...t.efficiency } : undefined })),
    approvers: approvers(primaryOut),
    policy: { ...POLICY, authorizedRoles: [...POLICY.authorizedRoles] },
    routing: { ...ROUTING },
    inputs,
    constants: { ...CONSTANTS, dailyTriageAt: [...CONSTANTS.dailyTriageAt] },
  };
}

function delivery(d: Omit<RequestDelivery, 'kind' | 'requiresApproval'> & { requiresApproval?: boolean }): RequestDelivery {
  return { kind: 'request.delivered', requiresApproval: false, ...d };
}

/** Effort within ±8% of the base, drawn from the seed. */
const vary = (rng: () => number, baseMin: number) => Math.round(baseMin * (0.92 + rng() * 0.16));

// ---- A. Duplicate integration event --------------------------------------

function buildDuplicate(seed: number): ScenarioData {
  const rng = makeRng(seed);
  const ssoEffort = vary(rng, 180);
  const sso = { customerId: 'kestrel', title: 'Provision SSO connector', skill: 'sso', targetMin: 480 };
  return base('duplicate', seed, [
    delivery({ id: 'D-101', at: 10, idempotencyKey: 'REQ-7781', ...sso, effortMin: ssoEffort, truth: 'original', note: 'First delivery from the customer CRM integration.' }),
    delivery({ id: 'D-102', at: 14, idempotencyKey: 'REQ-7781', ...sso, effortMin: ssoEffort, truth: 'retry', note: 'The sender timed out waiting for a reply and sent the same event again.' }),
    delivery({ id: 'D-103', at: 30, idempotencyKey: 'REQ-7790', ...sso, effortMin: vary(rng, 170), truth: 'distinct', note: 'A separate request for a second business unit. The form fills in the same title.' }),
    delivery({ id: 'D-104', at: 52, idempotencyKey: 'REQ-7781', ...sso, effortMin: ssoEffort, truth: 'retry', note: 'A late retry of REQ-7781 after the sender backed off.' }),
    delivery({ id: 'D-105', at: 60, idempotencyKey: 'REQ-7802', customerId: 'kestrel', title: 'Rotate API credentials before go-live', skill: 'api', effortMin: vary(rng, 150), targetMin: 360, truth: 'distinct', focal: true, note: 'Needed before the go-live rehearsal.' }),
    delivery({ id: 'D-106', at: 75 + rngInt(rng, -3, 3), idempotencyKey: 'REQ-7810', customerId: 'tallgrass', title: 'Configure appointment types', skill: 'config', effortMin: vary(rng, 120), targetMin: 480, truth: 'distinct' }),
  ], null);
}

// ---- B. Approval bottleneck ----------------------------------------------

function buildApproval(seed: number): ScenarioData {
  const rng = makeRng(seed);
  const imp = { skill: 'migration', requiresApproval: true, targetMin: 960, truth: 'distinct' as const };
  return base('approval', seed, [
    delivery({ id: 'D-201', at: 5, idempotencyKey: 'REQ-8101', customerId: 'marlowe', title: 'Import product catalog (production data)', effortMin: vary(rng, 200), reviewMin: rngInt(rng, 70, 100), ...imp }),
    delivery({ id: 'D-202', at: 24, idempotencyKey: 'REQ-8104', customerId: 'ostrander', title: 'Import lab inventory (production data)', effortMin: vary(rng, 180), reviewMin: rngInt(rng, 70, 100), ...imp }),
    delivery({ id: 'D-203', at: 160, idempotencyKey: 'REQ-8117', customerId: 'kestrel', title: 'Import shipment history (production data)', effortMin: vary(rng, 240), reviewMin: rngInt(rng, 70, 100), ...imp, focal: true, note: 'Production data imports need a security approval before anyone starts.' }),
    delivery({ id: 'D-204', at: 200, idempotencyKey: 'REQ-8120', customerId: 'kestrel', title: 'Enable sandbox API access', skill: 'api', effortMin: vary(rng, 120), targetMin: 480, truth: 'distinct' }),
  ], { from: 150, to: 1200 });
}

// ---- C. Assignment failure -----------------------------------------------

function buildAssignment(seed: number): ScenarioData {
  const rng = makeRng(seed);
  return base('assignment', seed, [
    delivery({ id: 'D-301', at: 5, idempotencyKey: 'REQ-9001', customerId: 'marlowe', title: 'Build inventory API integration', skill: 'api', effortMin: vary(rng, 440), targetMin: 960, truth: 'distinct' }),
    delivery({ id: 'D-302', at: 12, idempotencyKey: 'REQ-9003', customerId: 'ostrander', title: 'Connect instrument data API', skill: 'api', effortMin: vary(rng, 470), targetMin: 960, truth: 'distinct' }),
    delivery({ id: 'D-303', at: 60, idempotencyKey: 'REQ-9010', customerId: 'kestrel', title: 'Set up single sign-on', skill: 'sso', effortMin: vary(rng, 240), targetMin: 480, truth: 'distinct', focal: true, note: 'Integrations is the primary team for SSO and both of its slots are busy.' }),
    delivery({ id: 'D-304', at: 90, idempotencyKey: 'REQ-9014', customerId: 'kestrel', title: 'Map EDI shipment feed', skill: 'edi', effortMin: vary(rng, 300), targetMin: 960, truth: 'distinct', note: 'No team lists EDI as a skill.' }),
    delivery({ id: 'D-305', at: 200, idempotencyKey: 'REQ-9021', customerId: 'tallgrass', title: 'Build executive reporting pack', skill: 'reporting', effortMin: vary(rng, 180), targetMin: 300, truth: 'distinct' }),
  ], null);
}

// ---- scenario catalog ----------------------------------------------------

export interface ResponseOption {
  id: string;
  label: string;
  summary: string;
  tradeoff: string;
  apply: (baseline: RuleSet) => RuleSet;
}

export interface Scenario {
  id: 'duplicate' | 'approval' | 'assignment';
  letter: 'A' | 'B' | 'C';
  title: string;
  problem: string;
  stakeholder: string;
  baselineBehavior: string;
  evidenceHint: string;
  defaultSeed: number;
  baselineRules: RuleSet;
  responses: ResponseOption[];
  editorSection: 'dedupe' | 'escalation' | 'assignment';
  culprit: { action: string; taskId: string };
  metricIds: (keyof Metrics)[];
  build: (seed: number) => ScenarioData;
}

const change = (fn: (r: RuleSet) => void) => (baseline: RuleSet) => {
  const r = cloneRules(baseline);
  fn(r);
  return r;
};

export const SCENARIOS: Scenario[] = [
  {
    id: 'duplicate',
    letter: 'A',
    title: 'Duplicate integration event',
    problem: 'Kestrel Freight’s CRM sent the same request three times. Fernhollow built the same SSO connector more than once, the customer got repeat kickoff notices, and the credential rotation Kestrel needs before go-live missed its target.',
    stakeholder: 'Kestrel’s project lead asks why they received duplicate kickoff notices and why the credential rotation is late.',
    baselineBehavior: 'Intake accepts every delivery. Each one becomes a task, gets assigned and sends a kickoff notice.',
    evidenceHint: 'Compare the delivery IDs with the idempotency keys. Then look at D-103: same title, different key.',
    defaultSeed: 1101,
    baselineRules: {
      dedupe: { mode: 'none', windowMin: 15, keyRetentionMin: 1440 },
      escalation: { mode: 'backup', afterMin: 120 },
      assignment: { mode: 'flag-and-queue', queueLimit: 5 },
    },
    responses: [
      {
        id: 'key', label: 'Check the idempotency key',
        summary: 'Remember each request key for 24 hours. A delivery with a known key creates nothing.',
        tradeoff: 'Depends on the sender attaching a stable key to every retry, and the key store has to outlive the sender’s longest retry delay.',
        apply: change((r) => { r.dedupe.mode = 'key'; r.dedupe.keyRetentionMin = 1440; }),
      },
      {
        id: 'window-15', label: 'Match customer and title for 15 minutes',
        summary: 'Suppress a delivery when the same customer sent the same title in the last 15 minutes.',
        tradeoff: 'Needs nothing from the sender. A retry that arrives after the window still gets through.',
        apply: change((r) => { r.dedupe.mode = 'window'; r.dedupe.windowMin = 15; }),
      },
      {
        id: 'window-45', label: 'Match customer and title for 45 minutes',
        summary: 'The same title check with a window wide enough to catch late retries.',
        tradeoff: 'Catches more retries. Two different requests that share a title look identical to this rule.',
        apply: change((r) => { r.dedupe.mode = 'window'; r.dedupe.windowMin = 45; }),
      },
    ],
    editorSection: 'dedupe',
    culprit: { action: 'task.created', taskId: 'T-102' },
    metricIds: ['duplicateTasks', 'duplicateNotices', 'lostRequests', 'wastedWorkMin', 'focalCycleMin', 'onTarget'],
    build: buildDuplicate,
  },
  {
    id: 'approval',
    letter: 'B',
    title: 'Approval bottleneck',
    problem: 'Kestrel’s production data import needs a security approval. The request went to an approver who had just left for two days, and nothing told anyone it was waiting.',
    stakeholder: 'Kestrel’s project lead wants to know who is looking at the import and when it will start.',
    baselineBehavior: 'The approval request goes to the primary approver and waits. There is no escalation rule.',
    evidenceHint: 'Read the approval request, the approver calendar and the list of roles allowed to decide.',
    defaultSeed: 2202,
    baselineRules: {
      dedupe: { mode: 'key', windowMin: 15, keyRetentionMin: 1440 },
      escalation: { mode: 'none', afterMin: 120 },
      assignment: { mode: 'flag-and-queue', queueLimit: 5 },
    },
    responses: [
      {
        id: 'backup', label: 'Escalate to the backup approver after 2 hours',
        summary: 'After 120 minutes without a decision, surface the request to the security manager, who is authorized to decide.',
        tradeoff: 'A second person spends review time. Set the threshold too low and the backup reviews requests the primary was about to decide.',
        apply: change((r) => { r.escalation.mode = 'backup'; r.escalation.afterMin = 120; }),
      },
      {
        id: 'remind', label: 'Remind the same approver after 2 hours',
        summary: 'After 120 minutes without a decision, send the primary approver a reminder.',
        tradeoff: 'No one else is interrupted. A reminder only helps if the person is there to read it.',
        apply: change((r) => { r.escalation.mode = 'remind'; r.escalation.afterMin = 120; }),
      },
      {
        id: 'auto', label: 'Auto-approve after 2 hours',
        summary: 'After 120 minutes without a decision, let the system release the task.',
        tradeoff: 'Fastest on paper. It replaces a required authorization with a timer, so the guard rejects it. Run it to see the rejection.',
        apply: change((r) => { r.escalation.mode = 'auto-approve'; r.escalation.afterMin = 120; }),
      },
    ],
    editorSection: 'escalation',
    culprit: { action: 'approval.requested', taskId: 'T-203' },
    metricIds: ['approvalWaitMin', 'approvalOnTarget', 'focalCycleMin', 'escalations', 'redundantReviews', 'rejectedTransitions', 'onTarget'],
    build: buildApproval,
  },
  {
    id: 'assignment',
    letter: 'C',
    title: 'Assignment failure',
    problem: 'Kestrel’s single sign-on setup arrived while the Integrations team was full, and its EDI feed needs a skill no team has. Both were dropped on the Onboarding team, which worked on them, got stuck and told no one.',
    stakeholder: 'Kestrel’s project lead was told work had started. A day later nothing has moved.',
    baselineBehavior: 'When the primary team is full or missing, the task goes to the default pool without a skill check.',
    evidenceHint: 'Check which teams hold each skill, how many slots were busy, and what the routing table says for EDI.',
    defaultSeed: 3303,
    baselineRules: {
      dedupe: { mode: 'key', windowMin: 15, keyRetentionMin: 1440 },
      escalation: { mode: 'backup', afterMin: 120 },
      assignment: { mode: 'default-pool', queueLimit: 0 },
    },
    responses: [
      {
        id: 'flag', label: 'Flag the exception and queue it',
        summary: 'Block the task, raise a visible exception and route it to the triage lead, who queues it for the right team.',
        tradeoff: 'Nothing is hidden and nobody works on the wrong thing. The task still waits for a slot, so it can still be late.',
        apply: change((r) => { r.assignment.mode = 'flag-and-queue'; }),
      },
      {
        id: 'overflow', label: 'Overflow to another qualified team',
        summary: 'If the primary team is full, give the task to another team with the skill and a free slot. Otherwise flag it.',
        tradeoff: 'The task starts sooner. The second team is slower at it and its own work waits behind it.',
        apply: change((r) => { r.assignment.mode = 'overflow'; }),
      },
    ],
    editorSection: 'assignment',
    culprit: { action: 'task.assigned', taskId: 'T-303' },
    metricIds: ['hiddenBlockedMin', 'wastedWorkMin', 'focalCycleMin', 'onTarget', 'blockedAtEnd'],
    build: buildAssignment,
  },
];

export function scenarioById(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown scenario "${id}".`);
  return s;
}

/** Seeds are whole numbers from 1 to 999999. */
export function validSeed(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 999999;
}
