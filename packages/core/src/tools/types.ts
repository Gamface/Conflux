import type { Emit } from "../events.ts";
import type { Runtime } from "../runtime.ts";
import type { Coworker } from "../config.ts";

/**
 * What an action does, independent of which tool performs it. Policies are usually written against
 * effects ("anything destructive needs approval") so that a new tool is governed from day one.
 */
export type Effect = "read" | "write" | "external" | "execute" | "destructive" | "learn";

export type Initiator = "user" | "task" | "schedule" | "review" | "workflow" | "subagent" | "channel";

export type JsonSchema = {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolContext = {
  runId: string;
  threadId: string;
  coworker: Coworker;
  initiator: Initiator;
  emit: Emit;
  signal: AbortSignal;
  rt: Runtime;
  /** Delegation depth; subagents cannot recurse forever. */
  depth: number;
  /** Called while the run is blocked on a human (approval or clarifying question). */
  onWaiting?: (waiting: boolean) => void;
};

export type ToolResult = {
  /** What the model sees. */
  content: string;
  /** Structured payload for generative UI cards (browser screenshot, plan, page, workflow trace). */
  data?: unknown;
  /** Which card the UI should render for this result. */
  ui?: string;
  isError?: boolean;
};

export type Tool = {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Toolset this belongs to; coworkers are granted toolsets or individual tools. */
  toolset: string;
  effect: Effect | ((args: any) => Effect);
  /**
   * Service gate (Hermes `check_fn`): is the backing service reachable / configured at all?
   * Unavailable tools are not offered to the model.
   */
  available?: (rt: Runtime) => boolean;
  /**
   * Extra policy attributes resolved server-side (e.g. the element behind a browser ref, the
   * page host). Never taken from the model's own claims — see OpenBot's gateway design.
   */
  resolveContext?: (args: any, ctx: ToolContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
  run: (args: any, ctx: ToolContext) => Promise<ToolResult | string>;
};

export function toolEffect(tool: Tool, args: unknown): Effect {
  return typeof tool.effect === "function" ? tool.effect(args) : tool.effect;
}
