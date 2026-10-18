import { useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useJumpTarget } from "./useJumpTarget.ts";

interface TextBlockProps {
  text: string;
  // Set when the outline asked to jump to this text.
  focused?: boolean;
  onFocused?: () => void;
}

export function TextBlock({ text, focused, onFocused }: TextBlockProps) {
  const ref = useRef<HTMLDivElement>(null);
  useJumpTarget(ref, focused, onFocused);
  return (
    <div ref={ref} className="item text-block">
      <span className="text-label">text</span>
      <MarkdownBody text={text} />
    </div>
  );
}

export function MarkdownBody({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ? `md ${className}` : "md"}>
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

// The first non-empty line of a markdown text without its markup, for one-line previews.
export function plainPreview(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, "")
    .replace(/(\*\*|__|`)/g, "")
    .trim();
}
