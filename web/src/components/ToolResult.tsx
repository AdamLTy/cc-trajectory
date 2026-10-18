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
}

export function ToolResultView({ result, foldedLines = FOLDED_LINES, foldedLineChars = FOLDED_LINE_CHARS }: ToolResultViewProps) {
  const [expanded, setExpanded] = useState(false);
  const text = result.text.replace(/\n+$/, "");
  if (!text.trim()) return <div className="tool-result tool-result-empty">(no output)</div>;

  const clip = (line: string) => (line.length > foldedLineChars ? `${line.slice(0, foldedLineChars)}…` : line);
  const lines = text.split("\n");
  const hiddenLines = lines.length - foldedLines;
  const hasLongLine = lines.some((line) => line.length > foldedLineChars);
  const foldable = hiddenLines > 0 || hasLongLine;
  const shown = expanded || !foldable ? text : lines.slice(0, foldedLines).map(clip).join("\n");

  return (
    <div className="tool-result">
      <pre className={expanded ? "expanded" : undefined}>{shown}</pre>
      {foldable && (
        <button className="fold-toggle" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          {expanded ? "▾ fold" : hiddenLines > 0 ? `▸ ${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"}, folded` : "▸ show full lines"}
        </button>
      )}
    </div>
  );
}
