import type { StreamEvent } from "./events.ts";

// Reads a newline-delimited JSON response body and yields each event as soon as its line is complete.
export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseLine(line);
      if (event) yield event;
    }
  }
  const event = parseLine(buffered);
  if (event) yield event;
}

function parseLine(line: string): StreamEvent | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as StreamEvent;
  } catch {
    console.warn("skipping malformed stream line:", line.slice(0, 200));
    return null;
  }
}
