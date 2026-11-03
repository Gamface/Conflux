/**
 * AG-UI compatible event stream.
 *
 * Every run (chat turn, background task, workflow) emits these events. Because they follow the
 * AG-UI protocol (https://docs.ag-ui.com), any AG-UI client — CopilotKit, the bundled web app, the
 * CLI — can render a Conflux coworker, and any AG-UI agent can be dropped in as a coworker.
 */

export type AgUiEvent =
  | { type: "RUN_STARTED"; threadId: string; runId: string }
  | { type: "RUN_FINISHED"; threadId: string; runId: string; result?: unknown }
  | { type: "RUN_ERROR"; message: string; code?: string }
  | { type: "STEP_STARTED"; stepName: string }
  | { type: "STEP_FINISHED"; stepName: string }
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string }
  | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string; parentMessageId?: string }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; toolCallId: string }
  | { type: "TOOL_CALL_RESULT"; toolCallId: string; messageId: string; content: string; role: "tool" }
  | { type: "STATE_SNAPSHOT"; snapshot: Record<string, unknown> }
  | { type: "CUSTOM"; name: string; value: unknown };

export type Emit = (event: AgUiEvent) => void;

export const noopEmit: Emit = () => {};

/** Process-wide bus so the UI's activity feed sees background work (tasks, schedules, approvals). */
export class EventBus {
  private listeners = new Set<(e: { channel: string; event: AgUiEvent | Record<string, unknown> }) => void>();

  subscribe(fn: (e: { channel: string; event: AgUiEvent | Record<string, unknown> }) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(channel: string, event: AgUiEvent | Record<string, unknown>): void {
    for (const fn of this.listeners) {
      try {
        fn({ channel, event });
      } catch {
        /* a broken listener must never break a run */
      }
    }
  }
}

export function newId(prefix = ""): string {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}
