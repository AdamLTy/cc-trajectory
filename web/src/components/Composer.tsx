import type { KeyboardEvent, ReactNode, Ref } from "react";

export type Mode = "live" | "replay";

export interface LiveProps {
  cwd: string;
  onCwd: (cwd: string) => void;
  // A resumed session must run in the same directory, so the field locks once a session exists.
  sessionId: string | null;
  runCount: number;
  prompt: string;
  onPrompt: (prompt: string) => void;
  onRun: () => void;
  onNewSession: () => void;
  // Shown while a saved session is being restored after a reload.
  restoring: boolean;
}

export interface FixtureOption {
  name: string;
  // fixtures/ holds hand-picked recordings; recordings/ fills up with live runs.
  group: "fixtures" | "recordings";
}

export interface ReplayProps {
  fixtures: FixtureOption[];
  fixture: string;
  onFixture: (name: string) => void;
  // The run the button plays next (1-based) and how many the fixture has.
  nextRun: number;
  totalRuns: number;
  status: ReactNode;
  onReplay: () => void;
}

interface ComposerProps {
  mode: Mode;
  onMode: (mode: Mode) => void;
  busy: boolean;
  onStop: () => void;
  live: LiveProps;
  replay: ReplayProps;
  // The prompt textarea, so ⌘K/Ctrl+K can focus it from anywhere on the page.
  promptRef?: Ref<HTMLTextAreaElement>;
}

// The bar pinned to the bottom of the dialogue: the mode switch plus the controls of the current mode.
// While anything runs, the mode's main button turns into Stop.
export function Composer({ mode, onMode, busy, onStop, live, replay, promptRef }: ComposerProps) {
  return (
    <div className="composer">
      <div className="composer-row">
        <div className="mode-switch" role="tablist" aria-label="Mode">
          {(["live", "replay"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "active" : ""} onClick={() => onMode(m)} disabled={busy}>
              {m === "live" ? "Live" : "Replay"}
            </button>
          ))}
        </div>
        {mode === "live" ? <LiveHeader {...live} busy={busy} /> : <ReplayRow {...replay} busy={busy} onStop={onStop} />}
      </div>
      {mode === "live" && <PromptRow {...live} busy={busy} onStop={onStop} promptRef={promptRef} />}
    </div>
  );
}

function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <button className="stop" onClick={onStop} title="Stop the run (the agent process is ended)">
      ■ Stop
    </button>
  );
}

function LiveHeader({ cwd, onCwd, sessionId, runCount, onNewSession, restoring, busy }: LiveProps & { busy: boolean }) {
  const locked = sessionId !== null;
  return (
    <>
      <label className="cwd-field">
        <span>working directory</span>
        <input
          value={cwd}
          onChange={(e) => onCwd(e.target.value)}
          placeholder="~/scratch/demo-repo"
          disabled={busy || locked}
          title={locked ? "A resumed session runs in its original directory; start a new session to change it." : undefined}
          spellCheck={false}
        />
      </label>
      <span className="status composer-status">
        {restoring ? (
          "restoring session…"
        ) : busy ? (
          <span className="status-live">
            <span className="dot" /> running…
          </span>
        ) : sessionId ? (
          `session ${sessionId.slice(0, 8)}… · ${runCount === 1 ? "1 run" : `${runCount} runs`}`
        ) : (
          "new session"
        )}
      </span>
      {sessionId && !busy && (
        <a className="secondary" href={`/api/recordings/${sessionId}?download=1`} title="Download this session's events as stream-json lines">
          ⬇ jsonl
        </a>
      )}
      <button className="secondary" onClick={onNewSession} disabled={busy || runCount === 0}>
        New session
      </button>
    </>
  );
}

function PromptRow({
  prompt,
  onPrompt,
  onRun,
  cwd,
  sessionId,
  busy,
  onStop,
  promptRef,
}: LiveProps & { busy: boolean; onStop: () => void; promptRef?: Ref<HTMLTextAreaElement> }) {
  const ready = !busy && prompt.trim() !== "" && cwd.trim() !== "";
  // Enter sends, Shift+Enter adds a line; Enter that confirms an IME composition (e.g. Chinese input) does not send.
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (ready) onRun();
    }
  }
  return (
    <div className="composer-row prompt-row">
      <textarea
        ref={promptRef}
        value={prompt}
        onChange={(e) => onPrompt(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={sessionId ? "Type a follow-up… (resumes this session)" : "What should the agent do? (Enter to run, Shift+Enter for a new line)"}
        rows={2}
        disabled={busy}
      />
      {busy ? (
        <StopButton onStop={onStop} />
      ) : (
        <button className="primary" onClick={onRun} disabled={!ready}>
          Run
        </button>
      )}
    </div>
  );
}

function ReplayRow({
  fixtures,
  fixture,
  onFixture,
  nextRun,
  totalRuns,
  status,
  onReplay,
  busy,
  onStop,
}: ReplayProps & { busy: boolean; onStop: () => void }) {
  const groups = (["fixtures", "recordings"] as const).map((group) => ({ group, names: fixtures.filter((f) => f.group === group).map((f) => f.name) }));
  return (
    <>
      <select className="fixture-select" value={fixture} onChange={(e) => onFixture(e.target.value)} disabled={busy}>
        {fixtures.length === 0 && <option value={fixture}>{fixture}</option>}
        {groups.map(
          ({ group, names }) =>
            names.length > 0 && (
              <optgroup key={group} label={group}>
                {names.map((name) => (
                  <option key={name} value={name}>
                    {name.replace(/^recordings\//, "")}
                  </option>
                ))}
              </optgroup>
            ),
        )}
      </select>
      <span className="status composer-status">{status}</span>
      {busy ? (
        <StopButton onStop={onStop} />
      ) : (
        <button className="primary" onClick={onReplay}>
          {nextRun === 1 ? "Replay" : `▶ Next run (${nextRun}/${totalRuns})`}
        </button>
      )}
    </>
  );
}
