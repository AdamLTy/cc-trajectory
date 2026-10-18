// The subset of Claude Code's stream-json events the page reads.
// Anything not listed here is passed through and ignored by the reducer.

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock = TextContent | ToolUseContent | { type: "thinking" | "redacted_thinking" };

export interface InitEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  cwd: string;
  model: string;
}

export interface AssistantEvent {
  type: "assistant";
  message: { id: string; content: ContentBlock[] };
  // The tool call (an Agent/Task call) that spawned the subagent emitting this event; null for the main agent.
  parent_tool_use_id: string | null;
}

// What the model is shown after a tool runs. content is either plain text or a list of blocks
// (text, images, or tool_reference entries naming tools that ToolSearch loaded).
export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content?: string | { type: string; text?: string; tool_name?: string }[];
  is_error?: boolean;
}

export interface UserEvent {
  type: "user";
  message: { content: string | (ToolResultContent | { type: "text"; text: string })[] };
  parent_tool_use_id: string | null;
}

// Printed once when a run ends. is_error marks a failed run (e.g. subtype "error_max_turns").
export interface ResultEvent {
  type: "result";
  subtype: string;
  is_error: boolean;
  errors?: string[];
  // Cumulative across the whole session: a resumed run continues the total of the runs before it.
  total_cost_usd: number;
  // Wall-clock time and model calls of this run only.
  duration_ms: number;
  num_turns: number;
  // Set when the harness started this run itself, e.g. { kind: "task-notification" } after a background task finished.
  origin?: { kind: string } | null;
}

// Subagent lifecycle, emitted by the harness around an Agent/Task call. task_updated carries only the task_id,
// so it is matched to its call through the task_id that task_started announced.
export interface TaskEvent {
  type: "system";
  subtype: "task_started" | "task_updated" | "task_notification";
  task_id: string;
  tool_use_id?: string;
  subagent_type?: string;
  is_backgrounded?: boolean;
  status?: string;
  patch?: { status?: string };
}

export interface OtherEvent {
  type: string;
  subtype?: string;
}

export type StreamEvent = InitEvent | AssistantEvent | UserEvent | ResultEvent | TaskEvent | OtherEvent;

export function isInit(ev: StreamEvent): ev is InitEvent {
  return ev.type === "system" && ev.subtype === "init";
}

export function isAssistant(ev: StreamEvent): ev is AssistantEvent {
  return ev.type === "assistant";
}

export function isUser(ev: StreamEvent): ev is UserEvent {
  return ev.type === "user";
}

export function isResult(ev: StreamEvent): ev is ResultEvent {
  return ev.type === "result";
}

export function isTask(ev: StreamEvent): ev is TaskEvent {
  return ev.type === "system" && (ev.subtype === "task_started" || ev.subtype === "task_updated" || ev.subtype === "task_notification");
}
