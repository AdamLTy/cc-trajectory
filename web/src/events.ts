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

export interface OtherEvent {
  type: string;
  subtype?: string;
}

export type StreamEvent = InitEvent | AssistantEvent | UserEvent | OtherEvent;

export function isInit(ev: StreamEvent): ev is InitEvent {
  return ev.type === "system" && ev.subtype === "init";
}

export function isAssistant(ev: StreamEvent): ev is AssistantEvent {
  return ev.type === "assistant";
}

export function isUser(ev: StreamEvent): ev is UserEvent {
  return ev.type === "user";
}
