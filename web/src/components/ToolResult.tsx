import { useState } from "react";
import type { ToolResult } from "../trajectory.ts";

// A folded result shows this many lines, and clips any single line longer than the char limit.
const FOLDED_LINES = 8;
const FOLDED_LINE_CHARS = 300;

export function ToolResultView({ result }: { result: ToolResult }) {
  const [expanded, setExpanded] = useState(false);
  const text = result.text.replace(/\n+$/, "");
  if (!text.trim()) return <div className="tool-result tool-result-empty">(no output)</div>;

  const lines = text.split("\n");
  const hiddenLines = lines.length - FOLDED_LINES;
  const hasLongLine = lines.some((line) => line.length > FOLDED_LINE_CHARS);
  const foldable = hiddenLines > 0 || hasLongLine;
  const shown = expanded || !foldable ? text : lines.slice(0, FOLDED_LINES).map(clip).join("\n");

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

function clip(line: string): string {
  return line.length > FOLDED_LINE_CHARS ? `${line.slice(0, FOLDED_LINE_CHARS)}…` : line;
}
