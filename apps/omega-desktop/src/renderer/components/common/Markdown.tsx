import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CodeBlock } from "./CodeBlock";

export interface MarkdownProps {
  children: string;
}

/**
 * Markdown renderer.
 *
 * SECURITY: raw HTML is deliberately NOT enabled — we never load `rehype-raw`,
 * so any embedded HTML in assistant text is escaped/ignored (XSS-safe). Code
 * fences are highlighted via `rehype-highlight` (highlight.js).
 */
export function Markdown({ children }: MarkdownProps): React.ReactElement {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          code(props) {
            const { className, children: codeChildren, node: _node, ref: _ref, ...rest } = props as {
              className?: string;
              children?: React.ReactNode;
              node?: unknown;
              ref?: unknown;
              [key: string]: unknown;
            };
            const match = /language-(\w+)/.exec(className ?? "");
            const isBlock =
              typeof codeChildren === "string" && (codeChildren.includes("\n") || codeChildren.length > 60);
            if (!isBlock) {
              return (
                <code className={className} {...rest}>
                  {codeChildren}
                </code>
              );
            }
            return (
              <CodeBlock language={match?.[1]} className={className}>
                {codeChildren}
              </CodeBlock>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
