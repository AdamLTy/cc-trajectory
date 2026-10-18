import { useState } from "react";

export interface DiffLine {
  kind: " " | "-" | "+";
  text: string;
}

interface Hunk {
  old: string;
  new: string;
}

// The changes an editing call asks for, as old/new text pairs: one for Edit, one per edit for MultiEdit,
// and the whole content as new text for Write. Other tools have none.
export function editHunks(name: string, input: Record<string, unknown>): Hunk[] | null {
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  if (name === "Edit") return [{ old: str(input.old_string), new: str(input.new_string) }];
  if (name === "Write") return [{ old: "", new: str(input.content) }];
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits.map((edit: Record<string, unknown>) => ({ old: str(edit.old_string), new: str(edit.new_string) }));
  }
  return null;
}

// A line diff from the longest common subsequence of lines. Edits are small, so the quadratic table is
// fine; past a size cap it falls back to "everything removed, everything added".
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length * b.length > 250_000) {
    return [...a.map((text) => ({ kind: "-" as const, text })), ...b.map((text) => ({ kind: "+" as const, text }))];
  }
  // lcs[i][j]: length of the LCS of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ kind: "-", text: a[i++] });
    } else {
      lines.push({ kind: "+", text: b[j++] });
    }
  }
  while (i < a.length) lines.push({ kind: "-", text: a[i++] });
  while (j < b.length) lines.push({ kind: "+", text: b[j++] });
  return lines;
}

export function diffStats(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of lineDiff(hunk.old, hunk.new)) {
      if (line.kind === "+") added++;
      if (line.kind === "-") removed++;
    }
  }
  return { added, removed };
}

const FOLDED_LINES = 12;

// Red/green view of what an Edit/MultiEdit/Write call changes; long diffs fold after a dozen lines.
export function DiffView({ hunks }: { hunks: Hunk[] }) {
  const [expanded, setExpanded] = useState(false);
  const lines = hunks.flatMap((hunk, h) => [
    ...(h > 0 ? [{ kind: " " as const, text: "⋯" }] : []),
    ...lineDiff(hunk.old, hunk.new),
  ]);
  const hidden = lines.length - FOLDED_LINES;
  const shown = expanded || hidden <= 0 ? lines : lines.slice(0, FOLDED_LINES);
  return (
    <div className="diff">
      <pre>
        {shown.map((line, i) => (
          <span key={i} className={line.kind === "+" ? "diff-add" : line.kind === "-" ? "diff-del" : "diff-ctx"}>
            <span className="diff-sign">{line.kind}</span>
            {line.text}
            {"\n"}
          </span>
        ))}
      </pre>
      {hidden > 0 && (
        <button className="fold-toggle" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          {expanded ? "▾ fold" : `▸ ${hidden} more diff ${hidden === 1 ? "line" : "lines"}, folded`}
        </button>
      )}
    </div>
  );
}
