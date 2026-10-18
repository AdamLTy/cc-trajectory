import { useEffect, useState } from "react";
import { containsTarget, descendants, groupByParent, splitParallel, subagentDone, type ChildMap, type Item, type ToolItem } from "../trajectory.ts";
import { ParallelGroup } from "./ParallelGroup.tsx";
import { TextBlock } from "./TextBlock.tsx";
import { ToolCall } from "./ToolCall.tsx";

export interface RenderContext {
  cwd: string;
  runEnded: boolean;
  children: ChildMap;
  // The item (targetOf) the outline asked to jump to, until it has scrolled itself into view.
  focus: string | null;
  onFocused: () => void;
}

interface ItemListProps {
  items: Item[];
  cwd: string;
  runEnded: boolean;
  focus: string | null;
  onFocused: () => void;
}

// Renders a run's items as a tree: events a subagent emitted nest under the Agent/Task call that spawned it,
// and subagents started together fork into side-by-side lanes. A run without subagents renders as a flat list.
export function ItemList({ items, cwd, runEnded, focus, onFocused }: ItemListProps) {
  const ctx: RenderContext = { cwd, runEnded, children: groupByParent(items), focus, onFocused };
  return <Items list={ctx.children.get(null) ?? []} ctx={ctx} />;
}

function Items({ list, ctx }: { list: Item[]; ctx: RenderContext }) {
  return (
    <>
      {splitParallel(list).map((unit) => {
        if (unit.kind === "parallel") return <ParallelGroup key={unit.calls[0].key} calls={unit.calls} ctx={ctx} />;
        const item = unit.item;
        if (item.kind === "text") {
          return <TextBlock key={item.key} text={item.text} focused={ctx.focus === item.key} onFocused={ctx.onFocused} />;
        }
        return (
          <ToolCall
            key={item.key}
            item={item}
            cwd={ctx.cwd}
            runEnded={ctx.runEnded}
            focused={ctx.focus === item.id}
            onFocused={ctx.onFocused}
          >
            {(item.subagent || ctx.children.has(item.id)) && <SubagentGroup call={item} ctx={ctx} />}
          </ToolCall>
        );
      })}
    </>
  );
}

// Open while the subagent works, folded once it is done, unless the reader has toggled it.
function SubagentGroup({ call, ctx }: { call: ToolItem; ctx: RenderContext }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const done = subagentDone(call, ctx.runEnded);
  const open = userOpen ?? !done;
  const count = descendants(call.id, ctx.children).length;
  const events = count === 1 ? "1 event" : `${count} events`;
  const status = call.subagent?.status;

  // A jump from the outline to a call inside this group unfolds it, so the call can be shown.
  useEffect(() => {
    if (ctx.focus && containsTarget(call.id, ctx.focus, ctx.children)) setUserOpen(true);
  }, [ctx.focus]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="subagent">
      <button className="subagent-head" onClick={() => setUserOpen(!open)} aria-expanded={open}>
        <span className="subagent-chevron">{open ? "▾" : "▸"}</span>
        <span>subagent</span>
        {call.subagent?.type && <span className="subagent-meta">· {call.subagent.type}</span>}
        {call.subagent?.background && <span className="subagent-meta">· background</span>}
        {done && status && status !== "completed" && <span className="subagent-meta">· {status}</span>}
        <span className="subagent-meta">· {open ? events : `${events} collapsed`}</span>
        {!done && (
          <span className="call-pending">
            <span className="spinner" aria-hidden /> running
          </span>
        )}
      </button>
      {open && (
        <div className="subagent-body">
          <Items list={ctx.children.get(call.id) ?? []} ctx={ctx} />
        </div>
      )}
    </div>
  );
}
