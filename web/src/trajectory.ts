import { isAssistant, isInit, isUser, type StreamEvent, type ToolResultContent } from "./events.ts";

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

export interface Run {
  index: number;
  sessionId: string;
  model: string;
  cwd: string;
  items: Item[];
}

export interface Trajectory {
  runs: Run[];
  eventCount: number;
}

export const emptyTrajectory: Trajectory = { runs: [], eventCount: 0 };

export type Action = { type: "reset" } | { type: "event"; event: StreamEvent };

export function reducer(state: Trajectory, action: Action): Trajectory {
  if (action.type === "reset") return emptyTrajectory;
  return applyEvent(state, action.event);
}

function applyEvent(state: Trajectory, ev: StreamEvent): Trajectory {
  const eventCount = state.eventCount + 1;

  // Each init event starts a new run (a resumed session prints a fresh init).
  if (isInit(ev)) {
    const run: Run = { index: state.runs.length + 1, sessionId: ev.session_id, model: ev.model, cwd: ev.cwd, items: [] };
    return { runs: [...state.runs, run], eventCount };
  }

  // Assistant events carry one content block each; text and tool_use become items, thinking is skipped.
  // Partial-message stream_events are ignored because the complete assistant event always follows them.
  if (isAssistant(ev)) {
    const runs = state.runs.length > 0 ? state.runs : [{ index: 1, sessionId: "", model: "", cwd: "", items: [] }];
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
