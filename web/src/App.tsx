import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { TextBlock } from "./components/TextBlock.tsx";
import { ToolCall } from "./components/ToolCall.tsx";
import { readNdjson } from "./ndjson.ts";
import { emptyTrajectory, reducer, type Run } from "./trajectory.ts";

type Status = { kind: "idle" } | { kind: "streaming" } | { kind: "done" } | { kind: "error"; message: string };

export function App() {
  const [trajectory, dispatch] = useReducer(reducer, emptyTrajectory);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [fixtures, setFixtures] = useState<string[]>([]);
  const [fixture, setFixture] = useState("trace.jsonl");
  const nearBottom = useNearBottom();

  useEffect(() => {
    fetch("/api/fixtures")
      .then((res) => res.json())
      .then(setFixtures)
      .catch(() => setFixtures([]));
  }, []);

  // Follow new events only while the reader is already at the bottom, so scrolling up to read is not interrupted.
  useLayoutEffect(() => {
    if (nearBottom.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [trajectory, nearBottom]);

  async function replay() {
    dispatch({ type: "reset" });
    setStatus({ kind: "streaming" });
    try {
      const res = await fetch(`/api/replay?file=${encodeURIComponent(fixture)}`);
      if (!res.ok || !res.body) throw new Error(`replay request failed (HTTP ${res.status})`);
      for await (const event of readNdjson(res.body)) dispatch({ type: "event", event });
      setStatus({ kind: "done" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  const streaming = status.kind === "streaming";
  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Claude Code Trajectory</h1>
          <p className="subtitle">Replaying a recorded stream-json run, event by event.</p>
        </div>
        <div className="controls">
          <StatusText status={status} eventCount={trajectory.eventCount} />
          <select className="fixture-select" value={fixture} onChange={(e) => setFixture(e.target.value)} disabled={streaming}>
            {(fixtures.length > 0 ? fixtures : [fixture]).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button className="primary" onClick={replay} disabled={streaming}>
            Replay
          </button>
        </div>
      </header>

      <main className="card">
        {trajectory.runs.length === 0 ? (
          <p className="empty">Pick a recorded run and press Replay to stream it into the page.</p>
        ) : (
          trajectory.runs.map((run) => <RunView key={run.index} run={run} />)
        )}
      </main>
    </div>
  );
}

function RunView({ run }: { run: Run }) {
  return (
    <section className="run">
      <div className="run-divider">
        <span>Run {run.index}</span>
        {run.sessionId && <span className="mono">session {run.sessionId.slice(0, 8)}…</span>}
        {run.model && <span className="mono">{run.model}</span>}
      </div>
      {run.items.map((item) =>
        item.kind === "text" ? <TextBlock key={item.key} text={item.text} /> : <ToolCall key={item.key} item={item} cwd={run.cwd} />,
      )}
    </section>
  );
}

function StatusText({ status, eventCount }: { status: Status; eventCount: number }) {
  switch (status.kind) {
    case "idle":
      return null;
    case "streaming":
      return (
        <span className="status status-live">
          <span className="dot" /> streaming… {eventCount} events
        </span>
      );
    case "done":
      return <span className="status">done · {eventCount} events</span>;
    case "error":
      return <span className="status status-error">{status.message}</span>;
  }
}

function useNearBottom() {
  const near = useRef(true);
  useEffect(() => {
    const update = () => {
      near.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
    };
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return near;
}
