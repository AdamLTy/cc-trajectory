import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// Appends a live run's events to recordings/<sessionId>.jsonl, so a reload can restore the session and the run
// can be replayed or downloaded later. A new session only learns its id from the init event, so lines are held
// back until then; a run that never gets that far (e.g. a bad working directory) is not recorded.
export class Recorder {
  private stream: WriteStream | null = null;
  private opening = false;
  private pending: string[] = [];

  constructor(
    private readonly dir: string,
    sessionId: string | undefined,
  ) {
    if (sessionId) void this.open(sessionId);
  }

  write(line: string) {
    if (this.stream) {
      this.stream.write(line + "\n");
      return;
    }
    this.pending.push(line);
    if (line.includes('"subtype":"init"')) {
      const sessionId = JSON.parse(line).session_id;
      if (typeof sessionId === "string") void this.open(sessionId);
    }
  }

  // Ends the file once everything is written, including lines still pending while it opens.
  async close() {
    while (this.opening && !this.stream) await new Promise((resolve) => setTimeout(resolve, 10));
    this.stream?.end();
  }

  // Lines that arrive while the directory is being created stay pending and are flushed in order.
  private async open(sessionId: string) {
    if (!/^[\w-]+$/.test(sessionId) || this.opening) return;
    this.opening = true;
    await mkdir(this.dir, { recursive: true });
    this.stream = createWriteStream(path.join(this.dir, `${sessionId}.jsonl`), { flags: "a" });
    for (const line of this.pending) this.stream.write(line + "\n");
    this.pending = [];
  }
}
