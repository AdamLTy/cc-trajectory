import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { containsTarget, descendants, itemTime, subagentDone, subagentSpan, targetOf, type Item, type ToolItem } from "../trajectory.ts";
import { formatElapsed } from "../useNow.ts";
import "./parallel-timeline.css";
import { DiffView, editHunks } from "./DiffView.tsx";
import type { RenderContext } from "./ItemList.tsx";
import { TaskView } from "./RichResults.tsx";
import { SubagentReport } from "./SubagentReport.tsx";
import { plainPreview, TextBlock } from "./TextBlock.tsx";
import { CallResult, CallStatus, summarize, toolCategory } from "./ToolCall.tsx";
import { useJumpTarget } from "./useJumpTarget.ts";

// A pause between two consecutive events longer than this gets its own "⋯ 3.2s" row in the lanes.
const GAP_MS = 2000;

type LaneRow = { kind: "event"; item: Item; lane: number; ts?: number } | { kind: "gap"; ms: number };

// Subagents started in the same assistant message fork into side-by-side lanes, one per subagent.
// Each grid row is one arrival: the lane whose subagent produced the event gets the cell and the
// other lanes stay empty in that row, so reading down shows how the subagents took turns working at
// the same time. A time column on the left gives each row's moment from the events' own timestamps,
// long pauses get a row of their own, and a timeline above draws every subagent's span to scale.
// The bottom row joins back to the main agent with each subagent's report.
export function ParallelGroup({ calls, ctx }: { calls: ToolItem[]; ctx: RenderContext }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const doneCount = calls.filter((call) => subagentDone(call, ctx.runEnded)).length;
  const allDone = doneCount === calls.length;
  const open = userOpen ?? !allDone;

  // A jump from the outline to a call inside one of the lanes unfolds the group, so the call can be shown.
  useEffect(() => {
    if (ctx.focus && calls.some((call) => containsTarget(call.id, ctx.focus!, ctx.children))) setUserOpen(true);
  }, [ctx.focus]); // eslint-disable-line react-hooks/exhaustive-deps

  const events = calls
    .flatMap((call, lane) => descendants(call.id, ctx.children).map((item) => ({ item, lane, ts: itemTime(item) })))
    .sort((a, b) => a.item.seq - b.item.seq);
  const clock = groupClock(calls, events.map((e) => e.item));
  const rows: LaneRow[] = [];
  let previous = clock.start;
  for (const event of events) {
    if (event.ts !== undefined && previous !== undefined && event.ts - previous > GAP_MS) rows.push({ kind: "gap", ms: event.ts - previous });
    rows.push({ kind: "event", ...event });
    if (event.ts !== undefined) previous = event.ts;
  }
  const shownRows = open ? rows : [];
  // Row 1 holds the lane heads, then one row per event or pause, then the join row with the reports.
  // Column 1 is the time column; lane n sits in column n + 2.
  const joinRow = shownRows.length + 2;
  const eventCount = events.length === 1 ? "1 event" : `${events.length} events`;
  const sinceStart = (ts: number | undefined) => (ts !== undefined && clock.start !== undefined ? `+${formatSeconds(ts - clock.start)}` : "");

  return (
    <div className="parallel" style={{ "--lanes": calls.length } as CSSProperties}>
      <button className="parallel-head" onClick={() => setUserOpen(!open)} aria-expanded={open}>
        <span className="subagent-chevron">{open ? "▾" : "▸"}</span>
        <span>⑂ {calls.length} parallel subagents</span>
        <span className="subagent-meta">
          · {doneCount}/{calls.length} done
        </span>
        <span className="subagent-meta">· {open ? eventCount : `${eventCount} collapsed`}</span>
        {!allDone && (
          <span className="call-pending">
            <span className="spinner" aria-hidden /> running
          </span>
        )}
      </button>
      {clock.start !== undefined && clock.end !== undefined && (
        <ParallelTimeline calls={calls} ctx={ctx} start={clock.start} end={clock.end} />
      )}
      <div className="lanes-scroll">
        <div className="lanes lanes-timed">
          {calls.map((call, lane) => (
            <div key={`bg-${call.key}`} className={`lane-bg lane-${lane % 4}`} style={{ gridColumn: lane + 2, gridRow: `1 / ${joinRow + 1}` }} />
          ))}
          {calls.map((call, lane) => (
            <LaneHead key={`head-${call.key}`} call={call} lane={lane} ctx={ctx} />
          ))}
          {shownRows.map((row, i) =>
            row.kind === "gap" ? (
              <div key={`gap-${i}`} className="lane-gap" style={{ gridColumn: "1 / -1", gridRow: i + 2 }}>
                ⋯ {formatElapsed(row.ms)}
              </div>
            ) : (
              <Fragment key={row.item.key}>
                <div className="lane-time" style={{ gridColumn: 1, gridRow: i + 2 }}>
                  {sinceStart(row.ts)}
                </div>
                <div className="lane-slot" style={{ gridColumn: row.lane + 2, gridRow: i + 2 }}>
                  <LaneCell item={row.item} ctx={ctx} />
                </div>
              </Fragment>
            ),
          )}
          {calls.map((call, lane) => (
            <div key={`join-${call.key}`} className="lane-join" style={{ gridColumn: lane + 2, gridRow: joinRow }}>
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

// The group's time range from the events' own timestamps: from the first subagent's launch to the latest
// moment anything is known to have happened (a subagent still running extends to its newest event).
function groupClock(calls: ToolItem[], items: Item[]): { start?: number; end?: number } {
  const known = (values: (number | undefined)[]) => values.filter((v): v is number => v !== undefined);
  const starts = known(calls.map((call) => call.issuedTs));
  const ends = known([
    ...calls.flatMap((call) => [call.issuedTs, subagentSpan(call).end]),
    ...items.flatMap((item) => [itemTime(item), item.kind === "tool" ? item.resultTs : undefined]),
  ]);
  return { start: starts.length ? Math.min(...starts) : undefined, end: ends.length ? Math.max(...ends) : undefined };
}

// Every subagent's span drawn to scale on one shared axis, with a tick for each call it made: who started
// first, who finished first, and when several were working at once.
function ParallelTimeline({ calls, ctx, start, end }: { calls: ToolItem[]; ctx: RenderContext; start: number; end: number }) {
  const span = Math.max(end - start, 1);
  const at = (ts: number) => `${(((ts - start) / span) * 100).toFixed(2)}%`;
  const step = axisStep(span);
  const marks = Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => i * step);
  return (
    <div className="timeline" aria-label="Subagent timeline">
      {calls.map((call, lane) => {
        const { start: from = start, end: to } = subagentSpan(call);
        const made = descendants(call.id, ctx.children).filter((item): item is ToolItem => item.kind === "tool" && item.issuedTs !== undefined);
        return (
          <div key={call.key} className="tl-track">
            <span className="tl-label" title={summarize(call, ctx.cwd)}>
              {summarize(call, ctx.cwd)}
            </span>
            <div className="tl-rail">
              <div
                className={to === undefined ? `tl-bar tl-lane-${lane % 4} tl-running` : `tl-bar tl-lane-${lane % 4}`}
                style={{ left: at(from), width: `calc(${at(to ?? end)} - ${at(from)})` }}
              />
              {made.map((item) => (
                <span
                  key={item.key}
                  className={`tl-tick tl-${toolCategory(item.name)}`}
                  style={{ left: at(item.issuedTs!) }}
                  title={`${item.name} ${summarize(item, ctx.cwd)} · +${formatSeconds(item.issuedTs! - start)}`}
                />
              ))}
            </div>
            <span className="tl-dur">{to !== undefined ? formatSeconds(to - from) : "running"}</span>
          </div>
        );
      })}
      <div className="tl-axis">
        <span className="tl-label" />
        <div className="tl-rail tl-scale">
          {marks.map((ms) => (
            <span key={ms} className="tl-mark" style={{ left: at(start + ms) }}>
              {axisLabel(ms)}
            </span>
          ))}
        </div>
        <span className="tl-dur" />
      </div>
    </div>
  );
}

// Moments and spans inside a group keep a decimal up to a minute, so +10.3s and +10.8s stay apart.
function formatSeconds(ms: number): string {
  return ms < 60_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatElapsed(ms);
}

// Whole seconds read as "5s" on the axis rather than "5.0s".
function axisLabel(ms: number): string {
  return ms % 1000 === 0 && ms < 60_000 ? `${ms / 1000}s` : formatElapsed(ms);
}

// A round tick interval that puts at most about six marks on the axis.
function axisStep(spanMs: number): number {
  const steps = [500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  return steps.find((step) => spanMs / step <= 6) ?? 1_800_000;
}

function LaneHead({ call, lane, ctx }: { call: ToolItem; lane: number; ctx: RenderContext }) {
  const ref = useRef<HTMLDivElement>(null);
  useJumpTarget(ref, ctx.focus === call.id, ctx.onFocused);
  const done = subagentDone(call, ctx.runEnded);
  const { start, end } = subagentSpan(call);
  return (
    <div
      ref={ref}
      id={`call-${call.id}`}
      data-target={call.id}
      className={`lane-head lane-${lane % 4}`}
      style={{ gridColumn: lane + 2, gridRow: 1 }}
    >
      <div className="lane-title">
        <span className="badge badge-agent">{call.name}</span>
        <span className="lane-desc">{summarize(call, ctx.cwd)}</span>
      </div>
      <div className="lane-meta">
        {call.subagent?.type && <span>{call.subagent.type}</span>}
        {start !== undefined && end !== undefined && <span className="call-took">{formatSeconds(end - start)}</span>}
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
      <div ref={ref} data-target={item.key} className="lane-cell">
        <button className="lane-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="lane-text-tag">text</span>
          <span className="lane-summary">{plainPreview(item.text)}</span>
        </button>
        {open && <TextBlock text={item.text} streaming={item.streaming} />}
      </div>
    );
  }

  const failed = item.result?.isError === true;
  const hunks = editHunks(item.name, item.input);
  return (
    <div ref={ref} id={`call-${item.id}`} data-target={item.id} className={failed ? "lane-cell tool-failed" : "lane-cell"}>
      <button className="lane-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`badge badge-${toolCategory(item.name)}`}>{item.name}</span>
        <span className="lane-summary">{summarize(item, ctx.cwd)}</span>
        <CallStatus item={item} runEnded={ctx.runEnded} />
      </button>
      {open && (
        <div className="lane-detail">
          {hunks ? <DiffView hunks={hunks} /> : <pre className="tool-input">{JSON.stringify(item.input, null, 2)}</pre>}
          <TaskView name={item.name} input={item.input} />
          <CallResult item={item} compact />
        </div>
      )}
    </div>
  );
}
