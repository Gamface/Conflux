import type { Tool } from "./types.ts";
import type { Runtime } from "../runtime.ts";
import type { Coworker } from "../config.ts";

function globToRegex(glob: string): RegExp {
  return new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
}

/**
 * Does a coworker's grant list cover this tool?
 *   "*"               everything
 *   "toolset:web"     a whole toolset
 *   "browser_*"       glob on tool names
 *   "!terminal"       explicit exclusion (wins over any grant)
 */
export function isGranted(grants: string[], tool: Pick<Tool, "name" | "toolset">): boolean {
  let granted = false;
  for (const g of grants) {
    const neg = g.startsWith("!");
    const pat = neg ? g.slice(1) : g;
    const hit = pat.startsWith("toolset:") ? pat.slice(8) === tool.toolset : globToRegex(pat).test(tool.name);
    if (hit && neg) return false;
    if (hit) granted = true;
  }
  return granted;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(...tools: Tool[]): void {
    for (const t of tools) this.tools.set(t.name, t);
  }

  unregister(predicate: (t: Tool) => boolean): void {
    for (const [k, t] of this.tools) if (predicate(t)) this.tools.delete(k);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return [...this.tools.values()];
  }

  /** The tools a coworker is offered: granted AND whose backing service is available. */
  forCoworker(coworker: Coworker, rt: Runtime, extraGrants?: string[]): Tool[] {
    const grants = extraGrants ?? coworker.tools;
    return this.all().filter((t) => isGranted(grants, t) && (t.available ? safeAvailable(t, rt) : true));
  }
}

function safeAvailable(t: Tool, rt: Runtime): boolean {
  try {
    return t.available!(rt);
  } catch {
    return false;
  }
}
