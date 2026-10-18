import { useLayoutEffect, useRef } from "react";
import { groupByParent, type ChildMap, type Item, type Run, type ToolItem } from "../trajectory.ts";
import { summarize, toolCategory } from "./ToolCall.tsx";

const RUN_MARK = { running: "●", finished: "✓", failed: "✕" } as const;

// A table of contents for the whole trajectory: just the call names, nested the same way as the dialogue.
// Clicking a name asks the dialogue to jump to that call.
export function Outline({ runs, onJump }: { runs: Run[]; onJump: (id: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  const atBottom = useRef(true);

  // Keep following new calls while the outline is scrolled to its end.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [runs]);

  return (
    <nav
      ref={ref}
      className="outline"
      aria-label="Trajectory outline"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
      }}
    >
      <div className="outline-title">Outline</div>
      {runs.length === 0 && <p className="outline-empty">Calls appear here as a run streams in.</p>}
      {runs.map((run) => {
        const tree = groupByParent(run.items);
        const calls = onlyCalls(tree.get(null));
        return (
          <section key={run.index} className="outline-run">
            <div className="outline-run-head">
              Run {run.index}
              <span className={`outline-run-${run.status}`}>{RUN_MARK[run.status]}</span>
            </div>
            {calls.length > 0 ? (
              <OutlineCalls calls={calls} run={run} tree={tree} onJump={onJump} />
            ) : (
              <div className="outline-empty">no tool calls</div>
            )}
          </section>
        );
      })}
    </nav>
  );
}

interface OutlineCallsProps {
  calls: ToolItem[];
  run: Run;
  tree: ChildMap;
  onJump: (id: string) => void;
}

function OutlineCalls({ calls, run, tree, onJump }: OutlineCallsProps) {
  const runEnded = run.status !== "running";
  return (
    <ul className="outline-list">
      {calls.map((call) => {
        const nested = onlyCalls(tree.get(call.id));
        const state = call.result?.isError ? " outline-chip-failed" : !call.result && !runEnded ? " outline-chip-pending" : "";
        return (
          <li key={call.key}>
            <button
              className={`outline-chip badge-${toolCategory(call.name)}${state}`}
              title={summarize(call, run.cwd)}
              onClick={() => onJump(call.id)}
            >
              {call.name}
            </button>
            {nested.length > 0 && <OutlineCalls calls={nested} run={run} tree={tree} onJump={onJump} />}
          </li>
        );
      })}
    </ul>
  );
}

function onlyCalls(items: Item[] | undefined): ToolItem[] {
  return (items ?? []).filter((item): item is ToolItem => item.kind === "tool");
}
