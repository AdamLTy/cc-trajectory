import http from "node:http";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { createServer as createViteServer } from "vite";
import { Recorder } from "./recorder.ts";
import { readRuns, replayLines } from "./replay.ts";
import { runClaude, type RunRequest } from "./runner.ts";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = "127.0.0.1";
const FIXTURES_DIR = path.resolve("fixtures");
// Every live run is recorded here, one file per session.
const RECORDINGS_DIR = path.resolve("recordings");
const DEFAULT_FIXTURE = "trace.jsonl";
const REPLAY_DELAY_MS = Number(process.env.REPLAY_DELAY_MS ?? 120);

const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff",
};

const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });

// Hand-picked fixtures plus the recorded live sessions, which the page lists as "recordings/<file>".
async function listFixtures(res: http.ServerResponse) {
  const list = async (dir: string, group: "fixtures" | "recordings") => {
    const files = await readdir(dir).catch(() => [] as string[]);
    const names = files.filter((file) => file.endsWith(".jsonl")).sort();
    return Promise.all(
      names.map(async (file) => ({
        name: group === "fixtures" ? file : `recordings/${file}`,
        group,
        runs: (await readRuns(path.join(dir, file))).length,
      })),
    );
  };
  const fixtures = [...(await list(FIXTURES_DIR, "fixtures")), ...(await list(RECORDINGS_DIR, "recordings"))];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(fixtures));
}

// Maps a fixture name from the page to a file: a bare .jsonl name in fixtures/, or recordings/<name>.jsonl.
// Nothing else is accepted, so the query cannot reach other files.
function fixturePath(name: string): string | null {
  const match = name.match(/^(recordings\/)?([\w.-]+\.jsonl)$/);
  if (!match || match[2].startsWith(".")) return null;
  return path.join(match[1] ? RECORDINGS_DIR : FIXTURES_DIR, match[2]);
}

// Replays one run of a fixture (?run=N, 1-based), so each request stands in for one follow-up prompt.
async function handleReplay(url: URL, res: http.ServerResponse) {
  const name = url.searchParams.get("file") ?? DEFAULT_FIXTURE;
  const file = fixturePath(name);
  if (!file) {
    res.writeHead(400).end(`invalid fixture name: ${name}`);
    return;
  }
  let runs: string[][];
  try {
    runs = await readRuns(file);
  } catch {
    res.writeHead(404).end(`no such fixture: ${name}`);
    return;
  }
  const run = Number(url.searchParams.get("run") ?? 1);
  if (!Number.isInteger(run) || run < 1 || run > runs.length) {
    res.writeHead(400).end(`${name} has ${runs.length} run(s); run=${url.searchParams.get("run")} is out of range`);
    return;
  }

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  res.writeHead(200, NDJSON_HEADERS);
  try {
    for await (const line of replayLines(runs[run - 1], REPLAY_DELAY_MS, abort.signal)) {
      res.write(line + "\n");
    }
  } catch (err) {
    console.error("replay failed:", err);
  }
  res.end();
}

// Returns a recorded live session all at once (to restore the page after a reload),
// or as a download with ?download=1.
async function handleRecording(sessionId: string, url: URL, res: http.ServerResponse) {
  if (!/^[\w-]+$/.test(sessionId)) {
    res.writeHead(400).end("invalid session id");
    return;
  }
  let text: string;
  try {
    text = await readFile(path.join(RECORDINGS_DIR, `${sessionId}.jsonl`), "utf8");
  } catch {
    res.writeHead(404).end(`no recording for session ${sessionId}`);
    return;
  }
  const download = url.searchParams.has("download") ? { "Content-Disposition": `attachment; filename="session-${sessionId}.jsonl"` } : {};
  res.writeHead(200, { ...NDJSON_HEADERS, ...download });
  res.end(text);
}

// Starts a live `claude -p` run and streams its events back as NDJSON, the same format as a replay.
async function handleRun(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: Partial<RunRequest>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400).end("expected a JSON body");
    return;
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim() || typeof body.cwd !== "string") {
    res.writeHead(400).end("cwd and prompt are required");
    return;
  }

  // Closing the page, reloading or pressing Stop aborts the request; the agent process is stopped with it.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  res.writeHead(200, NDJSON_HEADERS);
  const request: RunRequest = { cwd: body.cwd, prompt: body.prompt, sessionId: body.sessionId, model: body.model };
  // The stream has no record of the prompt, so the recording starts each run with one.
  const recorder = new Recorder(RECORDINGS_DIR, request.sessionId);
  recorder.write(JSON.stringify({ type: "server", subtype: "prompt", prompt: request.prompt, resumed: Boolean(request.sessionId) }));
  try {
    await runClaude(
      request,
      (line) => {
        if (!res.writableEnded) res.write(line + "\n");
        recorder.write(line);
      },
      abort.signal,
    );
  } catch (err) {
    console.error("run failed:", err);
  }
  await recorder.close();
  res.end();
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(new Error("request body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (req.method === "POST" && url.pathname === "/api/run") {
    void handleRun(req, res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/fixtures") {
    void listFixtures(res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/replay") {
    void handleReplay(url, res);
    return;
  }
  const recording = url.pathname.match(/^\/api\/recordings\/([^/]+)$/);
  if (req.method === "GET" && recording) {
    void handleRecording(decodeURIComponent(recording[1]), url, res);
    return;
  }
  vite.middlewares(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Trajectory viewer: http://${HOST}:${PORT}`);
  console.log(`Replaying fixtures from ${FIXTURES_DIR} (${REPLAY_DELAY_MS} ms/line); recording live runs to ${RECORDINGS_DIR}`);
});
