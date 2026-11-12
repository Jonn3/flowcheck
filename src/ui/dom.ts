// Small DOM helpers. The page builds every node with these, so no HTML string
// is ever parsed and nothing is fetched.

import type { State } from '../engine/types.ts';
import { STATE_LABEL } from '../engine/machine.ts';

export type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> | null;

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

function setAttrs(el: Element, attrs: Attrs): void {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.setAttribute('class', String(v));
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}

export function h(tag: string, attrs?: Attrs, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  setAttrs(el, attrs ?? null);
  append(el, children);
  return el;
}

export function s(tag: string, attrs?: Attrs, ...children: Child[]): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  setAttrs(el, attrs ?? null);
  append(el, children);
  return el;
}

export const STATE_ICON: Record<State, string> = {
  Requested: '○',
  NeedsValidation: '◔',
  AwaitingApproval: '‖',
  Assigned: '→',
  InProgress: '►',
  Blocked: '✕',
  Complete: '✓',
  Canceled: '⊘',
};

export function stateChip(state: State): HTMLElement {
  return h('span', { class: `chip st-${state}` }, h('span', { 'aria-hidden': 'true', class: 'chip-icon' }, STATE_ICON[state]), STATE_LABEL[state]);
}

export function table(headers: string[], rows: Child[][], opts: { caption?: string; rowClass?: (i: number) => string | null } = {}): HTMLElement {
  return h('div', { class: 'table-wrap', tabindex: '0', role: 'group', 'aria-label': opts.caption ?? 'Table' },
    h('table', null,
      opts.caption ? h('caption', null, opts.caption) : null,
      h('thead', null, h('tr', null, headers.map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, rows.map((r, i) => h('tr', { class: opts.rowClass?.(i) ?? null }, r.map((c, j) => (j === 0 ? h('th', { scope: 'row' }, c) : h('td', null, c)))))),
    ),
  );
}

export function record(title: string, pairs: [string, Child][], note?: string): HTMLElement {
  return h('div', { class: 'record' },
    h('h4', null, title),
    h('dl', null, pairs.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    note ? h('p', { class: 'record-note' }, note) : null,
  );
}

export function mono(text: string | number): HTMLElement {
  return h('span', { class: 'mono' }, text);
}
