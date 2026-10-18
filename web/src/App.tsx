import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Composer, type FixtureOption, type Mode } from "./components/Composer.tsx";
import { ItemList } from "./components/ItemList.tsx";
import { Outline } from "./components/Outline.tsx";
import { ShortcutHelp, ShortcutHint } from "./components/ShortcutHelp.tsx";
import { ThemeToggle } from "./components/ThemeToggle.tsx";
import { readNdjson } from "./ndjson.ts";
import { emptyTrajectory, reducer, type Run, type RunStats } from "./trajectory.ts";
import { formatElapsed, NowContext, useNow, useTicker } from "./useNow.ts";
import { useShortcuts, useStepNavigation } from "./useShortcuts.ts";

type Status =
  | { kind: "idle" }
  | { kind: "streaming"; run: number }
  | { kind: "done"; run: number }
  | { kind: "error"; run: number; message: string };

interface Fixture extends FixtureOption {
  runs: number;
}

// The live session a reload should bring back; the server keeps its events in recordings/.
const LIVE_SESSION_KEY = "cc-trajectory:live-session";
// ?model=haiku in the page URL runs live prompts on a cheaper model (for testing the page itself).
const MODEL_OVERRIDE = new URLSearchParams(window.location.search).get("model") ?? undefined;

export function App() {
  const [trajectory, dispatch] = useReducer(reducer, emptyTrajectory);
  const [mode, setMode] = useState<Mode>("live");
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // Aborting the request stops the run: the server ends the agent process when the connection closes.
  const abortRef = useRef<AbortController | null>(null);
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
  const current = useCurrentStep(trajectory);
  const { ref: nearBottom, near } = useNearBottom();
  const now = useTicker(busy);
  // A follow-up resumes the session of the latest run that reported one.
  const sessionId = trajectory.runs.findLast((run) => run.sessionId)?.sessionId ?? null;

  function jump(target: string) {
    setFocus(target);
    setOutlineOpen(false);
  }

  // Keyboard shortcuts, listed by ShortcutHelp. A handler returns false when it has nothing to do.
  const [helpOpen, setHelpOpen] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const step = useStepNavigation(current, jump);
  useShortcuts({
    onEscape: () => (helpOpen ? setHelpOpen(false) : busy ? stop() : false),
    // The prompt only exists in Live mode, and is disabled while a run streams.
    onFocusPrompt: () => {
      const field = promptRef.current;
      if (mode !== "live" || !field || field.disabled) return false;
      field.focus();
    },
    onStep: step,
    onToggleHelp: () => setHelpOpen((open) => !open),
  });

  const loadFixtures = useCallback(() => {
    fetch("/api/fixtures")
      .then((res) => res.json())
      .then(setFixtures)
      .catch(() => setFixtures([]));
  }, []);

  useEffect(loadFixtures, [loadFixtures]);

  // Bring back the live session from before a reload (once, even though StrictMode runs effects twice).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    void restoreLive();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember the live session so a reload can restore it.
  useEffect(() => {
    if (mode !== "live" || restoring || !sessionId) return;
    writeSaved({ sessionId, cwd });
  }, [mode, restoring, sessionId, cwd]);

  // Follow new events only while the reader is already at the bottom, so scrolling up to read is not interrupted.
  useLayoutEffect(() => {
    if (nearBottom.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [trajectory, nearBottom]);

  // Reads an NDJSON event stream into the trajectory; "end" then fails any run that never got its result.
  async function consume(open: (signal: AbortSignal) => Promise<Response>): Promise<string | null> {
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await open(controller.signal);
      if (!res.ok || !res.body) throw new Error(`request failed (HTTP ${res.status}): ${await res.text()}`);
      for await (const event of readNdjson(res.body)) dispatch({ type: "event", event, at: Date.now() });
      dispatch({ type: "end", at: Date.now() });
      return null;
    } catch (err) {
      if (controller.signal.aborted) {
        dispatch({ type: "end", stopped: true, at: Date.now() });
        return "stopped";
      }
      const message = err instanceof Error ? err.message : String(err);
      dispatch({ type: "end", error: message, at: Date.now() });
      return message;
    } finally {
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function toLatest() {
    nearBottom.current = true;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  }

  async function restoreLive() {
    const saved = readSaved();
    if (!saved) return;
    setCwd(saved.cwd);
    setRestoring(true);
    setBusy(true);
    try {
      const res = await fetch(`/api/recordings/${encodeURIComponent(saved.sessionId)}`);
      if (!res.ok || !res.body) throw new Error(`no recording (HTTP ${res.status})`);
      for await (const event of readNdjson(res.body)) dispatch({ type: "event", event, at: Date.now() });
      dispatch({ type: "end", at: Date.now() });
    } catch {
      writeSaved(null);
    }
    setRestoring(false);
    setBusy(false);
  }

  function switchMode(next: Mode) {
    setMode(next);
    setNextRun(1);
    setStatus({ kind: "idle" });
    dispatch({ type: "reset" });
    if (next === "live") void restoreLive();
    else loadFixtures();
  }

  // Starts a live run. With a session already on the page the prompt is a follow-up that resumes it,
  // so the agent keeps the context of the earlier runs.
  async function runLive() {
    const text = prompt.trim();
    if (!text || !cwd.trim()) return;
    nearBottom.current = true;
    dispatch({ type: "start", prompt: text, resumed: sessionId !== null, at: Date.now() });
    setPrompt("");
    setBusy(true);
    const body = JSON.stringify({ cwd, prompt: text, sessionId: sessionId ?? undefined, model: MODEL_OVERRIDE });
    await consume((signal) => fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body, signal }));
    setBusy(false);
    loadFixtures();
  }

  function newSession() {
    dispatch({ type: "reset" });
    writeSaved(null);
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
    const error = await consume((signal) => fetch(`/api/replay?file=${encodeURIComponent(fixture)}&run=${run}`, { signal }));
    setStatus(error ? { kind: "error", run, message: error } : { kind: "done", run });
    setBusy(false);
    setNextRun(run >= totalRuns ? 1 : run + 1);
  }

  return (
    <NowContext.Provider value={now}>
      <div className="page">
        <header className="header">
          <div className="header-title">
            <h1>Claude Code Trajectory</h1>
            <p className="subtitle">
              {mode === "live"
                ? "Drive Claude Code headless: pick a working directory, type a prompt, watch the agent work."
                : "Replaying a recorded stream-json run, event by event."}
            </p>
          </div>
          <div className="header-actions">
            <ShortcutHint onHelp={() => setHelpOpen(true)} />
            <ThemeToggle />
          </div>
        </header>

        <div className="layout">
          <div className="main-col">
            <main className="runs">
              {trajectory.runs.length === 0 ? (
                <div className="card">
                  <p className="empty">
                    {restoring
                      ? "Restoring the previous session…"
                      : mode === "live"
                        ? "Choose a working directory, type a prompt below, and press Run."
                        : "Pick a recorded run below and press Replay to stream it into the page."}
                  </p>
                </div>
              ) : (
                trajectory.runs.map((run) => <RunView key={run.index} run={run} focus={focus} onFocused={clearFocus} />)
              )}
            </main>
            <div className="composer-dock">
              {busy && !near && (
                <button className="latest" onClick={toLatest}>
                  ↓ Latest
                </button>
              )}
              <Composer
                mode={mode}
                onMode={switchMode}
                busy={busy}
                onStop={stop}
                promptRef={promptRef}
                live={{
                  cwd,
                  onCwd: setCwd,
                  sessionId,
                  runCount: trajectory.runs.length,
                  prompt,
                  onPrompt: setPrompt,
                  onRun: runLive,
                  onNewSession: newSession,
                  restoring,
                }}
                replay={{
                  fixtures,
                  fixture,
                  onFixture: chooseFixture,
                  nextRun,
                  totalRuns,
                  status: <StatusText status={status} totalRuns={totalRuns} />,
                  onReplay: replay,
                }}
              />
            </div>
          </div>
          <aside className={outlineOpen ? "outline-pane open" : "outline-pane"}>
            <Outline runs={trajectory.runs} onJump={jump} current={current} />
          </aside>
        </div>

        {/* On a narrow window the outline folds away behind this button. */}
        <button className="outline-toggle" onClick={() => setOutlineOpen((o) => !o)} aria-expanded={outlineOpen}>
          {outlineOpen ? "✕ Close" : "☰ Outline"}
        </button>
        <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      </div>
    </NowContext.Provider>
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
        <RunStatusBadge run={run} />
      </div>
      {run.prompt && (
        <div className="you">
          <span className="you-tag">You</span>
          <span className="you-text">{run.prompt}</span>
        </div>
      )}
      <ItemList items={run.items} cwd={run.cwd} runEnded={ended} focus={focus} onFocused={onFocused} />
      <ActivityLine run={run} />
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

// What the agent is doing while nothing visible is happening: starting up, or the model thinking or
// composing its next step. Hidden while a call is pending (it has its own timer) or text is streaming in.
function ActivityLine({ run }: { run: Run }) {
  const now = useNow();
  if (run.status !== "running") return null;
  if (run.items.some((item) => (item.kind === "tool" && !item.result) || (item.kind === "text" && item.streaming))) return null;
  const elapsed = formatElapsed(now - run.activity.since);
  const label = run.awaitingInit
    ? `starting claude… ${elapsed}`
    : run.activity.kind === "thinking"
      ? `thinking… ${elapsed}${run.activity.tokens ? ` · ~${run.activity.tokens} tokens` : ""}`
      : `waiting for the model… ${elapsed}`;
  return (
    <div className="activity">
      <span className="dot" /> {label}
    </div>
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

function RunStatusBadge({ run }: { run: Run }) {
  const now = useNow();
  switch (run.status) {
    case "running":
      return (
        <span className="run-status run-status-running">
          <span className="dot" /> running · {formatElapsed(now - run.startedAt)}
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

// Whether the page is scrolled to (near) the bottom: a ref for the auto-follow logic, and state for the
// "Latest" button that appears once the reader scrolls away from new events.
function useNearBottom() {
  const ref = useRef(true);
  const [near, setNear] = useState(true);
  useEffect(() => {
    const update = () => {
      ref.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
      setNear(ref.current);
    };
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return { ref, near };
}

// The step the reader is at: the last step (in page order) whose top has scrolled past a reading line near the
// top of the window. Steps carry data-target; the outline highlights the matching name.
function useCurrentStep(trajectory: unknown): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let found: string | null = null;
      for (const el of document.querySelectorAll<HTMLElement>(".runs [data-target]")) {
        if (el.getBoundingClientRect().top <= 140) found = el.dataset.target ?? found;
        else if (found === null) found = el.dataset.target ?? null;
      }
      setCurrent(found);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [trajectory]);
  return current;
}

function readSaved(): { sessionId: string; cwd: string } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(LIVE_SESSION_KEY) ?? "null");
    return saved && typeof saved.sessionId === "string" ? saved : null;
  } catch {
    return null;
  }
}

function writeSaved(saved: { sessionId: string; cwd: string } | null) {
  try {
    if (saved) localStorage.setItem(LIVE_SESSION_KEY, JSON.stringify(saved));
    else localStorage.removeItem(LIVE_SESSION_KEY);
  } catch {
    // Storage can be unavailable (private window, blocked site data); the page works without it.
  }
}
