import http from "node:http";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { createServer as createViteServer } from "vite";
import { readRuns, replayLines } from "./replay.ts";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = "127.0.0.1";
const FIXTURES_DIR = path.resolve("fixtures");
const DEFAULT_FIXTURE = "trace.jsonl";
const REPLAY_DELAY_MS = Number(process.env.REPLAY_DELAY_MS ?? 120);

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
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  try {
    for await (const line of replayLines(runs[run - 1], REPLAY_DELAY_MS, abort.signal)) {
      res.write(line + "\n");
    }
  } catch (err) {
    console.error("replay failed:", err);
  }
  res.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
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
