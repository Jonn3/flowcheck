// Rule catalog, bounds and validation for the rule editor.

import type { RuleSet } from './types.ts';

export interface RuleInfo {
  id: string;
  name: string;
  text: string;
}

/** Every rule id that can appear in a trace. */
export const RULES: Record<string, RuleInfo> = {
  'R-INTAKE-01': { id: 'R-INTAKE-01', name: 'Intake', text: 'Each accepted delivery creates exactly one task in Requested.' },
  'R-INTAKE-02': { id: 'R-INTAKE-02', name: 'Send to validation', text: 'A new task moves to Needs validation.' },
  'R-DEDUP-NONE': { id: 'R-DEDUP-NONE', name: 'No duplicate check', text: 'Every delivery is accepted.' },
  'R-DEDUP-KEY': { id: 'R-DEDUP-KEY', name: 'Idempotency key', text: 'A delivery whose idempotency key was already seen inside the retention period is suppressed.' },
  'R-DEDUP-WINDOW': { id: 'R-DEDUP-WINDOW', name: 'Title match window', text: 'A delivery with the same customer and title as an accepted delivery inside the window is suppressed.' },
  'R-VALID-01': { id: 'R-VALID-01', name: 'Validation', text: 'A task needs a known customer and a required skill.' },
  'R-APPR-01': { id: 'R-APPR-01', name: 'Request approval', text: 'A task that requires approval moves to Awaiting approval and a request goes to the primary approver.' },
  'R-APPR-02': { id: 'R-APPR-02', name: 'Approval decision', text: 'Only a decision from an authorized role releases or cancels the task.' },
  'R-APPR-03': { id: 'R-APPR-03', name: 'Closed request', text: 'A decision that arrives after the request is closed changes nothing.' },
  'R-ESC-REMIND': { id: 'R-ESC-REMIND', name: 'Remind approver', text: 'After the threshold, remind the primary approver. The state does not change.' },
  'R-ESC-BACKUP': { id: 'R-ESC-BACKUP', name: 'Escalate to backup', text: 'After the threshold, surface the request to the backup approver. The state does not change.' },
  'R-ESC-AUTO': { id: 'R-ESC-AUTO', name: 'Auto-approve on timeout', text: 'After the threshold, try to move the task to Assigned without a decision.' },
  'R-ASSIGN-01': { id: 'R-ASSIGN-01', name: 'Route by skill', text: 'Assign to the primary team for the required skill when its backlog is inside the limit.' },
  'R-ASSIGN-DEFAULT': { id: 'R-ASSIGN-DEFAULT', name: 'Send to default pool', text: 'When the primary team is full or missing, assign to the default pool without checking skill.' },
  'R-ASSIGN-FLAG': { id: 'R-ASSIGN-FLAG', name: 'Flag and queue', text: 'When the primary team is full or missing, block the task, raise a visible exception and route it to the triage lead.' },
  'R-ASSIGN-OVERFLOW': { id: 'R-ASSIGN-OVERFLOW', name: 'Overflow to qualified team', text: 'When the primary team is full, assign to another team that has the skill and a free slot. Otherwise flag and queue.' },
  'R-TRIAGE-01': { id: 'R-TRIAGE-01', name: 'Daily triage review', text: 'Once a day the triage lead reviews blocked work that nobody has raised.' },
  'R-TRIAGE-02': { id: 'R-TRIAGE-02', name: 'Triage lead decision', text: 'The triage lead queues a flagged task with its primary team, or records that no team can own it.' },
  'R-WORK-01': { id: 'R-WORK-01', name: 'Start work', text: 'A team starts its oldest assigned task when a slot is free.' },
  'R-WORK-02': { id: 'R-WORK-02', name: 'Finish work', text: 'A task completes after its effort.' },
  'R-WORK-03': { id: 'R-WORK-03', name: 'Wrong team', text: 'A team without the required skill stops and marks the task Blocked.' },
  'R-NOTIFY-01': { id: 'R-NOTIFY-01', name: 'Kickoff notice', text: 'The customer receives one kickoff notice when a task is assigned.' },
};

export interface Bound {
  path: string;
  label: string;
  min: number;
  max: number;
  unit: string;
}

export const BOUNDS: Bound[] = [
  { path: 'dedupe.windowMin', label: 'Title match window', min: 1, max: 240, unit: 'min' },
  { path: 'dedupe.keyRetentionMin', label: 'Key retention', min: 5, max: 2880, unit: 'min' },
  { path: 'escalation.afterMin', label: 'Escalation threshold', min: 15, max: 480, unit: 'min' },
  { path: 'assignment.queueLimit', label: 'Queue limit per team', min: 0, max: 5, unit: 'tasks' },
];

const DEDUPE_MODES = ['none', 'window', 'key'];
const ESCALATION_MODES = ['none', 'remind', 'backup', 'auto-approve'];
const ASSIGNMENT_MODES = ['default-pool', 'flag-and-queue', 'overflow'];

export interface RuleIssue {
  path: string;
  severity: 'error' | 'warning';
  message: string;
}

function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Validate a rule set from the editor. Errors stop the run. Warnings let it
 * run and explain what the engine will do.
 */
export function validateRules(input: unknown): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const mode = (path: string, allowed: string[]) => {
    const v = readPath(input, path);
    if (typeof v !== 'string' || !allowed.includes(v)) {
      issues.push({ path, severity: 'error', message: `Choose one of: ${allowed.join(', ')}.` });
    }
  };
  mode('dedupe.mode', DEDUPE_MODES);
  mode('escalation.mode', ESCALATION_MODES);
  mode('assignment.mode', ASSIGNMENT_MODES);
  for (const b of BOUNDS) {
    const v = readPath(input, b.path);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      issues.push({ path: b.path, severity: 'error', message: `${b.label} needs a number.` });
    } else if (!Number.isInteger(v)) {
      issues.push({ path: b.path, severity: 'error', message: `${b.label} must be a whole number of ${b.unit}.` });
    } else if (v < b.min || v > b.max) {
      issues.push({ path: b.path, severity: 'error', message: `${b.label} must be between ${b.min} and ${b.max} ${b.unit}.` });
    }
  }
  if (readPath(input, 'escalation.mode') === 'auto-approve') {
    issues.push({
      path: 'escalation.mode',
      severity: 'warning',
      message: 'This rule will run, but guard G-APPROVAL rejects every transition it attempts. A timer is not an approver.',
    });
  }
  return issues;
}

export function hasErrors(issues: RuleIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

export function cloneRules(r: RuleSet): RuleSet {
  return {
    dedupe: { ...r.dedupe },
    escalation: { ...r.escalation },
    assignment: { ...r.assignment },
  };
}

export function sameRules(a: RuleSet, b: RuleSet): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Plain-language summary of the parts of `next` that differ from `base`. */
export function describeRuleChange(base: RuleSet, next: RuleSet): string[] {
  const out: string[] = [];
  const d = next.dedupe;
  if (JSON.stringify(base.dedupe) !== JSON.stringify(d)) {
    if (d.mode === 'none') out.push('Duplicate check: none');
    if (d.mode === 'key') out.push(`Duplicate check: idempotency key, kept ${d.keyRetentionMin} min`);
    if (d.mode === 'window') out.push(`Duplicate check: same customer and title within ${d.windowMin} min`);
  }
  const e = next.escalation;
  if (JSON.stringify(base.escalation) !== JSON.stringify(e)) {
    if (e.mode === 'none') out.push('Escalation: none');
    if (e.mode === 'remind') out.push(`Escalation: remind the primary approver after ${e.afterMin} min`);
    if (e.mode === 'backup') out.push(`Escalation: surface to the backup approver after ${e.afterMin} min`);
    if (e.mode === 'auto-approve') out.push(`Escalation: try to auto-approve after ${e.afterMin} min`);
  }
  const a = next.assignment;
  if (JSON.stringify(base.assignment) !== JSON.stringify(a)) {
    const name = { 'default-pool': 'send to the default pool', 'flag-and-queue': 'flag and queue', overflow: 'overflow to a qualified team' }[a.mode];
    out.push(`Assignment when the primary team is full or missing: ${name} (queue limit ${a.queueLimit})`);
  }
  return out;
}
