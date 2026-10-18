import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function TextBlock({ text }: { text: string }) {
  return (
    <div className="item text-block">
      <span className="text-label">text</span>
      <div className="md">
        <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
      </div>
    </div>
  );
}
