import { isAssistant, isInit, isResult, isTask, isUser, type StreamEvent, type TaskEvent, type ToolResultContent } from "./events.ts";

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
  // Set on an Agent/Task call once the harness reports the subagent it spawned.
  subagent?: Subagent;
}

export interface Subagent {
  taskId: string;
  type?: string;
  background: boolean;
  // "running" until task_updated / task_notification report e.g. "completed".
  status: string;
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
  stats?: RunStats;
}

export interface RunStats {
  // This run's own cost; undefined when the previous run of a resumed session is not in view.
  runCostUsd?: number;
  sessionCostUsd: number;
  durationMs: number;
  numTurns: number;
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
    const current = state.runs[state.runs.length - 1];
    const stats: RunStats = {
      runCostUsd: runCost(state.runs.slice(0, -1), current, ev.total_cost_usd),
      sessionCostUsd: ev.total_cost_usd,
      durationMs: ev.duration_ms,
      numTurns: ev.num_turns,
    };
    const last = { ...current, origin: ev.origin?.kind, stats };
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

  if (isTask(ev)) return { runs: updateSubagent(state.runs, ev), eventCount };

  return { ...state, eventCount };
}

// task_started announces the subagent behind an Agent/Task call; task_updated and task_notification report
// when it ends. For a background subagent this is the only signal, since its tool_result returns at launch.
function updateSubagent(runs: Run[], ev: TaskEvent): Run[] {
  if (ev.subtype === "task_started") {
    const subagent: Subagent = { taskId: ev.task_id, type: ev.subagent_type, background: ev.is_backgrounded === true, status: "running" };
    return updateTool(runs, (t) => t.id === ev.tool_use_id, (t) => ({ ...t, subagent }));
  }
  const status = ev.subtype === "task_updated" ? ev.patch?.status : ev.status;
  if (!status) return runs;
  const matches = (t: ToolItem) => (ev.tool_use_id ? t.id === ev.tool_use_id : t.subagent?.taskId === ev.task_id);
  return updateTool(runs, matches, (t) => ({ ...t, subagent: { ...(t.subagent ?? { taskId: ev.task_id, background: false }), status } }));
}

// total_cost_usd keeps counting across a session, so this run's share is the difference from the
// previous run of the same session. The first run of a session starts from zero.
function runCost(earlier: Run[], run: Run, sessionTotal: number): number | undefined {
  const previous = earlier.findLast((r) => r.sessionId === run.sessionId && r.stats);
  if (previous?.stats) return sessionTotal - previous.stats.sessionCostUsd;
  return run.resumed ? undefined : sessionTotal;
}

function attachResult(runs: Run[], block: ToolResultContent): Run[] {
  const result: ToolResult = { text: resultText(block.content), isError: block.is_error === true };
  return updateTool(runs, (t) => t.id === block.tool_use_id, (t) => ({ ...t, result }));
}

// Replaces the first tool call matching pred. Searches the newest run first, since a result or
// lifecycle event almost always belongs to a call from the current run.
function updateTool(runs: Run[], pred: (t: ToolItem) => boolean, update: (t: ToolItem) => ToolItem): Run[] {
  for (let r = runs.length - 1; r >= 0; r--) {
    const i = runs[r].items.findIndex((item) => item.kind === "tool" && pred(item));
    if (i === -1) continue;
    const items = [...runs[r].items];
    items[i] = update(items[i] as ToolItem);
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
