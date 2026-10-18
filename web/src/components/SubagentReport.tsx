import { useLayoutEffect, useRef, useState } from "react";
import type { ToolResult } from "../trajectory.ts";
import { MarkdownBody } from "./TextBlock.tsx";
import { ToolResultView } from "./ToolResult.tsx";

export interface HandBack {
  frame: string;
  report: string;
  trailer?: string;
}

// The harness wraps a subagent's final report before handing it to the main agent: a notice that the text is
// model output, then the report with every line indented two spaces, and sometimes an agentId/usage trailer.
export function parseHandBack(text: string): HandBack | null {
  const match = text.match(/^(\[Subagent hand-back\][\s\S]*?The report follows:)\n([\s\S]*?)(?:\n(agentId:[\s\S]*))?$/);
  if (!match) return null;
  const report = match[2]
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");
  return { frame: match[1], report, trailer: match[3] };
}

// The result of an Agent/Task call. A hand-back report is markdown written by the subagent, so it renders as
// formatting; the harness frame and trailer stay visible as small notes. Anything else (an error, the
// "async agent launched" notice of a background subagent) shows as a plain result.
export function SubagentReport({ result, compact }: { result: ToolResult; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const handBack = result.isError ? null : parseHandBack(result.text);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [handBack?.report, expanded]);

  if (!handBack) {
    return compact ? <ToolResultView result={result} foldedLines={4} foldedLineChars={90} /> : <ToolResultView result={result} />;
  }

  return (
    <div className={`tool-result subagent-report${compact ? " compact" : ""}`}>
      <details className="report-frame">
        <summary>[Subagent hand-back] harness frame</summary>
        {handBack.frame}
      </details>
      <div ref={bodyRef} className={expanded ? "report-body" : "report-body folded"}>
        <MarkdownBody text={handBack.report} />
      </div>
      {(overflows || expanded) && (
        <button className="fold-toggle" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          {expanded ? "▾ fold" : "▸ show full report"}
        </button>
      )}
      {handBack.trailer && <pre className="report-trailer">{handBack.trailer}</pre>}
    </div>
  );
}
