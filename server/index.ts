import http from "node:http";
import path from "node:path";
import { access, readdir } from "node:fs/promises";
import { createServer as createViteServer } from "vite";
import { replayLines } from "./replay.ts";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = "127.0.0.1";
const FIXTURES_DIR = path.resolve("fixtures");
const DEFAULT_FIXTURE = "trace.jsonl";
const REPLAY_DELAY_MS = Number(process.env.REPLAY_DELAY_MS ?? 120);

const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });

async function listFixtures(res: http.ServerResponse) {
  const names = (await readdir(FIXTURES_DIR)).filter((name) => name.endsWith(".jsonl")).sort();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(names));
}

async function handleReplay(url: URL, res: http.ServerResponse) {
  // Only bare .jsonl names inside fixtures/ are accepted, so the query cannot reach other files.
  const name = url.searchParams.get("file") ?? DEFAULT_FIXTURE;
  const file = path.join(FIXTURES_DIR, name);
  if (path.basename(name) !== name || !name.endsWith(".jsonl")) {
    res.writeHead(400).end(`invalid fixture name: ${name}`);
    return;
  }
  try {
    await access(file);
  } catch {
    res.writeHead(404).end(`no such fixture: ${name}`);
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
    for await (const line of replayLines(file, REPLAY_DELAY_MS, abort.signal)) {
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
