// The workflow state machine. The transition table below is the single source
// of truth: the engine, the workflow map and the documentation all read it.

import type { State, Task, ApprovalPolicy, Approver } from './types.ts';

export const STATES: State[] = [
  'Requested',
  'NeedsValidation',
  'AwaitingApproval',
  'Assigned',
  'InProgress',
  'Blocked',
  'Complete',
  'Canceled',
];

export const STATE_LABEL: Record<State, string> = {
  Requested: 'Requested',
  NeedsValidation: 'Needs validation',
  AwaitingApproval: 'Awaiting approval',
  Assigned: 'Assigned',
  InProgress: 'In progress',
  Blocked: 'Blocked',
  Complete: 'Complete',
  Canceled: 'Canceled',
};

/** Allowed transitions. Anything not listed is rejected. */
export const TRANSITIONS: Record<State, State[]> = {
  Requested: ['NeedsValidation', 'Canceled'],
  NeedsValidation: ['AwaitingApproval', 'Assigned', 'Blocked', 'Canceled'],
  AwaitingApproval: ['Assigned', 'Blocked', 'Canceled'],
  Assigned: ['InProgress', 'Blocked', 'Canceled'],
  InProgress: ['Complete', 'Blocked', 'Canceled'],
  Blocked: ['NeedsValidation', 'Assigned', 'Canceled'],
  Complete: [],
  Canceled: [],
};

export const TRANSITION_REASON: Record<string, string> = {
  'Requested>NeedsValidation': 'Every accepted request is checked before anyone works on it.',
  'Requested>Canceled': 'The customer withdraws the request.',
  'NeedsValidation>AwaitingApproval': 'The request needs a decision from an authorized approver.',
  'NeedsValidation>Assigned': 'No approval is needed and a qualified team can take it.',
  'NeedsValidation>Blocked': 'No qualified team can take it. The exception is raised.',
  'NeedsValidation>Canceled': 'The request fails validation and is withdrawn.',
  'AwaitingApproval>Assigned': 'An authorized approver approved it. Guard G-APPROVAL applies.',
  'AwaitingApproval>Blocked': 'Approved, but no qualified team can take it. Guard G-APPROVAL applies.',
  'AwaitingApproval>Canceled': 'An authorized approver rejected it.',
  'Assigned>InProgress': 'The owning team has a free slot and starts work.',
  'Assigned>Blocked': 'The owning team cannot start.',
  'Assigned>Canceled': 'The request is withdrawn before work starts.',
  'InProgress>Complete': 'The work is finished.',
  'InProgress>Blocked': 'The team finds it cannot finish the work.',
  'InProgress>Canceled': 'The request is withdrawn during work.',
  'Blocked>NeedsValidation': 'The request is corrected and checked again.',
  'Blocked>Assigned': 'The exception is resolved and a qualified team takes it.',
  'Blocked>Canceled': 'The request is withdrawn.',
};

export type Check = { ok: true } | { ok: false; code: 'NOT_ALLOWED' | 'G-APPROVAL'; reason: string };

/** States that mean somebody is doing, or has done, the work. */
const WORK_STATES: State[] = ['Assigned', 'InProgress', 'Complete'];

export function hasAuthorizedApproval(task: Task, policy: ApprovalPolicy, approvers: Approver[]): boolean {
  const a = task.approval;
  if (!a || a.decision !== 'approved' || !a.decidedBy) return false;
  const who = approvers.find((p) => p.id === a.decidedBy);
  return !!who && policy.authorizedRoles.includes(who.role);
}

/**
 * Decide whether `task` may move to `to`.
 *
 * Guard G-APPROVAL: a task that requires approval can only enter Assigned,
 * In progress or Complete when an approved decision from an authorized role is
 * on record. A task leaving Awaiting approval for Blocked needs the same
 * decision, so Blocked can never be used as a side door around approval.
 */
export function checkTransition(task: Task, to: State, policy: ApprovalPolicy, approvers: Approver[]): Check {
  const from = task.state;
  if (!TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      code: 'NOT_ALLOWED',
      reason: `${STATE_LABEL[from]} → ${STATE_LABEL[to]} is not an allowed transition.`,
    };
  }
  const needsDecision = WORK_STATES.includes(to) || (from === 'AwaitingApproval' && to === 'Blocked');
  if (task.requiresApproval && needsDecision && !hasAuthorizedApproval(task, policy, approvers)) {
    return {
      ok: false,
      code: 'G-APPROVAL',
      reason: 'No approval decision from an authorized approver is on record.',
    };
  }
  return { ok: true };
}

export class InvalidTransitionError extends Error {
  code: string;
  constructor(code: string, reason: string) {
    super(reason);
    this.name = 'InvalidTransitionError';
    this.code = code;
  }
}

export function assertTransition(task: Task, to: State, policy: ApprovalPolicy, approvers: Approver[]): void {
  const c = checkTransition(task, to, policy, approvers);
  if (!c.ok) throw new InvalidTransitionError(c.code, c.reason);
}
