import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CodeBlock } from "./CodeBlock";
import { useAppStore } from "../../store/useAppStore";

export interface MarkdownProps {
  children: string;
}

const LOCAL_PATH = /^(?:[A-Za-z]:[\\/][^:?*"<>|]*|\/[^:?*"<>|]*|\.?\.?\/[^:?*"<>|]+)/;

/** Looks like a local file path (not a URL). */
function isLocalPath(href: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("file:")) return false;
  return LOCAL_PATH.test(href);
}

/**
 * Markdown renderer.
 *
 * SECURITY: raw HTML is deliberately NOT enabled — we never load `rehype-raw`,
 * so any embedded HTML in assistant text is escaped/ignored (XSS-safe). Code
 * fences are highlighted via `rehype-highlight` (highlight.js). Anchors that
 * look like local file paths open the in-app viewer instead of navigating.
 */
export function Markdown({ children }: MarkdownProps): React.ReactElement {
  const openViewer = useAppStore((s) => s.openViewer);
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a(props) {
            const { href, children: linkChildren, node: _node, ref: _ref, ...rest } = props as {
              href?: string;
              children?: React.ReactNode;
              node?: unknown;
              ref?: unknown;
              [key: string]: unknown;
            };
            if (href && isLocalPath(href)) {
              return (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    void openViewer(href.replace(/^file:\/\/\/?/, ""));
                  }}
                  title="在查看器中打开"
                  {...rest}
                >
                  {linkChildren}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" {...rest}>
                {linkChildren}
              </a>
            );
          },
          code(props) {
            const { className, children: codeChildren, node: _node2, ref: _ref2, ...rest } = props as {
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
