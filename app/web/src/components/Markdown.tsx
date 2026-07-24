import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

export interface MarkdownProps {
  readonly text: string;
}

export function Markdown({ text }: MarkdownProps) {
  const html = useMemo(() => {
    const rendered = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(rendered);
  }, [text]);

  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
