import { useState, type ReactNode } from "react";
import type { ToolItem } from "../trajectory.ts";
import { ToolResultView } from "./ToolResult.tsx";

const CATEGORIES: Record<string, string> = {
  Read: "read",
  Grep: "read",
  Glob: "read",
  LS: "read",
  Edit: "write",
  MultiEdit: "write",
  Write: "write",
  NotebookEdit: "write",
  Bash: "exec",
  BashOutput: "exec",
  KillShell: "exec",
  Agent: "agent",
  Task: "agent",
};

// children (a subagent's nested events) render between the call and its result,
// since the result of an Agent call is the report the subagent hands back.
export function ToolCall({ item, cwd, runEnded, children }: { item: ToolItem; cwd: string; runEnded: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const category = CATEGORIES[item.name] ?? "other";
  const failed = item.result?.isError === true;
  return (
    <div className={failed ? "item tool tool-failed" : "item tool"}>
      <button className="tool-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`badge badge-${category}`}>{item.name}</span>
        <span className="tool-summary">{summarize(item, cwd)}</span>
        <CallStatus item={item} runEnded={runEnded} />
        <span className="chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && <pre className="tool-input">{JSON.stringify(item.input, null, 2)}</pre>}
      {children}
      {item.result && <ToolResultView result={item.result} />}
    </div>
  );
}

// Pending from the moment the tool_use arrives until its tool_result attaches.
// A call still without a result after its run ended will never get one, so it stops showing as pending.
function CallStatus({ item, runEnded }: { item: ToolItem; runEnded: boolean }) {
  if (item.result) {
    return item.result.isError ? <span className="fail-mark">failed</span> : <span className="call-ok" aria-label="succeeded">✓</span>;
  }
  if (runEnded) return <span className="call-none">no result</span>;
  return (
    <span className="call-pending">
      <span className="spinner" aria-hidden /> pending
    </span>
  );
}

// One line that says what the call is about, so the full input JSON can stay folded.
function summarize({ name, input }: ToolItem, cwd: string): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (name) {
    case "Bash":
      return firstLine(str("command"));
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return relativize(str("file_path") || str("notebook_path"), cwd);
    case "Grep":
    case "Glob":
      return str("pattern");
    case "Agent":
    case "Task":
      return str("description");
    case "WebFetch":
      return str("url");
    case "WebSearch":
    case "ToolSearch":
      return str("query");
    case "TaskCreate":
      return str("subject");
  }
  return JSON.stringify(input).slice(0, 160);
}

function firstLine(text: string): string {
  const [first, ...rest] = text.split("\n");
  return rest.length > 0 ? `${first} …` : first;
}

// macOS reports the same temp dir as both /var/... and /private/var/..., so try both spellings of cwd.
function relativize(file: string, cwd: string): string {
  if (!cwd) return file;
  const prefixes = [cwd, cwd.replace(/^\/private/, ""), `/private${cwd}`];
  for (const prefix of prefixes) {
    if (file.startsWith(prefix + "/")) return file.slice(prefix.length + 1);
  }
  return file;
}
