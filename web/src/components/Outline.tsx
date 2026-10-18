import { useLayoutEffect, useRef } from "react";
import { groupByParent, splitParallel, targetOf, type ChildMap, type Item, type Run } from "../trajectory.ts";
import { plainPreview } from "./TextBlock.tsx";
import { summarize, toolCategory } from "./ToolCall.tsx";

const RUN_MARK = { running: "●", finished: "✓", failed: "✕" } as const;

// A map of the whole trajectory: each run's steps (call names and texts) hang off a vertical spine, a subagent's
// steps nest under its call, and subagents started together fork into columns that join back into the spine.
// Clicking a step asks the dialogue to jump to it.
export function Outline({ runs, onJump }: { runs: Run[]; onJump: (target: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  const atBottom = useRef(true);

  // Keep following new steps while the outline is scrolled to its end.
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
      {runs.length === 0 && <p className="outline-empty">Steps appear here as a run streams in.</p>}
      {runs.map((run) => {
        const tree = groupByParent(run.items);
        const top = tree.get(null) ?? [];
        return (
          <section key={run.index} className="outline-run">
            <div className="outline-run-head">
              Run {run.index}
              <span className={`outline-run-${run.status}`}>{RUN_MARK[run.status]}</span>
            </div>
            {top.length > 0 ? (
              <OutlineSteps items={top} run={run} tree={tree} onJump={onJump} spine />
            ) : (
              <div className="outline-empty">no events</div>
            )}
          </section>
        );
      })}
    </nav>
  );
}

interface StepsProps {
  items: Item[];
  run: Run;
  tree: ChildMap;
  onJump: (target: string) => void;
  // The main agent's list hangs off the run's spine; nested lists are a subagent's steps.
  spine?: boolean;
}

function OutlineSteps({ items, run, tree, onJump, spine }: StepsProps) {
  return (
    <ul className={spine ? "outline-list outline-spine" : "outline-list"}>
      {splitParallel(items).map((unit) =>
        unit.kind === "parallel" ? (
          // Subagents started together fork into side-by-side columns, then join back into the spine.
          <li key={unit.calls[0].key} className="outline-fork">
            <div className="fork-cols">
              {unit.calls.map((call) => (
                <div key={call.key} className="fork-col">
                  <OutlineStep item={call} run={run} tree={tree} onJump={onJump} />
                </div>
              ))}
            </div>
            <div className="fork-join">⤶ join</div>
          </li>
        ) : (
          <li key={unit.item.key}>
            <OutlineStep item={unit.item} run={run} tree={tree} onJump={onJump} />
          </li>
        ),
      )}
    </ul>
  );
}

function OutlineStep({ item, run, tree, onJump }: { item: Item; run: Run; tree: ChildMap; onJump: (target: string) => void }) {
  if (item.kind === "text") {
    const preview = plainPreview(item.text);
    return (
      <button className="outline-text" title={preview} onClick={() => onJump(targetOf(item))}>
        <span className="outline-text-tag">text</span>
        <span className="outline-text-preview">{preview}</span>
      </button>
    );
  }
  const nested = tree.get(item.id) ?? [];
  const pending = !item.result && run.status === "running";
  const state = item.result?.isError ? " outline-chip-failed" : pending ? " outline-chip-pending" : "";
  return (
    <>
      <button className={`outline-chip badge-${toolCategory(item.name)}${state}`} title={summarize(item, run.cwd)} onClick={() => onJump(item.id)}>
        {item.name}
      </button>
      {nested.length > 0 && <OutlineSteps items={nested} run={run} tree={tree} onJump={onJump} />}
    </>
  );
}
