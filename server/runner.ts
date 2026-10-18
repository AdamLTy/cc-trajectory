import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface RunRequest {
  cwd: string;
  prompt: string;
  // Resume this session instead of starting a new one, so the agent keeps its earlier context.
  sessionId?: string;
  model?: string;
}

// Events the server adds to Claude Code's own stream, so a run that cannot start or dies early
// still ends with a visible error instead of a page that waits forever.
type ServerEvent = { type: "server"; subtype: "error"; message: string } | { type: "server"; subtype: "exit"; code: number | null };

const STDERR_TAIL_BYTES = 4096;

// Runs `claude -p` headless in the requested directory and hands every stream-json line to onLine as soon as
// it is complete. Resolves when the process exits; one process can print several result events (a finished
// background task makes the harness start another round), so the end of the run is the exit, not a result.
export async function runClaude(req: RunRequest, onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
  const emit = (event: ServerEvent) => onLine(JSON.stringify(event));
  const cwd = expandHome(req.cwd.trim());

  if (!(await isDirectory(cwd))) {
    emit({ type: "server", subtype: "error", message: `${req.cwd} is not a directory` });
    return;
  }

  // Partial messages let the page show text as the model writes it, ahead of each complete assistant event.
  const args = ["-p", req.prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions"];
  if (req.sessionId) args.push("--resume", req.sessionId);
  if (req.model) args.push("--model", req.model);

  // An exported API key would take precedence over the Claude login the course uses, and bill that key instead.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  // stdin is closed: with a pipe, `claude -p` first waits a few seconds for piped input.
  const child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const kill = () => child.kill("SIGTERM");
  signal.addEventListener("abort", kill, { once: true });

  let sawResult = false;
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.includes('"type":"result"')) sawResult = true;
      onLine(line);
    }
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });

  const code = await new Promise<number | null>((resolve) => {
    child.on("error", (err) => {
      emit({ type: "server", subtype: "error", message: `could not start claude: ${err.message}` });
      resolve(null);
    });
    child.on("close", (exitCode) => resolve(exitCode));
  });
  signal.removeEventListener("abort", kill);

  if (pending.trim()) onLine(pending);
  if (code !== 0 && code !== null && !sawResult && !signal.aborted) {
    const tail = stderr.trim().split("\n").slice(-6).join("\n");
    emit({ type: "server", subtype: "error", message: `claude exited with code ${code}${tail ? `\n${tail}` : ""}` });
  }
  emit({ type: "server", subtype: "exit", code });
}

function expandHome(dir: string): string {
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

async function isDirectory(dir: string): Promise<boolean> {
  if (!dir) return false;
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
