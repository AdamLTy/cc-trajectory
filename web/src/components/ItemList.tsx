import { useEffect, useState } from "react";
import { groupByParent, type ChildMap, type Item, type ToolItem } from "../trajectory.ts";
import { TextBlock } from "./TextBlock.tsx";
import { ToolCall } from "./ToolCall.tsx";

interface Context {
  cwd: string;
  runEnded: boolean;
  children: ChildMap;
  // The call the outline asked to jump to, until that call has scrolled itself into view.
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

// Renders a run's items as a tree: events a subagent emitted nest under the Agent/Task call that spawned it.
// A run without subagents has only top-level items, so it renders as a flat list.
export function ItemList({ items, cwd, runEnded, focus, onFocused }: ItemListProps) {
  const ctx: Context = { cwd, runEnded, children: groupByParent(items), focus, onFocused };
  return <Items list={ctx.children.get(null) ?? []} ctx={ctx} />;
}

function Items({ list, ctx }: { list: Item[]; ctx: Context }) {
  return (
    <>
      {list.map((item) =>
        item.kind === "text" ? (
          <TextBlock key={item.key} text={item.text} />
        ) : (
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
        ),
      )}
    </>
  );
}

// Open while the subagent works, folded once it is done, unless the reader has toggled it.
function SubagentGroup({ call, ctx }: { call: ToolItem; ctx: Context }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const done = isDone(call, ctx.runEnded);
  const open = userOpen ?? !done;
  const count = countEvents(call.id, ctx.children);
  const events = count === 1 ? "1 event" : `${count} events`;
  const status = call.subagent?.status;

  // A jump from the outline to a call inside this group unfolds it, so the call can be shown.
  useEffect(() => {
    if (ctx.focus && containsCall(call.id, ctx.focus, ctx.children)) setUserOpen(true);
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

// The harness's task status is authoritative when present: a background subagent's tool_result
// arrives at launch, long before it finishes. Without it, the call's result marks the end.
function isDone(call: ToolItem, runEnded: boolean): boolean {
  if (runEnded) return true;
  return call.subagent ? call.subagent.status !== "running" : call.result !== undefined;
}

function countEvents(id: string, children: ChildMap): number {
  return (children.get(id) ?? []).reduce((n, item) => n + 1 + (item.kind === "tool" ? countEvents(item.id, children) : 0), 0);
}

function containsCall(rootId: string, targetId: string, children: ChildMap): boolean {
  return (children.get(rootId) ?? []).some(
    (item) => item.kind === "tool" && (item.id === targetId || containsCall(item.id, targetId, children)),
  );
}
