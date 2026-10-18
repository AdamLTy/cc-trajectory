import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

// Reads a recorded stream-json file and splits it into runs.
export async function readRuns(file: string): Promise<string[][]> {
  const text = await readFile(file, "utf8");
  return splitRuns(text.split("\n").filter((line) => line.trim()));
}

// Every run opens with a system/init event (a resumed or auto-continued run prints a fresh one). Our own
// recordings put the run's prompt line just before its init, so a prompt line opens a run too and the init
// that follows stays with it. Anything before the first init belongs to the first run.
export function splitRuns(lines: string[]): string[][] {
  const runs: string[][] = [];
  let current: string[] = [];
  let hasInit = false;
  for (const line of lines) {
    const kind = lineKind(line);
    if ((kind === "prompt" && current.length > 0) || (kind === "init" && hasInit)) {
      runs.push(current);
      current = [];
      hasInit = false;
    }
    if (kind === "init") hasInit = true;
    current.push(line);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function lineKind(line: string): "init" | "prompt" | "other" {
  try {
    const event = JSON.parse(line);
    if (event.type === "system" && event.subtype === "init") return "init";
    if (event.type === "server" && event.subtype === "prompt") return "prompt";
  } catch {
    // not JSON: an ordinary line as far as splitting is concerned
  }
  return "other";
}

// Yields lines with a pause between them, so the page sees events arrive one by one the way a live run delivers them.
export async function* replayLines(lines: string[], delayMs: number, signal: AbortSignal) {
  for (const line of lines) {
    if (signal.aborted) return;
    yield line;
    await sleep(delayMs, undefined, { signal }).catch(() => {});
  }
}
