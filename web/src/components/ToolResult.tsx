import { useState } from "react";
import type { ToolResult } from "../trajectory.ts";

// A folded result shows this many lines, and clips any single line longer than the char limit.
// Narrow places such as parallel lanes pass tighter limits.
const FOLDED_LINES = 8;
const FOLDED_LINE_CHARS = 300;

interface ToolResultViewProps {
  result: ToolResult;
  foldedLines?: number;
  foldedLineChars?: number;
  // Fold from the top and keep the end visible: where a failing command prints what went wrong.
  tail?: boolean;
  // Mark failure and summary lines of command output (pytest's FAILED lines, "1 failed, 8 passed", tracebacks).
  highlight?: boolean;
}

export function ToolResultView({
  result,
  foldedLines = FOLDED_LINES,
  foldedLineChars = FOLDED_LINE_CHARS,
  tail = false,
  highlight = false,
}: ToolResultViewProps) {
  const [expanded, setExpanded] = useState(false);
  const text = result.text.replace(/\n+$/, "");
  if (!text.trim()) return <div className="tool-result tool-result-empty">(no output)</div>;

  const clip = (line: string) => (line.length > foldedLineChars ? `${line.slice(0, foldedLineChars)}…` : line);
  const lines = text.split("\n");
  const hiddenLines = lines.length - foldedLines;
  const hasLongLine = lines.some((line) => line.length > foldedLineChars);
  const foldable = hiddenLines > 0 || hasLongLine;
  const folded = foldable && !expanded;
  const shown = !folded ? lines : (tail ? lines.slice(-foldedLines) : lines.slice(0, foldedLines)).map(clip);
  const hiddenLabel = `${hiddenLines} ${tail ? "earlier" : "more"} ${hiddenLines === 1 ? "line" : "lines"}, folded`;

  const toggle = (label: string) => (
    <button className="fold-toggle" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
      {label}
    </button>
  );

  return (
    <div className="tool-result">
      {folded && tail && hiddenLines > 0 && toggle(`▴ ${hiddenLabel}`)}
      <pre className={expanded ? "expanded" : undefined}>
        {highlight ? shown.map((line, i) => <HighlightedLine key={i} line={line} />) : shown.join("\n")}
      </pre>
      {folded && !(tail && hiddenLines > 0) && toggle(hiddenLines > 0 ? `▸ ${hiddenLabel}` : "▸ show full lines")}
      {expanded && toggle("▾ fold")}
    </div>
  );
}

// Only the shapes errors are reported in count, not every mention of an error: "ERROR     3" in a program's own
// table or `raise ValueError(...)` in a file being shown are not failures; "ERROR tests/x.py::t", "E   ValueError: …",
// "parser.py:20: ValueError" and a line starting "KeyError: …" are.
const SUMMARY = /\b\d+ (passed|failed|errors?|skipped)\b/;
const FAILURE =
  /^(FAILED|ERROR) \S|^ERROR:|^E {2,}\S|^Traceback \(most recent call last\)|^\s*[\w.]*(Error|Exception): |:\d+: \w*(Error|Exception)$|^[Ee]xit code [1-9]/;

// Whether command output reports a failure even though the command itself succeeded, e.g. `pytest | tail`
// exits 0 because tail does, so the harness does not mark the result as an error.
export function looksFailed(text: string): boolean {
  return /\b\d+ (failed|errors?)\b/.test(text) || text.split("\n").some((line) => FAILURE.test(line));
}

function HighlightedLine({ line }: { line: string }) {
  const kind = SUMMARY.test(line) ? "line-summary" : FAILURE.test(line) ? "line-failure" : undefined;
  return (
    <span className={kind}>
      {line}
      {"\n"}
    </span>
  );
}
