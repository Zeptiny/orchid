/**
 * MarkdownContent — full CommonMark + GFM renderer for assistant messages.
 *
 * Uses react-markdown + remark-gfm for parsing, rehype-highlight for fenced
 * code syntax highlighting. Links open in a new window (same as before).
 * Raw HTML is not enabled (react-markdown default — safer).
 */
import { Children, isValidElement, useMemo, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

// ── Stable plugin lists (avoid re-creating the processor every render) ───────

const remarkPlugins: Options['remarkPlugins'] = [remarkGfm];
const rehypePlugins: Options['rehypePlugins'] = [
  [rehypeHighlight, { plainText: ['text', 'txt', 'plain'] }],
];
const streamingRehypePlugins: Options['rehypePlugins'] = [];

// ── Components ───────────────────────────────────────────────────────────────

function MarkdownLink({
  href,
  children,
  ...props
}: ComponentPropsWithoutRef<'a'>) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  );
}

function MarkdownCode({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'code'>) {
  // Fenced / highlighted blocks get language-* / hljs classes from the pipeline.
  // Inline code has no className — keep the prior .code-token styling.
  if (className) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }
  return (
    <code className="orchid-code-token" {...props}>
      {children}
    </code>
  );
}

/** Extract language from a child <code class="language-foo"> (or hljs). */
function languageFromPreChildren(children: ReactNode): string | null {
  const child = Children.toArray(children).find((c) => isValidElement(c));
  if (!isValidElement(child)) return null;
  const className = (child.props as { className?: string }).className ?? '';
  const match = /(?:^|\s)language-([a-zA-Z0-9_+-]+)/.exec(className);
  return match?.[1] ?? null;
}

function MarkdownPre({
  children,
  ...props
}: ComponentPropsWithoutRef<'pre'>) {
  const lang = languageFromPreChildren(children);
  return (
    <pre {...props}>
      {lang && lang !== 'text' && lang !== 'txt' && lang !== 'plain' ? (
        <div className="markdown-code-lang">{lang}</div>
      ) : null}
      {children}
    </pre>
  );
}

const markdownComponents: Components = {
  a: MarkdownLink,
  code: MarkdownCode,
  pre: MarkdownPre,
};

// ── Component ────────────────────────────────────────────────────────────────

interface MarkdownContentProps {
  content: string;
  /** Skip syntax highlighting while content changes every animation frame. */
  isStreaming?: boolean;
}

export function MarkdownContent({
  content,
  isStreaming = false,
}: MarkdownContentProps) {
  // Memoize so streaming re-renders only re-parse when the string changes.
  const body = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={isStreaming ? streamingRehypePlugins : rehypePlugins}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    ),
    [content, isStreaming],
  );

  return <div className="markdown-content">{body}</div>;
}
