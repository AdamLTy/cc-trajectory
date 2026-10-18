import {
  isAssistant,
  isInit,
  isPartial,
  isResult,
  isServerError,
  isServerPrompt,
  isTask,
  isThinking,
  isUser,
  type StreamEvent,
  type TaskEvent,
  type ToolResultContent,
} from "./events.ts";

export interface TextItem {
  kind: "text";
  key: string;
  // Arrival order within the run, the time axis for parallel subagent lanes.
  seq: number;
  text: string;
  parentId: string | null;
  // Text still arriving piece by piece (partial messages); the complete assistant event finalizes it.
  streaming?: boolean;
  messageId?: string;
  blockIndex?: number;
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
  // When the tool_use and its tool_result arrived (ms), for the per-call timers.
  startedAt: number;
  endedAt?: number;
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
  // The prompt typed for a live run (Claude Code's stream does not contain it).
  prompt?: string;
  // A live run is shown as soon as it is requested; its init event fills in the session details.
  awaitingInit?: boolean;
  // When the run was requested and when it ended (ms), for the live run timer.
  startedAt: number;
  endedAt?: number;
  // What the model has been doing since its last visible output, for the "thinking…" line.
  activity: Activity;
}

export interface Activity {
  kind: "thinking" | "waiting";
  since: number;
  // The harness's estimate of thinking tokens so far, from system/thinking_tokens.
  tokens?: number;
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

// Every action that moves time forward carries `at` (ms), so timers come from the actions and the reducer
// stays pure. "start" opens a live run when its prompt is sent (resumed: the request carries a session id to
// continue). "end" is dispatched when the event stream closes: with an error if the request itself failed,
// or stopped when the reader pressed Stop.
export type Action =
  | { type: "reset" }
  | { type: "start"; prompt: string; resumed: boolean; at: number }
  | { type: "event"; event: StreamEvent; at: number }
  | { type: "end"; error?: string; stopped?: boolean; at: number };

export function reducer(state: Trajectory, action: Action): Trajectory {
  if (action.type === "reset") return emptyTrajectory;
  if (action.type === "start") return startRun(state, action.prompt, action.resumed, action.at);
  if (action.type === "end") return endStream(state, action);
  return applyEvent(state, action.event, action.at);
}

function newRun(index: number, at: number, fields: Partial<Run> = {}): Run {
  return {
    index,
    sessionId: "",
    model: "",
    cwd: "",
    items: [],
    status: "running",
    resumed: false,
    startedAt: at,
    activity: { kind: "waiting", since: at },
    ...fields,
  };
}

function startRun(state: Trajectory, prompt: string, resumed: boolean, at: number): Trajectory {
  const run = newRun(state.runs.length + 1, at, { prompt, resumed, awaitingInit: true });
  return { ...state, runs: [...state.runs, run] };
}

// A run that is still running when the stream closes never got its result event, so it failed.
// If nothing arrived at all, a placeholder run carries the failure so it is still visible.
// A failure the server already reported is kept, since it says more than "the stream ended".
function endStream(state: Trajectory, action: { error?: string; stopped?: boolean; at: number }): Trajectory {
  const failure = action.stopped
    ? { kind: "stopped", message: "Stopped by user" }
    : action.error
      ? { kind: "request failed", message: action.error }
      : { kind: "stream ended", message: "The event stream ended before the run's result event arrived." };
  if (state.runs.length === 0) return { ...state, runs: [newRun(1, action.at, { status: "failed", failure, endedAt: action.at })] };
  const runs = state.runs.map((run) => {
    const settled = { ...run, items: finalizeText(run.items) };
    if (run.status !== "running") return settled;
    return { ...settled, status: "failed" as const, failure: run.failure ?? failure, awaitingInit: false, endedAt: action.at };
  });
  return { ...state, runs };
}

// Text left half-streamed when a run ends stays as it is, no longer marked as arriving.
function finalizeText(items: Item[]): Item[] {
  return items.some((item) => item.kind === "text" && item.streaming)
    ? items.map((item) => (item.kind === "text" && item.streaming ? { ...item, streaming: false } : item))
    : items;
}

function applyEvent(state: Trajectory, ev: StreamEvent, at: number): Trajectory {
  const eventCount = state.eventCount + 1;
  const withRuns = (runs: Run[]) => ({ runs, eventCount });

  // A recording replays the prompt that started each live run.
  if (isServerPrompt(ev)) return { ...startRun(state, ev.prompt ?? "", ev.resumed === true, at), eventCount };

  // Each init event starts a new run (a resumed session prints a fresh init). A live run that is
  // waiting for its init takes it instead; a second init in the same stream (the harness continuing
  // after a background task) still opens a run of its own.
  if (isInit(ev)) {
    const last = state.runs.at(-1);
    const seenSession = state.runs.some((r) => r.sessionId === ev.session_id);
    const details = { sessionId: ev.session_id, model: ev.model, cwd: ev.cwd };
    if (last?.awaitingInit) {
      return withRuns(replaceLast(state.runs, { ...last, ...details, resumed: last.resumed || seenSession, awaitingInit: false }));
    }
    return withRuns([...state.runs, newRun(state.runs.length + 1, at, { ...details, resumed: seenSession })]);
  }

  const runs = state.runs.length > 0 ? state.runs : [newRun(1, at)];
  const last = runs[runs.length - 1];

  // The server could not start the run (e.g. a bad working directory) or claude died before a result.
  if (isServerError(ev)) {
    const failure = { kind: ev.stopped ? "stopped" : "error", message: ev.message ?? "unknown error" };
    return withRuns(replaceLast(runs, { ...last, status: "failed", awaitingInit: false, failure, endedAt: at }));
  }

  // The result event closes the current run: is_error decides finished vs failed.
  if (isResult(ev)) {
    const stats: RunStats = {
      runCostUsd: runCost(runs.slice(0, -1), last, ev.total_cost_usd),
      sessionCostUsd: ev.total_cost_usd,
      durationMs: ev.duration_ms,
      numTurns: ev.num_turns,
    };
    const closed = { ...last, items: finalizeText(last.items), origin: ev.origin?.kind, stats, endedAt: at };
    const ended: Run = ev.is_error
      ? { ...closed, status: "failed", failure: { kind: ev.subtype, message: ev.errors?.join("\n") || ev.subtype } }
      : { ...closed, status: "finished" };
    return withRuns(replaceLast(runs, ended));
  }

  // The model is thinking: no visible output yet, only the harness's running token estimate.
  if (isThinking(ev)) {
    const since = last.activity.kind === "thinking" ? last.activity.since : at;
    return withRuns(replaceLast(runs, { ...last, activity: { kind: "thinking", since, tokens: ev.estimated_tokens } }));
  }

  // Partial messages: a text block opens as an empty streaming item and grows with each delta.
  if (isPartial(ev)) {
    const inner = ev.event;
    const messageId = ev.api_message_id;
    if (!messageId) return { ...state, eventCount };
    if (inner.type === "content_block_start" && inner.content_block?.type === "text") {
      const seq = last.items.length;
      const item: TextItem = {
        kind: "text",
        key: `${last.index}:${seq}`,
        seq,
        text: "",
        parentId: ev.parent_tool_use_id ?? null,
        streaming: true,
        messageId,
        blockIndex: inner.index,
      };
      return withRuns(replaceLast(runs, { ...last, items: [...last.items, item], activity: { kind: "waiting", since: at } }));
    }
    if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta" && inner.delta.text) {
      const delta = inner.delta.text;
      const items = last.items.map((item) =>
        item.kind === "text" && item.streaming && item.messageId === messageId && item.blockIndex === inner.index
          ? { ...item, text: item.text + delta }
          : item,
      );
      return withRuns(replaceLast(runs, { ...last, items }));
    }
    return { ...state, eventCount };
  }

  // Assistant events carry one content block each; text and tool_use become items, thinking is skipped.
  // A text that was already streaming in is finalized with the complete text instead of added again.
  if (isAssistant(ev)) {
    let items = [...last.items];
    const parentId = ev.parent_tool_use_id ?? null;
    const messageId = ev.message.id;
    for (const block of ev.message.content) {
      const seq = items.length;
      const key = `${last.index}:${seq}`;
      if (block.type === "text") {
        const streamed = items.findIndex((item) => item.kind === "text" && item.streaming && item.messageId === messageId);
        if (streamed !== -1) {
          items = block.text.trim()
            ? items.map((item, i) => (i === streamed ? { ...(item as TextItem), text: block.text, streaming: false } : item))
            : items.filter((_, i) => i !== streamed);
        } else if (block.text.trim()) {
          items.push({ kind: "text", key, seq, text: block.text, parentId });
        }
      } else if (block.type === "tool_use") {
        items.push({ kind: "tool", key, seq, id: block.id, name: block.name, input: block.input ?? {}, parentId, messageId, startedAt: at });
      }
    }
    return withRuns(replaceLast(runs, { ...last, items, activity: { kind: "waiting", since: at } }));
  }

  // Tool results come back in user events; attach each one to the call with the same tool_use_id.
  if (isUser(ev) && Array.isArray(ev.message.content)) {
    let updated = state.runs;
    for (const block of ev.message.content) {
      if (block.type === "tool_result") updated = attachResult(updated, block as ToolResultContent, at);
    }
    const current = updated.at(-1);
    if (current) updated = replaceLast(updated, { ...current, activity: { kind: "waiting", since: at } });
    return withRuns(updated);
  }

  if (isTask(ev)) return withRuns(updateSubagent(state.runs, ev));

  return { ...state, eventCount };
}

function replaceLast(runs: Run[], run: Run): Run[] {
  return [...runs.slice(0, -1), run];
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

function attachResult(runs: Run[], block: ToolResultContent, at: number): Run[] {
  const result: ToolResult = { text: resultText(block.content), isError: block.is_error === true };
  return updateTool(runs, (t) => t.id === block.tool_use_id, (t) => ({ ...t, result, endedAt: at }));
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
