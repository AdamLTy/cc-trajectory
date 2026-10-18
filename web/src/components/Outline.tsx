import { useEffect, useLayoutEffect, useRef } from "react";
import { groupByParent, splitParallel, targetOf, type ChildMap, type Item, type Run } from "../trajectory.ts";
import { plainPreview } from "./TextBlock.tsx";
import { summarize, toolCategory } from "./ToolCall.tsx";

const RUN_MARK = { running: "●", finished: "✓", failed: "✕" } as const;

interface OutlineProps {
  runs: Run[];
  onJump: (target: string) => void;
  // The step the reader is looking at in the dialogue; highlighted and kept in view here.
  current: string | null;
}

// A map of the whole trajectory: each run's steps (call names and texts) hang off a vertical spine, a subagent's
// steps nest under its call, and subagents started together fork into columns that join back into the spine.
// Clicking a step asks the dialogue to jump to it.
export function Outline({ runs, onJump, current }: OutlineProps) {
  const ref = useRef<HTMLElement>(null);
  const atBottom = useRef(true);

  // Keep following new steps while the outline is scrolled to its end.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [runs]);

  // Scroll the outline (only the outline, not the page) so the highlighted step stays visible.
  useEffect(() => {
    const nav = ref.current;
    if (!nav || !current) return;
    const step = nav.querySelector<HTMLElement>(`[data-outline-target="${CSS.escape(current)}"]`);
    if (!step) return;
    const top = step.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop;
    if (top < nav.scrollTop + 40) nav.scrollTop = top - 40;
    else if (top > nav.scrollTop + nav.clientHeight - 60) nav.scrollTop = top - nav.clientHeight + 60;
  }, [current]);

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
              <OutlineSteps items={top} ctx={{ run, tree, onJump, current }} spine />
            ) : (
              <div className="outline-empty">no events</div>
            )}
          </section>
        );
      })}
    </nav>
  );
}

interface StepContext {
  run: Run;
  tree: ChildMap;
  onJump: (target: string) => void;
  current: string | null;
}

// The main agent's list hangs off the run's spine; nested lists are a subagent's steps.
function OutlineSteps({ items, ctx, spine }: { items: Item[]; ctx: StepContext; spine?: boolean }) {
  return (
    <ul className={spine ? "outline-list outline-spine" : "outline-list"}>
      {splitParallel(items).map((unit) =>
        unit.kind === "parallel" ? (
          // Subagents started together fork into side-by-side columns, then join back into the spine.
          <li key={unit.calls[0].key} className="outline-fork">
            <div className="fork-cols">
              {unit.calls.map((call) => (
                <div key={call.key} className="fork-col">
                  <OutlineStep item={call} ctx={ctx} />
                </div>
              ))}
            </div>
            <div className="fork-join">⤶ join</div>
          </li>
        ) : (
          <li key={unit.item.key}>
            <OutlineStep item={unit.item} ctx={ctx} />
          </li>
        ),
      )}
    </ul>
  );
}

function OutlineStep({ item, ctx }: { item: Item; ctx: StepContext }) {
  const target = targetOf(item);
  const isCurrent = ctx.current === target;
  if (item.kind === "text") {
    const preview = plainPreview(item.text);
    return (
      <button
        className={isCurrent ? "outline-text outline-current" : "outline-text"}
        data-outline-target={target}
        title={preview}
        onClick={() => ctx.onJump(target)}
      >
        <span className="outline-text-tag">text</span>
        <span className="outline-text-preview">{preview}</span>
      </button>
    );
  }
  const nested = ctx.tree.get(item.id) ?? [];
  const pending = !item.result && ctx.run.status === "running";
  const state = item.result?.isError ? " outline-chip-failed" : pending ? " outline-chip-pending" : "";
  return (
    <>
      <button
        className={`outline-chip badge-${toolCategory(item.name)}${state}${isCurrent ? " outline-current" : ""}`}
        data-outline-target={target}
        title={summarize(item, ctx.run.cwd)}
        onClick={() => ctx.onJump(target)}
      >
        {item.name}
      </button>
      {nested.length > 0 && <OutlineSteps items={nested} ctx={ctx} />}
    </>
  );
}
