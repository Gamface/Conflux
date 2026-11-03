/** Minimal 5-field cron (minute hour day-of-month month day-of-week) with *, lists, ranges and steps. */
export type CronSpec = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean };

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@weekdays": "0 9 * * 1-5",
};
const NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function field(src: string, [lo, hi]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of src.toLowerCase().split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS ? Number(stepS) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let a = lo;
    let b = hi;
    if (range !== "*") {
      const [x, y] = range.split("-").map((v) => (v in NAMES ? NAMES[v] : Number(v)));
      if (!Number.isInteger(x)) throw new Error(`bad cron value "${part}"`);
      a = x;
      b = y === undefined ? (stepS ? hi : x) : y;
    }
    if (a < lo || b > hi + (hi === 6 ? 1 : 0) || a > b) throw new Error(`cron value out of range in "${part}"`);
    for (let v = a; v <= b; v += step) out.add(hi === 6 && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const e = ALIASES[expr.trim()] ?? expr.trim();
  const parts = e.split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields (minute hour day month weekday), got "${expr}"`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, RANGES[i]));
  return { minute, hour, dom, month, dow, domStar: parts[2] === "*", dowStar: parts[4] === "*" };
}

export function cronMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getMinutes()) || !spec.hour.has(d.getHours()) || !spec.month.has(d.getMonth() + 1)) return false;
  const domOk = spec.dom.has(d.getDate());
  const dowOk = spec.dow.has(d.getDay());
  // Standard cron: when both day fields are restricted, either may match.
  if (!spec.domStar && !spec.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

export function nextRun(expr: string, from = new Date()): Date | null {
  const spec = parseCron(expr);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (cronMatches(spec, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

export function describeCron(expr: string): string {
  const n = nextRun(expr);
  return `cron "${expr}"${n ? `, next ${n.toLocaleString()}` : ""}`;
}
