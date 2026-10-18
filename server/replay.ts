import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

// Yields the lines of a recorded stream-json file with a pause between them,
// so the page sees events arrive one by one the way a live run delivers them.
export async function* replayLines(file: string, delayMs: number, signal: AbortSignal) {
  const text = await readFile(file, "utf8");
  for (const line of text.split("\n")) {
    if (signal.aborted) return;
    if (!line.trim()) continue;
    yield line;
    await sleep(delayMs, undefined, { signal }).catch(() => {});
  }
}
