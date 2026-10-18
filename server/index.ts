import http from "node:http";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { createServer as createViteServer } from "vite";
import { readRuns, replayLines } from "./replay.ts";
import { runClaude, type RunRequest } from "./runner.ts";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = "127.0.0.1";
const FIXTURES_DIR = path.resolve("fixtures");
const DEFAULT_FIXTURE = "trace.jsonl";
const REPLAY_DELAY_MS = Number(process.env.REPLAY_DELAY_MS ?? 120);

const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff",
};

const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });

async function listFixtures(res: http.ServerResponse) {
  const names = (await readdir(FIXTURES_DIR)).filter((name) => name.endsWith(".jsonl")).sort();
  const fixtures = await Promise.all(names.map(async (name) => ({ name, runs: (await readRuns(path.join(FIXTURES_DIR, name))).length })));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(fixtures));
}

// Replays one run of a fixture (?run=N, 1-based), so each request stands in for one follow-up prompt.
async function handleReplay(url: URL, res: http.ServerResponse) {
  // Only bare .jsonl names inside fixtures/ are accepted, so the query cannot reach other files.
  const name = url.searchParams.get("file") ?? DEFAULT_FIXTURE;
  if (path.basename(name) !== name || !name.endsWith(".jsonl")) {
    res.writeHead(400).end(`invalid fixture name: ${name}`);
    return;
  }
  let runs: string[][];
  try {
    runs = await readRuns(path.join(FIXTURES_DIR, name));
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

  // Closing the page or reloading aborts the request; the agent process is stopped with it.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  res.writeHead(200, NDJSON_HEADERS);
  const request: RunRequest = { cwd: body.cwd, prompt: body.prompt, sessionId: body.sessionId, model: body.model };
  try {
    await runClaude(request, (line) => res.write(line + "\n"), abort.signal);
  } catch (err) {
    console.error("run failed:", err);
  }
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
  vite.middlewares(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Trajectory viewer: http://${HOST}:${PORT}`);
  console.log(`Replaying fixtures from ${FIXTURES_DIR} (${REPLAY_DELAY_MS} ms/line)`);
});
