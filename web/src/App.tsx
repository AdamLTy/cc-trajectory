import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { TextBlock } from "./components/TextBlock.tsx";
import { ToolCall } from "./components/ToolCall.tsx";
import { readNdjson } from "./ndjson.ts";
import { emptyTrajectory, reducer, type Run, type RunStatus } from "./trajectory.ts";

type Status =
  | { kind: "idle" }
  | { kind: "streaming"; run: number }
  | { kind: "done"; run: number }
  | { kind: "error"; run: number; message: string };

interface Fixture {
  name: string;
  runs: number;
}

export function App() {
  const [trajectory, dispatch] = useReducer(reducer, emptyTrajectory);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [fixture, setFixture] = useState("trace.jsonl");
  // The run the button plays next (1-based). Back at 1 once every run of the fixture has been played.
  const [nextRun, setNextRun] = useState(1);
  const totalRuns = fixtures.find((f) => f.name === fixture)?.runs ?? 1;
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

  function chooseFixture(name: string) {
    setFixture(name);
    setNextRun(1);
    setStatus({ kind: "idle" });
    dispatch({ type: "reset" });
  }

  // Plays one run per click. Run 1 starts a fresh trajectory; later runs are appended below it,
  // the way a follow-up prompt continues the same session.
  async function replay() {
    const run = nextRun;
    if (run === 1) dispatch({ type: "reset" });
    setStatus({ kind: "streaming", run });
    try {
      const res = await fetch(`/api/replay?file=${encodeURIComponent(fixture)}&run=${run}`);
      if (!res.ok || !res.body) throw new Error(`replay request failed (HTTP ${res.status})`);
      for await (const event of readNdjson(res.body)) dispatch({ type: "event", event });
      dispatch({ type: "end" });
      setStatus({ kind: "done", run });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dispatch({ type: "end", error: message });
      setStatus({ kind: "error", run, message });
    }
    setNextRun(run >= totalRuns ? 1 : run + 1);
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
          <StatusText status={status} totalRuns={totalRuns} />
          <select className="fixture-select" value={fixture} onChange={(e) => chooseFixture(e.target.value)} disabled={streaming}>
            {(fixtures.length > 0 ? fixtures.map((f) => f.name) : [fixture]).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button className="primary" onClick={replay} disabled={streaming}>
            {nextRun === 1 ? "Replay" : `Continue · run ${nextRun}/${totalRuns}`}
          </button>
        </div>
      </header>

      <main className="runs">
        {trajectory.runs.length === 0 ? (
          <div className="card">
            <p className="empty">Pick a recorded run and press Replay to stream it into the page.</p>
          </div>
        ) : (
          trajectory.runs.map((run) => <RunView key={run.index} run={run} />)
        )}
      </main>
    </div>
  );
}

function RunView({ run }: { run: Run }) {
  const ended = run.status !== "running";
  return (
    <section className="run card">
      <div className="run-divider">
        <span>Run {run.index}</span>
        <SessionLabel run={run} />
        {run.model && <span className="mono">{run.model}</span>}
        <span className="run-line" />
        <RunStatusBadge status={run.status} />
      </div>
      {run.items.map((item) =>
        item.kind === "text" ? (
          <TextBlock key={item.key} text={item.text} />
        ) : (
          <ToolCall key={item.key} item={item} cwd={run.cwd} runEnded={ended} />
        ),
      )}
      {run.failure && (
        <div className="run-error">
          <strong>{run.failure.kind}</strong>
          {run.failure.message !== run.failure.kind && <span>{run.failure.message}</span>}
        </div>
      )}
    </section>
  );
}

// A run that shares its session id with an earlier one continues that conversation. Usually that is a resumed
// follow-up prompt, but the harness can also start a run itself when a background task finishes.
function SessionLabel({ run }: { run: Run }) {
  if (!run.sessionId) return null;
  const session = `${run.sessionId.slice(0, 8)}…`;
  if (!run.resumed) return <span className="mono">session {session}</span>;
  if (run.origin === "task-notification") {
    return <span className="resumed">↻ auto-continued · background task notification</span>;
  }
  return <span className="resumed">↻ resumed session {session}</span>;
}

function RunStatusBadge({ status }: { status: RunStatus }) {
  switch (status) {
    case "running":
      return (
        <span className="run-status run-status-running">
          <span className="dot" /> running
        </span>
      );
    case "finished":
      return <span className="run-status run-status-finished">✓ finished</span>;
    case "failed":
      return <span className="run-status run-status-failed">✕ failed</span>;
  }
}

function StatusText({ status, totalRuns }: { status: Status; totalRuns: number }) {
  switch (status.kind) {
    case "idle":
      return totalRuns > 1 ? <span className="status">{totalRuns} runs recorded</span> : null;
    case "streaming":
      return (
        <span className="status status-live">
          <span className="dot" /> streaming run {status.run}/{totalRuns}…
        </span>
      );
    case "done": {
      const left = totalRuns - status.run;
      if (left > 0) return <span className="status">{left === 1 ? "1 run left" : `${left} runs left`}</span>;
      return <span className="status">{totalRuns === 1 ? "run replayed" : `all ${totalRuns} runs replayed`}</span>;
    }
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
