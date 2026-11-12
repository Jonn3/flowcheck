// Typed records for the FlowCheck simulation.
// Everything here is synthetic. No record describes a real company or person.

export type State =
  | 'Requested'
  | 'NeedsValidation'
  | 'AwaitingApproval'
  | 'Assigned'
  | 'InProgress'
  | 'Blocked'
  | 'Complete'
  | 'Canceled';

export interface Customer {
  id: string;
  name: string;
  segment: string;
}

export interface Team {
  id: string;
  name: string;
  skills: string[];
  /** Number of tasks the team can work on at the same time. */
  capacity: number;
  /** Effort multiplier per skill. 1.5 means the team needs 50% longer. */
  efficiency?: Record<string, number>;
  /** The team that receives work when the baseline rule has nowhere else to put it. */
  isDefaultPool?: boolean;
}

export interface Approver {
  id: string;
  name: string;
  role: string;
  /** Simulated minutes during which this person does not review requests. */
  outOfOffice: { from: number; to: number } | null;
}

export interface ApprovalPolicy {
  /** Roles whose decision can release an approval-required task. */
  authorizedRoles: string[];
  primaryApproverId: string;
  backupApproverId: string;
  /** Service target for a decision, in minutes from the approval request. */
  decisionTargetMin: number;
  /** Minutes the backup approver needs after being notified. */
  backupReviewMin: number;
}

/**
 * `truth` is a ground-truth label on the synthetic data. Metrics read it to count
 * duplicates and lost requests. The engine's rules never read it.
 */
export type DeliveryTruth = 'original' | 'retry' | 'distinct';

export interface RequestDelivery {
  kind: 'request.delivered';
  id: string;
  at: number;
  idempotencyKey: string;
  customerId: string;
  title: string;
  skill: string;
  effortMin: number;
  requiresApproval: boolean;
  /** Completion service target, in minutes from delivery. */
  targetMin: number;
  /** Minutes the primary approver needs to review this request. */
  reviewMin?: number;
  truth: DeliveryTruth;
  focal?: boolean;
  note?: string;
}

export interface DecisionSubmission {
  kind: 'approval.decision.submitted';
  id: string;
  at: number;
  taskId: string;
  approverId: string;
  decision: 'approved' | 'rejected';
}

export type InputEvent = RequestDelivery | DecisionSubmission;

export type ExceptionCode = 'TEAM_AT_CAPACITY' | 'NO_QUALIFIED_OWNER' | 'WRONG_TEAM';

export interface ExceptionRecord {
  code: ExceptionCode;
  /** When the condition actually began. */
  occurredAt: number;
  /** When the system made it visible to a person. null = still hidden. */
  raisedAt: number | null;
  routedTo: string | null;
  resolvedAt: number | null;
}

export interface ApprovalRecord {
  requestedAt: number;
  requestedFrom: string;
  decidedAt: number | null;
  decidedBy: string | null;
  decision: 'approved' | 'rejected' | null;
}

export interface Task {
  id: string;
  deliveryId: string;
  idempotencyKey: string;
  customerId: string;
  title: string;
  skill: string;
  effortMin: number;
  requiresApproval: boolean;
  createdAt: number;
  dueAt: number;
  state: State;
  ownerTeamId: string | null;
  assignedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  /** Minutes of finished work segments. */
  workedMin: number;
  /** Portion of workedMin spent by a team that could not finish the task. */
  misroutedMin: number;
  approval: ApprovalRecord | null;
  exception: ExceptionRecord | null;
}

export type DedupeMode = 'none' | 'window' | 'key';
export type EscalationMode = 'none' | 'remind' | 'backup' | 'auto-approve';
export type AssignmentMode = 'default-pool' | 'flag-and-queue' | 'overflow';

export interface RuleSet {
  dedupe: { mode: DedupeMode; windowMin: number; keyRetentionMin: number };
  escalation: { mode: EscalationMode; afterMin: number };
  assignment: { mode: AssignmentMode; queueLimit: number };
}

export type Outcome = 'applied' | 'suppressed' | 'rejected' | 'noted';

export interface TraceEntry {
  seq: number;
  at: number;
  /** Id of the input event or internal timer that caused this entry. */
  causeId: string;
  ruleId: string;
  action: string;
  outcome: Outcome;
  taskId?: string;
  teamId?: string;
  from?: State;
  to?: State;
  detail: string;
}

export interface Notice {
  at: number;
  taskId: string;
  customerId: string;
  kind: 'kickoff';
}

export interface Escalation {
  at: number;
  taskId: string;
  type: 'reminder' | 'backup' | 'auto-approve-attempt';
  to: string;
}

export interface ScenarioData {
  id: string;
  seed: number;
  customers: Customer[];
  teams: Team[];
  approvers: Approver[];
  policy: ApprovalPolicy;
  /** Primary team for each skill. A skill with no entry has no qualified owner. */
  routing: Record<string, string>;
  inputs: InputEvent[];
  constants: {
    validationMin: number;
    triageLeadResponseMin: number;
    misrouteDiscoveryMin: number;
    /** Times of the daily triage review. */
    dailyTriageAt: number[];
  };
}

export interface Run {
  scenarioId: string;
  seed: number;
  rules: RuleSet;
  data: ScenarioData;
  tasks: Task[];
  trace: TraceEntry[];
  notices: Notice[];
  escalations: Escalation[];
  endAt: number;
}
