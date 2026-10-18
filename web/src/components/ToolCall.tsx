import { useRef, useState, type ReactNode } from "react";
import { isSpawner, type ToolItem } from "../trajectory.ts";
import { formatElapsed, useNow } from "../useNow.ts";
import { DiffView, diffStats, editHunks } from "./DiffView.tsx";
import { ReadResult, TaskView } from "./RichResults.tsx";
import { SubagentReport } from "./SubagentReport.tsx";
import { looksFailed, ToolResultView } from "./ToolResult.tsx";
import { useJumpTarget } from "./useJumpTarget.ts";

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

export function toolCategory(name: string): string {
  return CATEGORIES[name] ?? "other";
}

interface ToolCallProps {
  item: ToolItem;
  cwd: string;
  runEnded: boolean;
  // Set when the outline asked to jump to this call; the call scrolls itself into view and reports back.
  focused?: boolean;
  onFocused?: () => void;
  children?: ReactNode;
}

// children (a subagent's nested events) render between the call and its result,
// since the result of an Agent call is the report the subagent hands back.
// Edits show their change as a diff right under the call, task tools their checklist or task; the raw input
// stays one click away.
export function ToolCall({ item, cwd, runEnded, focused, onFocused, children }: ToolCallProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const failed = item.result?.isError === true;
  const hunks = editHunks(item.name, item.input);
  useJumpTarget(ref, focused, onFocused);

  return (
    <div ref={ref} id={`call-${item.id}`} data-target={item.id} className={failed ? "item tool tool-failed" : "item tool"}>
      <button className="tool-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`badge badge-${toolCategory(item.name)}`}>{item.name}</span>
        <span className="tool-summary">{summarize(item, cwd)}</span>
        {hunks && <DiffStat hunks={hunks} />}
        <CallStatus item={item} runEnded={runEnded} />
        <span className="chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && <pre className="tool-input">{JSON.stringify(item.input, null, 2)}</pre>}
      {hunks && <DiffView hunks={hunks} />}
      <TaskView name={item.name} input={item.input} />
      {children}
      {item.result && <CallResult item={item} />}
    </div>
  );
}

// An Agent call's result is the subagent's report, a file Read's is code. A failed command keeps its end in view,
// where the error is; that includes command output that reports a failure while the command itself exits 0
// (`pytest | tail`).
export function CallResult({ item, compact }: { item: ToolItem; compact?: boolean }) {
  if (!item.result) return null;
  if (isSpawner(item.name)) return <SubagentReport result={item.result} compact={compact} />;
  const limits = compact ? { foldedLines: 6, foldedLineChars: 90 } : {};
  if (item.name === "Read" && !item.result.isError) {
    const filePath = typeof item.input.file_path === "string" ? item.input.file_path : "";
    return <ReadResult result={item.result} filePath={filePath} {...limits} />;
  }
  const isBash = item.name === "Bash";
  const tail = item.result.isError || (isBash && looksFailed(item.result.text));
  return <ToolResultView result={item.result} tail={tail} highlight={isBash} {...limits} />;
}

function DiffStat({ hunks }: { hunks: NonNullable<ReturnType<typeof editHunks>> }) {
  const { added, removed } = diffStats(hunks);
  return (
    <span className="diff-stat">
      <span className="diff-stat-add">+{added}</span> <span className="diff-stat-del">−{removed}</span>
    </span>
  );
}

// Pending from the moment the tool_use arrives until its tool_result attaches, with a live timer.
// A call still without a result after its run ended will never get one, so it stops showing as pending.
// A finished call shows how long the tool took, once that is long enough to matter.
export function CallStatus({ item, runEnded }: { item: ToolItem; runEnded: boolean }) {
  const now = useNow();
  if (item.result) {
    const took = item.endedAt !== undefined ? item.endedAt - item.startedAt : 0;
    return (
      <span className="call-done">
        {took >= 100 && <span className="call-took">{formatElapsed(took)}</span>}
        {item.result.isError ? <span className="fail-mark">failed</span> : <span className="call-ok" aria-label="succeeded">✓</span>}
      </span>
    );
  }
  if (runEnded) return <span className="call-none">no result</span>;
  return (
    <span className="call-pending">
      <span className="spinner" aria-hidden /> pending · {formatElapsed(now - item.startedAt)}
    </span>
  );
}

// One line that says what the call is about, so the full input JSON can stay folded.
export function summarize({ name, input }: ToolItem, cwd: string): string {
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
