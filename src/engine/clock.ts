// The simulation clock counts whole working minutes from the start of Day 1.
// A working day is 8 hours (09:00 to 17:00). Nights and weekends do not exist
// in the model, so "1 day" always means 480 working minutes.

export const WORKDAY_MIN = 480;
const START_HOUR = 9;

export function fmtClock(t: number): string {
  const day = Math.floor(t / WORKDAY_MIN) + 1;
  const m = t % WORKDAY_MIN;
  const hh = String(START_HOUR + Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `Day ${day} · ${hh}:${mm}`;
}

export function fmtDuration(min: number): string {
  const sign = min < 0 ? '−' : '';
  const v = Math.abs(Math.round(min));
  if (v < 60) return `${sign}${v} min`;
  const h = Math.floor(v / 60);
  const m = v % 60;
  return m === 0 ? `${sign}${h} h` : `${sign}${h} h ${m} min`;
}

// Seeded pseudo-random numbers (mulberry32). The engine itself never draws a
// random number. Only the scenario builders do, before the simulation starts,
// so one seed always produces one set of inputs.

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}
