import { Children, isValidElement, memo, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Markdown for chat text. react-markdown builds React elements and never injects raw HTML, so
// anything Claude (or a file it printed) puts in the text cannot run script. Links open in a new tab.
// Images are shown as their alt text, never loaded: a remote image would tell its host when the
// chat was read (the CSP's img-src blocks them too).

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return Children.toArray(node).map(textOf).join("");
}

// Clipboard needs a secure context; over plain http the textarea + execCommand route still works.
async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy route
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

function CodeBlock({ children }: { readonly children?: ReactNode }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    // react-markdown ends a fenced block's text with a newline; the copied text is the code itself.
    const ok = await copyText(textOf(children).replace(/\n$/, ""));
    setState(ok ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1500);
  };
  return (
    <div className="code-block">
      <button type="button" className="code-copy" data-testid="code-copy" aria-label="Copy code" onClick={() => void copy()}>
        {state === "copied" ? "Copied" : state === "failed" ? "Failed" : "Copy"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { readonly text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          img: ({ alt }) => <span className="md-img">{alt === undefined || alt === "" ? "[image]" : `[image: ${alt}]`}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
