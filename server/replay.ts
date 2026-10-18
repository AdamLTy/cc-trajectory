import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

// Reads a recorded stream-json file and splits it into runs.
export async function readRuns(file: string): Promise<string[][]> {
  const text = await readFile(file, "utf8");
  return splitRuns(text.split("\n").filter((line) => line.trim()));
}

// Every run opens with a system/init event (a resumed or auto-continued run prints a fresh one),
// so a new run starts at each init; anything before the first init belongs to the first run.
export function splitRuns(lines: string[]): string[][] {
  const runs: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (isInit(line) && current.length > 0) {
      runs.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function isInit(line: string): boolean {
  try {
    const event = JSON.parse(line);
    return event.type === "system" && event.subtype === "init";
  } catch {
    return false;
  }
}

// Yields lines with a pause between them, so the page sees events arrive one by one the way a live run delivers them.
export async function* replayLines(lines: string[], delayMs: number, signal: AbortSignal) {
  for (const line of lines) {
    if (signal.aborted) return;
    yield line;
    await sleep(delayMs, undefined, { signal }).catch(() => {});
  }
}
