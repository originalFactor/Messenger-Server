"use client";

import parse, { domToReact, Element, type DOMNode } from "html-react-parser";
import { useMemo } from "react";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { renderMarkdown } from "@/components/messenger/markdown";

export function MarkdownMessage({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  const blocks = useMemo(() => {
    if (!html.includes("<pre>")) return null;
    // MarkdownIt escapes raw HTML and KaTeX renders with trust disabled.
    return parse(html, {
      replace(node) {
        if (!(node instanceof Element) || node.name !== "pre") return;
        return (
          <ScrollArea type="auto" className="markdown-code-block min-w-0 max-w-full overflow-hidden">
            <pre>{domToReact(node.children as DOMNode[])}</pre>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        );
      },
    });
  }, [html]);

  return blocks === null
    ? <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
    : <div className="markdown-body">{blocks}</div>;
}
