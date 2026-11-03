/**
 * One snapshot vocabulary for every surface: `[@e5] button "Submit"` lines, as agent-computer-use
 * prints for native apps. Browser snapshots use the same shape, so the model learns one loop:
 * snapshot → act on a ref → re-snapshot to verify. Zero vision tokens, deterministic refs.
 *
 * The latest snapshot per coworker/surface is kept server-side; the gateway resolves a ref to the
 * real element (role + name) from it before policy is evaluated. A model cannot evade "never click
 * Pay" by calling the button something else.
 */
export type ElementInfo = { ref: string; role: string; name: string; type?: string; value?: string };

const LINE = /\[@(e\d+)\]\s+([\w-]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/;

export function parseSnapshot(text: string): Map<string, ElementInfo> {
  const out = new Map<string, ElementInfo>();
  for (const line of text.split("\n")) {
    const m = line.match(LINE);
    if (!m) continue;
    const rest = m[4] ?? "";
    out.set(m[1], {
      ref: m[1],
      role: m[2],
      name: (m[3] ?? "").replace(/\\"/g, '"'),
      type: rest.match(/type=(\S+)/)?.[1],
      value: rest.match(/value="([^"]*)"/)?.[1],
    });
  }
  return out;
}

export class SnapshotCache {
  private snaps = new Map<string, { at: number; elements: Map<string, ElementInfo>; url?: string }>();

  set(key: string, text: string, url?: string): void {
    this.snaps.set(key, { at: Date.now(), elements: parseSnapshot(text), url });
  }

  element(key: string, ref: string): ElementInfo | undefined {
    return this.snaps.get(key)?.elements.get(ref.replace(/^@/, ""));
  }

  has(key: string): boolean {
    return this.snaps.has(key);
  }
}
