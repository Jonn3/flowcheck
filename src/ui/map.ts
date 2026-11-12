// The workflow map. Nodes are the eight states and edges are drawn from the
// engine's TRANSITIONS table, so the picture cannot drift from the rules.

import type { State, TraceEntry } from '../engine/types.ts';
import type { Snapshot } from '../engine/metrics.ts';
import { STATES, STATE_LABEL, TRANSITIONS } from '../engine/machine.ts';
import { s, STATE_ICON } from './dom.ts';

interface Layout {
  w: number;
  h: number;
  nodeW: number;
  nodeH: number;
  pos: Record<State, [number, number]>;
}

const WIDE: Layout = {
  w: 1000, h: 330, nodeW: 146, nodeH: 66,
  pos: {
    Requested: [80, 120], NeedsValidation: [250, 120], AwaitingApproval: [420, 40], Assigned: [590, 120],
    InProgress: [760, 120], Complete: [920, 120], Blocked: [505, 270], Canceled: [840, 270],
  },
};

const NARROW: Layout = {
  w: 360, h: 470, nodeW: 152, nodeH: 66,
  pos: {
    Requested: [90, 40], NeedsValidation: [270, 40], AwaitingApproval: [90, 160], Assigned: [270, 160],
    Blocked: [90, 280], InProgress: [270, 280], Canceled: [90, 410], Complete: [270, 410],
  },
};

/** Point where the line from a to b leaves the rectangle centred on a. */
function edgePoint(a: [number, number], b: [number, number], w: number, hgt: number, pad: number): [number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const hw = w / 2 + pad;
  const hh = hgt / 2 + pad;
  const scale = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return [a[0] + dx * scale, a[1] + dy * scale];
}

export function renderMap(snapshot: Snapshot, current: TraceEntry | null, focalTaskId: string | null, narrow: boolean): SVGElement {
  const L = narrow ? NARROW : WIDE;
  const byState = new Map<State, string[]>();
  for (const st of STATES) byState.set(st, []);
  for (const [id, t] of snapshot.tasks) byState.get(t.state)!.push(id);

  const summary = STATES.map((st) => `${STATE_LABEL[st]}: ${byState.get(st)!.length}`).join(', ');
  const svg = s('svg', {
    viewBox: `0 0 ${L.w} ${L.h}`, role: 'img', class: 'map',
    'aria-label': `Workflow map. Tasks in each state: ${summary}.`,
  });
  svg.appendChild(s('defs', null,
    s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' },
      s('path', { d: 'M0 0 L10 5 L0 10 z', class: 'arrow-head' })),
    s('marker', { id: 'arrow-on', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' },
      s('path', { d: 'M0 0 L10 5 L0 10 z', class: 'arrow-head on' })),
    s('marker', { id: 'arrow-no', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' },
      s('path', { d: 'M0 0 L10 5 L0 10 z', class: 'arrow-head no' })),
  ));

  const activeEdge = current && current.from && current.to ? `${current.from}>${current.to}` : null;
  const rejected = current?.outcome === 'rejected';

  const edges = s('g', null);
  for (const from of STATES) {
    for (const to of TRANSITIONS[from]) {
      const a = L.pos[from];
      const b = L.pos[to];
      const p1 = edgePoint(a, b, L.nodeW, L.nodeH, 2);
      const p2 = edgePoint(b, a, L.nodeW, L.nodeH, 6);
      const on = activeEdge === `${from}>${to}`;
      const cls = ['edge', to === 'Canceled' ? 'edge-cancel' : '', on ? (rejected ? 'edge-no' : 'edge-on') : ''].join(' ').trim();
      edges.appendChild(s('line', {
        x1: p1[0].toFixed(1), y1: p1[1].toFixed(1), x2: p2[0].toFixed(1), y2: p2[1].toFixed(1), class: cls,
        'marker-end': `url(#${on ? (rejected ? 'arrow-no' : 'arrow-on') : 'arrow'})`,
      }));
      if (on && rejected) {
        const mx = (p1[0] + p2[0]) / 2;
        const my = (p1[1] + p2[1]) / 2;
        edges.appendChild(s('g', { class: 'reject-mark' },
          s('circle', { cx: mx.toFixed(1), cy: my.toFixed(1), r: '13' }),
          s('text', { x: mx.toFixed(1), y: (my + 5).toFixed(1), 'text-anchor': 'middle' }, '✕')));
      }
    }
  }
  svg.appendChild(edges);

  for (const st of STATES) {
    const [x, y] = L.pos[st];
    const ids = byState.get(st)!;
    const isTarget = !!current && current.to === st && current.outcome === 'applied';
    const isHeld = !!current && rejected && current.from === st;
    const g = s('g', { class: `node st-${st}${ids.length ? ' has-tasks' : ''}${isTarget ? ' node-on' : ''}${isHeld ? ' node-held' : ''}` });
    g.appendChild(s('rect', { x: x - L.nodeW / 2, y: y - L.nodeH / 2, width: L.nodeW, height: L.nodeH, rx: '8' }));
    g.appendChild(s('text', { x: x - L.nodeW / 2 + 10, y: y - 8, class: 'node-label' }, `${STATE_ICON[st]} ${STATE_LABEL[st]}`));
    g.appendChild(s('text', { x: x + L.nodeW / 2 - 10, y: y + 20, class: 'node-count', 'text-anchor': 'end' }, String(ids.length)));
    const shown = ids.slice(-3);
    const line = s('text', { x: x - L.nodeW / 2 + 10, y: y + 19, class: 'node-ids' });
    shown.forEach((id, i) => {
      line.appendChild(s('tspan', { class: id === focalTaskId ? 'focal' : null, dx: i === 0 ? '0' : '6' }, id.replace('T-', '')));
    });
    if (ids.length > shown.length) line.appendChild(s('tspan', { dx: '6' }, `+${ids.length - shown.length}`));
    g.appendChild(line);
    svg.appendChild(g);
  }
  return svg;
}
