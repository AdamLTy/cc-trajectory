import { isAssistant, isInit, isResult, isServerError, isTask, isUser, type StreamEvent, type TaskEvent, type ToolResultContent } from "./events.ts";

export interface TextItem {
  kind: "text";
  key: string;
  // Arrival order within the run, the time axis for parallel subagent lanes.
  seq: number;
  text: string;
  parentId: string | null;
}

export interface ToolItem {
  kind: "tool";
  key: string;
  seq: number;
  id: string;
  name: string;
  input: Record<string, unknown>;
  parentId: string | null;
  // The assistant message that requested the call; calls requested together in one message run in parallel.
  messageId: string;
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

// Items keyed by the tool call that spawned them; null holds the main agent's items.
export type ChildMap = Map<string | null, Item[]>;

// Groups a run's items under the Agent/Task call that spawned them (parent_tool_use_id), turning the flat
// event list into a tree. A run without subagents ends up with only top-level items.
export function groupByParent(items: Item[]): ChildMap {
  const toolIds = new Set(items.flatMap((item) => (item.kind === "tool" ? [item.id] : [])));
  const groups: ChildMap = new Map();
  for (const item of items) {
    // An event whose spawning call is not in this run stays visible at the top level instead of being dropped.
    const parent = item.parentId && toolIds.has(item.parentId) ? item.parentId : null;
    const group = groups.get(parent);
    if (group) group.push(item);
    else groups.set(parent, [item]);
  }
  return groups;
}

// Every event under a call (including deeper subagents), in arrival order.
export function descendants(id: string, tree: ChildMap): Item[] {
  const found: Item[] = [];
  const walk = (parent: string) => {
    for (const item of tree.get(parent) ?? []) {
      found.push(item);
      if (item.kind === "tool") walk(item.id);
    }
  };
  walk(id);
  return found.sort((a, b) => a.seq - b.seq);
}

// What the outline names when it asks the dialogue to jump to an item: a call's tool_use id, a text's key.
export function targetOf(item: Item): string {
  return item.kind === "tool" ? item.id : item.key;
}

export function containsTarget(rootId: string, target: string, tree: ChildMap): boolean {
  return descendants(rootId, tree).some((item) => targetOf(item) === target);
}

// The harness's task status is authoritative when present: a background subagent's tool_result
// arrives at launch, long before it finishes. Without it, the call's result marks the end.
export function subagentDone(call: ToolItem, runEnded: boolean): boolean {
  if (runEnded) return true;
  return call.subagent ? call.subagent.status !== "running" : call.result !== undefined;
}

export type Unit = { kind: "item"; item: Item } | { kind: "parallel"; calls: ToolItem[] };

const SPAWNERS = new Set(["Agent", "Task"]);

// Tools that start a subagent (Claude Code renamed Task to Agent; both appear in recordings).
export function isSpawner(name: string): boolean {
  return SPAWNERS.has(name);
}

// Agent/Task calls requested in the same assistant message run at the same time: the model asked for all of
// them at once and the harness started them together. Such a group becomes one unit, placed at its first call.
export function splitParallel(siblings: Item[]): Unit[] {
  const byMessage = new Map<string, ToolItem[]>();
  for (const item of siblings) {
    if (item.kind !== "tool" || !SPAWNERS.has(item.name)) continue;
    byMessage.set(item.messageId, [...(byMessage.get(item.messageId) ?? []), item]);
  }
  const units: Unit[] = [];
  for (const item of siblings) {
    const group = item.kind === "tool" && SPAWNERS.has(item.name) ? byMessage.get(item.messageId) : undefined;
    if (!group || group.length < 2) units.push({ kind: "item", item });
    else if (group[0] === item) units.push({ kind: "parallel", calls: group });
  }
  return units;
}

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
  // The prompt typed for a live run (recordings do not contain it).
  prompt?: string;
  // A live run is shown as soon as it is requested; its init event fills in the session details.
  awaitingInit?: boolean;
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

// "start" opens a live run when its prompt is sent (resumed: the request carries a session id to continue).
// "end" is dispatched when the event stream closes, with an error if the request itself failed.
export type Action =
  | { type: "reset" }
  | { type: "start"; prompt: string; resumed: boolean }
  | { type: "event"; event: StreamEvent }
  | { type: "end"; error?: string };

export function reducer(state: Trajectory, action: Action): Trajectory {
  if (action.type === "reset") return emptyTrajectory;
  if (action.type === "start") {
    const run = newRun(state.runs.length + 1, { prompt: action.prompt, resumed: action.resumed, awaitingInit: true });
    return { ...state, runs: [...state.runs, run] };
  }
  if (action.type === "end") return endStream(state, action.error);
  return applyEvent(state, action.event);
}

function newRun(index: number, fields: Partial<Run> = {}): Run {
  return { index, sessionId: "", model: "", cwd: "", items: [], status: "running", resumed: false, ...fields };
}

// A run that is still running when the stream closes never got its result event, so it failed.
// If nothing arrived at all, a placeholder run carries the failure so it is still visible.
// A failure the server already reported is kept, since it says more than "the stream ended".
function endStream(state: Trajectory, error?: string): Trajectory {
  const failure = error
    ? { kind: "request failed", message: error }
    : { kind: "stream ended", message: "The event stream ended before the run's result event arrived." };
  if (state.runs.length === 0) return { ...state, runs: [newRun(1, { status: "failed", failure })] };
  const runs = state.runs.map((run) =>
    run.status === "running" ? { ...run, status: "failed" as const, failure: run.failure ?? failure, awaitingInit: false } : run,
  );
  return { ...state, runs };
}

function applyEvent(state: Trajectory, ev: StreamEvent): Trajectory {
  const eventCount = state.eventCount + 1;

  // Each init event starts a new run (a resumed session prints a fresh init). A live run that is
  // waiting for its init takes it instead; a second init in the same stream (the harness continuing
  // after a background task) still opens a run of its own.
  if (isInit(ev)) {
    const last = state.runs.at(-1);
    const seenSession = state.runs.some((r) => r.sessionId === ev.session_id);
    const details = { sessionId: ev.session_id, model: ev.model, cwd: ev.cwd };
    if (last?.awaitingInit) {
      const filled: Run = { ...last, ...details, resumed: last.resumed || seenSession, awaitingInit: false };
      return { runs: [...state.runs.slice(0, -1), filled], eventCount };
    }
    const run = newRun(state.runs.length + 1, { ...details, resumed: seenSession });
    return { runs: [...state.runs, run], eventCount };
  }

  // The server could not start the run (e.g. a bad working directory) or claude died before a result.
  if (isServerError(ev)) {
    const runs = state.runs.length > 0 ? state.runs : [newRun(1)];
    const last = runs[runs.length - 1];
    const failed: Run = { ...last, status: "failed", awaitingInit: false, failure: { kind: "error", message: ev.message ?? "unknown error" } };
    return { runs: [...runs.slice(0, -1), failed], eventCount };
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
    const messageId = ev.message.id;
    for (const block of ev.message.content) {
      const seq = items.length;
      const key = `${last.index}:${seq}`;
      if (block.type === "text" && block.text.trim()) {
        items.push({ kind: "text", key, seq, text: block.text, parentId });
      } else if (block.type === "tool_use") {
        items.push({ kind: "tool", key, seq, id: block.id, name: block.name, input: block.input ?? {}, parentId, messageId });
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
