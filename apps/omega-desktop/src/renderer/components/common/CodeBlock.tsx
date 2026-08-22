import * as React from "react";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";

export interface CodeBlockProps {
  language?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Presentational code block. Highlighting is provided upstream by
 * `rehype-highlight` (which is highlight.js under the hood) — we only add the
 * language label and a copy button here, so no raw HTML is ever injected.
 */
export function CodeBlock({ language, className, children }: CodeBlockProps): React.ReactElement {
  const copy = React.useCallback(() => {
    const text = typeof children === "string" ? children : String(children ?? "");
    void navigator.clipboard?.writeText(text);
  }, [children]);

  return (
    <Box sx={{ position: "relative", my: 1 }}>
      {language ? (
        <Box sx={{ position: "absolute", top: 8, right: 44, fontSize: 11, color: "var(--omega-text-muted)", zIndex: 1 }}>{language}</Box>
      ) : null}
      <Tooltip title="复制">
        <IconButton
          size="small"
          onClick={copy}
          sx={{ position: "absolute", top: 4, right: 4, color: "var(--omega-text-muted)", zIndex: 1 }}
        >
          <ContentCopyIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <pre>
        <code className={className}>{children}</code>
      </pre>
    </Box>
  );
}
