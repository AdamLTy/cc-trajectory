import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Composer, type Mode } from "./components/Composer.tsx";
import { ItemList } from "./components/ItemList.tsx";
import { Outline } from "./components/Outline.tsx";
import { readNdjson } from "./ndjson.ts";
import { emptyTrajectory, reducer, type Run, type RunStats, type RunStatus } from "./trajectory.ts";

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
  const [mode, setMode] = useState<Mode>("live");
  const [busy, setBusy] = useState(false);
  // Live mode: the directory the agent works in and the prompt being typed.
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  // Replay mode.
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [fixture, setFixture] = useState("trace.jsonl");
  // The run the button plays next (1-based). Back at 1 once every run of the fixture has been played.
  const [nextRun, setNextRun] = useState(1);
  const totalRuns = fixtures.find((f) => f.name === fixture)?.runs ?? 1;
  // The item an outline click asked to show; cleared once it has scrolled itself into view.
  const [focus, setFocus] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const clearFocus = useCallback(() => setFocus(null), []);
  const nearBottom = useNearBottom();
  // A follow-up resumes the session of the latest run that reported one.
  const sessionId = trajectory.runs.findLast((run) => run.sessionId)?.sessionId ?? null;

  function jump(id: string) {
    setFocus(id);
    setOutlineOpen(false);
  }

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

  // Reads an NDJSON event stream into the trajectory; "end" then fails any run that never got its result.
  async function consume(request: Promise<Response>) {
    try {
      const res = await request;
      if (!res.ok || !res.body) throw new Error(`request failed (HTTP ${res.status}): ${await res.text()}`);
      for await (const event of readNdjson(res.body)) dispatch({ type: "event", event });
      dispatch({ type: "end" });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dispatch({ type: "end", error: message });
      return message;
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setNextRun(1);
    setStatus({ kind: "idle" });
    dispatch({ type: "reset" });
  }

  // Starts a live run. With a session already on the page the prompt is a follow-up that resumes it,
  // so the agent keeps the context of the earlier runs.
  async function runLive() {
    const text = prompt.trim();
    if (!text || !cwd.trim()) return;
    nearBottom.current = true;
    dispatch({ type: "start", prompt: text, resumed: sessionId !== null });
    setPrompt("");
    setBusy(true);
    const body = { cwd, prompt: text, sessionId: sessionId ?? undefined };
    await consume(fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    setBusy(false);
  }

  function newSession() {
    dispatch({ type: "reset" });
  }

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
    nearBottom.current = true;
    setStatus({ kind: "streaming", run });
    setBusy(true);
    const error = await consume(fetch(`/api/replay?file=${encodeURIComponent(fixture)}&run=${run}`));
    setStatus(error ? { kind: "error", run, message: error } : { kind: "done", run });
    setBusy(false);
    setNextRun(run >= totalRuns ? 1 : run + 1);
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Claude Code Trajectory</h1>
          <p className="subtitle">
            {mode === "live"
              ? "Drive Claude Code headless: pick a working directory, type a prompt, watch the agent work."
              : "Replaying a recorded stream-json run, event by event."}
          </p>
        </div>
      </header>

      <div className="layout">
        <div className="main-col">
          <main className="runs">
            {trajectory.runs.length === 0 ? (
              <div className="card">
                <p className="empty">
                  {mode === "live"
                    ? "Choose a working directory, type a prompt below, and press Run."
                    : "Pick a recorded run below and press Replay to stream it into the page."}
                </p>
              </div>
            ) : (
              trajectory.runs.map((run) => <RunView key={run.index} run={run} focus={focus} onFocused={clearFocus} />)
            )}
          </main>
          <Composer
            mode={mode}
            onMode={switchMode}
            busy={busy}
            live={{
              cwd,
              onCwd: setCwd,
              sessionId,
              runCount: trajectory.runs.length,
              prompt,
              onPrompt: setPrompt,
              onRun: runLive,
              onNewSession: newSession,
            }}
            replay={{
              fixtures: fixtures.map((f) => f.name),
              fixture,
              onFixture: chooseFixture,
              nextRun,
              totalRuns,
              status: <StatusText status={status} totalRuns={totalRuns} />,
              onReplay: replay,
            }}
          />
        </div>
        <aside className={outlineOpen ? "outline-pane open" : "outline-pane"}>
          <Outline runs={trajectory.runs} onJump={jump} />
        </aside>
      </div>

      {/* On a narrow window the outline folds away behind this button. */}
      <button className="outline-toggle" onClick={() => setOutlineOpen((o) => !o)} aria-expanded={outlineOpen}>
        {outlineOpen ? "✕ Close" : "☰ Outline"}
      </button>
    </div>
  );
}

function RunView({ run, focus, onFocused }: { run: Run; focus: string | null; onFocused: () => void }) {
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
      {run.prompt && (
        <div className="you">
          <span className="you-tag">You</span>
          <span className="you-text">{run.prompt}</span>
        </div>
      )}
      <ItemList items={run.items} cwd={run.cwd} runEnded={ended} focus={focus} onFocused={onFocused} />
      {run.failure && (
        <div className="run-error">
          <strong>{run.failure.kind}</strong>
          {run.failure.message !== run.failure.kind && <span>{run.failure.message}</span>}
        </div>
      )}
      {run.stats && <RunStatsLine stats={run.stats} sessionId={run.sessionId} />}
    </section>
  );
}

// The run's numbers from its result event: cost, wall-clock duration, and model turns.
function RunStatsLine({ stats, sessionId }: { stats: RunStats; sessionId: string }) {
  const session = `$${formatCost(stats.sessionCostUsd)}`;
  const parts = [
    stats.runCostUsd !== undefined ? `$${formatCost(stats.runCostUsd)}` : `session total ${session}`,
    formatDuration(stats.durationMs),
    stats.numTurns === 1 ? "1 turn" : `${stats.numTurns} turns`,
  ];
  if (sessionId) parts.push(`session ${sessionId.slice(0, 8)}…`);
  return (
    <div className="run-stats">
      <span>{parts.join(" · ")}</span>
      {stats.runCostUsd !== undefined && <span className="run-stats-total">(session total {session})</span>}
    </div>
  );
}

function formatCost(usd: number): string {
  return usd < 1 ? usd.toFixed(4) : usd.toFixed(2);
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} m ${Math.round(seconds % 60)} s`;
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
      return totalRuns > 1 ? <>{totalRuns} runs recorded</> : null;
    case "streaming":
      return (
        <span className="status-live">
          <span className="dot" /> streaming run {status.run}/{totalRuns}…
        </span>
      );
    case "done": {
      const left = totalRuns - status.run;
      if (left > 0) return <>{left === 1 ? "1 run left" : `${left} runs left`}</>;
      return <>{totalRuns === 1 ? "run replayed" : `all ${totalRuns} runs replayed`}</>;
    }
    case "error":
      return <span className="status-error">{status.message}</span>;
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
