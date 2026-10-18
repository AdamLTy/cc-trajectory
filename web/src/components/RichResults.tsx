import { useMemo, useState } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import type { ToolResult } from "../trajectory.ts";
import { ToolResultView } from "./ToolResult.tsx";
import "./rich-results.css";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("typescript", typescript);
// Not mapped to any extension: JSX tags in .tsx/.jsx and HTML inside markdown highlight through it as a sub-language.
hljs.registerLanguage("xml", xml);

const LANGUAGES: Record<string, string> = {
  py: "python",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  md: "markdown",
  css: "css",
};

// The highlight.js language for a file, from its extension; undefined means plain text.
export function languageFor(filePath: string): string | undefined {
  const ext = /\.([^./]+)$/.exec(filePath)?.[1]?.toLowerCase();
  return ext ? LANGUAGES[ext] : undefined;
}

export interface CodeLine {
  // The line number as the harness printed it (a Read with an offset starts past 1).
  n: string;
  code: string;
}

export interface Listing {
  lines: CodeLine[];
  // Lines without a number: notes the harness appended to the file content.
  notes: string[];
}

// Read prints each file line as "<padding><number>\t<code>" (older versions used "→" instead of the tab).
const NUMBERED = /^\s*(\d+)(?:\t|→)(.*)$/;

// Splits a Read result into numbered code lines and the notes around them; null when nothing is numbered
// (an empty file, an image, "file unchanged" notices), so the caller can show it as plain output.
export function parseListing(text: string): Listing | null {
  const lines: CodeLine[] = [];
  const notes: string[] = [];
  for (const raw of text.replace(/\n+$/, "").split("\n")) {
    const match = NUMBERED.exec(raw);
    if (match) lines.push({ n: match[1], code: match[2].replace(/\r$/, "") });
    else if (raw.trim()) notes.push(raw);
  }
  if (lines.length === 0) return null;
  // A file ending in a newline shows one more, empty, numbered line; it is not part of the content.
  if (lines.length > 1 && lines[lines.length - 1].code === "") lines.pop();
  return { lines, notes };
}

interface ReadResultProps {
  result: ToolResult;
  filePath: string;
  foldedLines?: number;
  foldedLineChars?: number;
}

// A successful Read shown as code: line numbers in a gutter, syntax colors by file extension, folded like
// any other result. Output that is not a numbered listing falls back to the plain result view.
export function ReadResult({ result, filePath, foldedLines = 8, foldedLineChars = 300 }: ReadResultProps) {
  const listing = useMemo(() => parseListing(result.text), [result.text]);
  if (!listing) return <ToolResultView result={result} foldedLines={foldedLines} foldedLineChars={foldedLineChars} />;
  return (
    <CodeListing
      listing={listing}
      language={languageFor(filePath)}
      foldedLines={foldedLines}
      foldedLineChars={foldedLineChars}
    />
  );
}

interface CodeListingProps {
  listing: Listing;
  language: string | undefined;
  foldedLines: number;
  foldedLineChars: number;
}

// Code lines first, then the notes, folded as one sequence the way ToolResultView folds text: the first
// lines stay visible and over-long lines are clipped until the reader expands it.
function CodeListing({ listing, language, foldedLines, foldedLineChars }: CodeListingProps) {
  const [expanded, setExpanded] = useState(false);
  const { lines, notes } = listing;
  const hiddenLines = lines.length + notes.length - foldedLines;
  const hasLongLine = [...lines.map((line) => line.code), ...notes].some((line) => line.length > foldedLineChars);
  const folded = (hiddenLines > 0 || hasLongLine) && !expanded;

  const shownLines = folded ? lines.slice(0, foldedLines) : lines;
  const shownNotes = folded ? notes.slice(0, Math.max(0, foldedLines - lines.length)) : notes;
  const clip = (line: string) => (folded && line.length > foldedLineChars ? `${line.slice(0, foldedLineChars)}…` : line);
  // Only what is on screen gets highlighted, so a folded 2000-line file costs eight lines of work.
  const code = shownLines.map((line) => clip(line.code)).join("\n");
  const html = useMemo(() => highlightLines(code, language), [code, language]);
  const hiddenLabel = `${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"}, folded`;

  const toggle = (label: string) => (
    <button className="fold-toggle" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
      {label}
    </button>
  );

  return (
    <div className="tool-result code-result">
      <pre className={expanded ? "code-listing expanded" : "code-listing"}>
        {shownLines.map((line, i) => (
          <span key={i} className="code-line">
            <span className="code-ln">{line.n}</span>
            <code className="code-text" dangerouslySetInnerHTML={{ __html: `${html[i] ?? ""}\n` }} />
          </span>
        ))}
      </pre>
      {shownNotes.length > 0 && <pre className="code-notes">{shownNotes.map(clip).join("\n")}</pre>}
      {folded && toggle(hiddenLines > 0 ? `▸ ${hiddenLabel}` : "▸ show full lines")}
      {expanded && toggle("▾ fold")}
    </div>
  );
}

// Highlights the code as one piece, so comments and strings spanning lines color correctly, then cuts the
// HTML back into lines, closing the spans still open at each line end and reopening them on the next.
function highlightLines(code: string, language: string | undefined): string[] {
  let html: string;
  try {
    html = language ? hljs.highlight(code, { language, ignoreIllegals: true }).value : escapeHtml(code);
  } catch {
    html = escapeHtml(code);
  }
  const lines: string[] = [];
  const open: string[] = [];
  let line = "";
  let last = 0;
  for (const match of html.matchAll(/<span[^>]*>|<\/span>|\n/g)) {
    line += html.slice(last, match.index);
    last = match.index + match[0].length;
    if (match[0] === "\n") {
      lines.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else {
      if (match[0] === "</span>") open.pop();
      else open.push(match[0]);
      line += match[0];
    }
  }
  lines.push(line + html.slice(last));
  return lines;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Task-tracking calls drawn the way a reader thinks of them: TodoWrite's list as a checklist, TaskCreate as a
// card, TaskUpdate as one status line. Every other tool has none.
export function TaskView({ name, input }: { name: string; input: Record<string, unknown> }) {
  if (name === "TodoWrite") return <TodoChecklist todos={input.todos} />;
  if (name === "TaskCreate") return <TaskCreated input={input} />;
  if (name === "TaskUpdate") return <TaskUpdated input={input} />;
  return null;
}

const TODO_MARK: Record<string, string> = { pending: "☐", in_progress: "◐", completed: "☑" };

// The whole list TodoWrite sets; the item being worked on reads as its activeForm ("Running tests").
function TodoChecklist({ todos }: { todos: unknown }) {
  const items = Array.isArray(todos) ? todos.filter((todo): todo is Record<string, unknown> => !!todo && typeof todo === "object") : [];
  if (items.length === 0) return null;
  return (
    <ul className="task-view todo-list">
      {items.map((todo, i) => {
        const status = str(todo.status) || "pending";
        const text = status === "in_progress" ? str(todo.activeForm) || str(todo.content) : str(todo.content);
        return (
          <li key={i} className={`todo todo-${status}`}>
            <span className="todo-mark" aria-label={status.replace("_", " ")}>
              {TODO_MARK[status] ?? "☐"}
            </span>
            <span className="todo-text">{text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function TaskCreated({ input }: { input: Record<string, unknown> }) {
  const subject = str(input.subject);
  const description = str(input.description);
  if (!subject && !description) return null;
  return (
    <div className="task-view task-card">
      <span className="task-tag">＋ task</span>
      {subject && <div className="task-subject">{subject}</div>}
      {description && <div className="task-description">{description}</div>}
    </div>
  );
}

// "task #3 → completed", then a new subject if the call sets one, and the names of any other fields it changes.
function TaskUpdated({ input }: { input: Record<string, unknown> }) {
  const status = str(input.status);
  const subject = str(input.subject);
  const others = Object.keys(input).filter((key) => !["taskId", "status", "subject"].includes(key));
  return (
    <div className="task-view task-update">
      <span className="task-id">task #{String(input.taskId ?? "?")}</span>
      {status && (
        <>
          <span className="task-arrow">→</span>
          <span className={`task-status task-status-${status}`}>{status.replace("_", " ")}</span>
        </>
      )}
      {subject && <span className="task-update-subject">{subject}</span>}
      {others.length > 0 && <span className="task-update-also">also {others.join(", ")}</span>}
    </div>
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
