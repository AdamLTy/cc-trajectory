import { isAssistant, isInit, isResult, isUser, type StreamEvent, type ToolResultContent } from "./events.ts";

export interface TextItem {
  kind: "text";
  key: string;
  text: string;
  parentId: string | null;
}

export interface ToolItem {
  kind: "tool";
  key: string;
  id: string;
  name: string;
  input: Record<string, unknown>;
  parentId: string | null;
  result?: ToolResult;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

export type Item = TextItem | ToolItem;

export type RunStatus = "running" | "finished" | "failed";

export interface Run {
  index: number;
  sessionId: string;
  model: string;
  cwd: string;
  items: Item[];
  status: RunStatus;
  failure?: { kind: string; message: string };
  // True when an earlier run had the same session id, i.e. this run continues that conversation.
  resumed: boolean;
  // Who started the run when it was not a prompt, from result.origin (e.g. "task-notification").
  origin?: string;
}

export interface Trajectory {
  runs: Run[];
  eventCount: number;
}

export const emptyTrajectory: Trajectory = { runs: [], eventCount: 0 };

// "end" is dispatched when the event stream closes, with an error if the request itself failed.
export type Action = { type: "reset" } | { type: "event"; event: StreamEvent } | { type: "end"; error?: string };

export function reducer(state: Trajectory, action: Action): Trajectory {
  if (action.type === "reset") return emptyTrajectory;
  if (action.type === "end") return endStream(state, action.error);
  return applyEvent(state, action.event);
}

function newRun(index: number, fields: Partial<Run> = {}): Run {
  return { index, sessionId: "", model: "", cwd: "", items: [], status: "running", resumed: false, ...fields };
}

// A run that is still running when the stream closes never got its result event, so it failed.
// If nothing arrived at all, a placeholder run carries the failure so it is still visible.
function endStream(state: Trajectory, error?: string): Trajectory {
  const failure = error
    ? { kind: "request failed", message: error }
    : { kind: "stream ended", message: "The event stream ended before the run's result event arrived." };
  if (state.runs.length === 0) return { ...state, runs: [newRun(1, { status: "failed", failure })] };
  const runs = state.runs.map((run) => (run.status === "running" ? { ...run, status: "failed" as const, failure } : run));
  return { ...state, runs };
}

function applyEvent(state: Trajectory, ev: StreamEvent): Trajectory {
  const eventCount = state.eventCount + 1;

  // Each init event starts a new run (a resumed session prints a fresh init).
  if (isInit(ev)) {
    const resumed = state.runs.some((r) => r.sessionId === ev.session_id);
    const run = newRun(state.runs.length + 1, { sessionId: ev.session_id, model: ev.model, cwd: ev.cwd, resumed });
    return { runs: [...state.runs, run], eventCount };
  }

  // The result event closes the current run: is_error decides finished vs failed.
  if (isResult(ev) && state.runs.length > 0) {
    const last = { ...state.runs[state.runs.length - 1], origin: ev.origin?.kind };
    const ended: Run = ev.is_error
      ? { ...last, status: "failed", failure: { kind: ev.subtype, message: ev.errors?.join("\n") || ev.subtype } }
      : { ...last, status: "finished" };
    return { runs: [...state.runs.slice(0, -1), ended], eventCount };
  }

  // Assistant events carry one content block each; text and tool_use become items, thinking is skipped.
  // Partial-message stream_events are ignored because the complete assistant event always follows them.
  if (isAssistant(ev)) {
    const runs = state.runs.length > 0 ? state.runs : [newRun(1)];
    const last = runs[runs.length - 1];
    const items = [...last.items];
    const parentId = ev.parent_tool_use_id ?? null;
    for (const block of ev.message.content) {
      const key = `${last.index}:${items.length}`;
      if (block.type === "text" && block.text.trim()) {
        items.push({ kind: "text", key, text: block.text, parentId });
      } else if (block.type === "tool_use") {
        items.push({ kind: "tool", key, id: block.id, name: block.name, input: block.input ?? {}, parentId });
      }
    }
    return { runs: [...runs.slice(0, -1), { ...last, items }], eventCount };
  }

  // Tool results come back in user events; attach each one to the call with the same tool_use_id.
  if (isUser(ev) && Array.isArray(ev.message.content)) {
    let runs = state.runs;
    for (const block of ev.message.content) {
      if (block.type === "tool_result") runs = attachResult(runs, block as ToolResultContent);
    }
    return { runs, eventCount };
  }

  return { ...state, eventCount };
}

// Searches the newest run first, since a result almost always answers a call from the current run.
function attachResult(runs: Run[], block: ToolResultContent): Run[] {
  const result: ToolResult = { text: resultText(block.content), isError: block.is_error === true };
  for (let r = runs.length - 1; r >= 0; r--) {
    const i = runs[r].items.findIndex((item) => item.kind === "tool" && item.id === block.tool_use_id);
    if (i === -1) continue;
    const items = [...runs[r].items];
    items[i] = { ...(items[i] as ToolItem), result };
    return runs.map((run, k) => (k === r ? { ...run, items } : run));
  }
  return runs;
}

function resultText(content: ToolResultContent["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text ?? "";
      if (part.type === "tool_reference") return `loaded tool: ${part.tool_name}`;
      if (part.type === "image") return "[image]";
      return `[${part.type}]`;
    })
    .join("\n");
}
