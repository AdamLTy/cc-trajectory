import { useEffect, useRef, useState, type CSSProperties } from "react";
import { containsTarget, descendants, subagentDone, targetOf, type Item, type ToolItem } from "../trajectory.ts";
import type { RenderContext } from "./ItemList.tsx";
import { SubagentReport } from "./SubagentReport.tsx";
import { plainPreview, TextBlock } from "./TextBlock.tsx";
import { CallStatus, summarize, toolCategory } from "./ToolCall.tsx";
import { ToolResultView } from "./ToolResult.tsx";
import { useJumpTarget } from "./useJumpTarget.ts";

// Subagents started in the same assistant message fork into side-by-side lanes, one per subagent.
// Each grid row is one arrival: the lane whose subagent produced the event gets the cell and the
// other lanes stay empty in that row, so reading down shows how the subagents took turns working at
// the same time. The bottom row joins back to the main agent with each subagent's report.
export function ParallelGroup({ calls, ctx }: { calls: ToolItem[]; ctx: RenderContext }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const doneCount = calls.filter((call) => subagentDone(call, ctx.runEnded)).length;
  const allDone = doneCount === calls.length;
  const open = userOpen ?? !allDone;

  // A jump from the outline to a call inside one of the lanes unfolds the group, so the call can be shown.
  useEffect(() => {
    if (ctx.focus && calls.some((call) => containsTarget(call.id, ctx.focus!, ctx.children))) setUserOpen(true);
  }, [ctx.focus]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = calls
    .flatMap((call, lane) => descendants(call.id, ctx.children).map((item) => ({ item, lane })))
    .sort((a, b) => a.item.seq - b.item.seq);
  const shownRows = open ? rows : [];
  // Row 1 holds the lane heads, then one row per event, then the join row with the reports.
  const joinRow = shownRows.length + 2;
  const events = rows.length === 1 ? "1 event" : `${rows.length} events`;

  return (
    <div className="parallel" style={{ "--lanes": calls.length } as CSSProperties}>
      <button className="parallel-head" onClick={() => setUserOpen(!open)} aria-expanded={open}>
        <span className="subagent-chevron">{open ? "▾" : "▸"}</span>
        <span>⑂ {calls.length} parallel subagents</span>
        <span className="subagent-meta">
          · {doneCount}/{calls.length} done
        </span>
        <span className="subagent-meta">· {open ? events : `${events} collapsed`}</span>
        {!allDone && (
          <span className="call-pending">
            <span className="spinner" aria-hidden /> running
          </span>
        )}
      </button>
      <div className="lanes-scroll">
        <div className="lanes">
          {calls.map((call, lane) => (
            <div key={`bg-${call.key}`} className={`lane-bg lane-${lane % 4}`} style={{ gridColumn: lane + 1, gridRow: `1 / ${joinRow + 1}` }} />
          ))}
          {calls.map((call, lane) => (
            <LaneHead key={`head-${call.key}`} call={call} lane={lane} ctx={ctx} />
          ))}
          {shownRows.map(({ item, lane }, i) => (
            <div key={item.key} className="lane-slot" style={{ gridColumn: lane + 1, gridRow: i + 2 }}>
              <LaneCell item={item} ctx={ctx} />
            </div>
          ))}
          {calls.map((call, lane) => (
            <div key={`join-${call.key}`} className="lane-join" style={{ gridColumn: lane + 1, gridRow: joinRow }}>
              {call.result ? (
                <SubagentReport result={call.result} compact />
              ) : (
                <span className="lane-waiting">{ctx.runEnded ? "no report" : "waiting for report…"}</span>
              )}
            </div>
          ))}
        </div>
      </div>
      {allDone && (
        <div className="parallel-join">
          ⤶ {calls.length} reports joined back into the main agent ↓
        </div>
      )}
    </div>
  );
}

function LaneHead({ call, lane, ctx }: { call: ToolItem; lane: number; ctx: RenderContext }) {
  const ref = useRef<HTMLDivElement>(null);
  useJumpTarget(ref, ctx.focus === call.id, ctx.onFocused);
  const done = subagentDone(call, ctx.runEnded);
  return (
    <div ref={ref} id={`call-${call.id}`} className={`lane-head lane-${lane % 4}`} style={{ gridColumn: lane + 1, gridRow: 1 }}>
      <div className="lane-title">
        <span className="badge badge-agent">{call.name}</span>
        <span className="lane-desc">{summarize(call, ctx.cwd)}</span>
      </div>
      <div className="lane-meta">
        {call.subagent?.type && <span>{call.subagent.type}</span>}
        {!done ? (
          <span className="call-pending">
            <span className="spinner" aria-hidden /> running
          </span>
        ) : call.result?.isError ? (
          <span className="fail-mark">failed</span>
        ) : (
          <span className="call-ok">✓ done</span>
        )}
      </div>
    </div>
  );
}

// A compact row in a lane; clicking it shows the call's input and result (or the full text) in place.
function LaneCell({ item, ctx }: { item: Item; ctx: RenderContext }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useJumpTarget(ref, ctx.focus === targetOf(item), ctx.onFocused);

  if (item.kind === "text") {
    return (
      <div ref={ref} className="lane-cell">
        <button className="lane-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="lane-text-tag">text</span>
          <span className="lane-summary">{plainPreview(item.text)}</span>
        </button>
        {open && <TextBlock text={item.text} />}
      </div>
    );
  }

  const failed = item.result?.isError === true;
  return (
    <div ref={ref} id={`call-${item.id}`} className={failed ? "lane-cell tool-failed" : "lane-cell"}>
      <button className="lane-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`badge badge-${toolCategory(item.name)}`}>{item.name}</span>
        <span className="lane-summary">{summarize(item, ctx.cwd)}</span>
        <CallStatus item={item} runEnded={ctx.runEnded} />
      </button>
      {open && (
        <div className="lane-detail">
          <pre className="tool-input">{JSON.stringify(item.input, null, 2)}</pre>
          {item.result && <ToolResultView result={item.result} foldedLines={6} foldedLineChars={90} />}
        </div>
      )}
    </div>
  );
}
