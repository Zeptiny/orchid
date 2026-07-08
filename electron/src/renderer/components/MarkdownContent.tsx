/**
 * MarkdownContent — minimal markdown renderer for assistant messages.
 *
 * Handles:
 * - Code blocks (```) with language label
 * - Inline code (`)
 * - Bold (**text**)
 * - Italic (*text*)
 * - Links [text](url)
 * - Headers (#, ##, ###)
 * - Unordered lists (- item)
 * - Ordered lists (1. item)
 * - Blockquotes (> text)
 * - Horizontal rules (---)
 *
 * Does NOT require react-markdown — pure regex-based rendering.
 */
import { useMemo } from 'react';

// ── Component ────────────────────────────────────────────────────────────────

interface MarkdownContentProps {
  content: string;
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  const rendered = useMemo(() => renderMarkdown(content), [content]);
  return <div className="markdown-content">{rendered}</div>;
}

// ── Renderer ─────────────────────────────────────────────────────────────────

function renderMarkdown(text: string): React.ReactNode[] {
  const blocks = splitBlocks(text);
  return blocks.map((block, i) => renderBlock(block, i));
}

// ── Block Splitting ──────────────────────────────────────────────────────────

type Block =
  | { type: 'code'; lang: string; code: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'blockquote'; text: string }
  | { type: 'hr' }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; text: string };

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') });
      i++; // skip closing ```
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join('\n') });
      continue;
    }

    // Unordered list
    if (/^[\s]*[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[\s]*[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[\s]*[-*+]\s/, ''));
        i++;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    // Ordered list
    if (/^[\s]*\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[\s]*\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[\s]*\d+\.\s/, ''));
        i++;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    // Paragraph (collect consecutive non-empty lines)
    if (line.trim()) {
      const paraLines: string[] = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        paraLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
      continue;
    }

    // Empty line — skip
    i++;
  }

  return blocks;
}

function isBlockStart(line: string): boolean {
  if (line.startsWith('```')) return true;
  if (/^#{1,3}\s/.test(line)) return true;
  if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) return true;
  if (line.startsWith('> ')) return true;
  if (/^[\s]*[-*+]\s/.test(line)) return true;
  if (/^[\s]*\d+\.\s/.test(line)) return true;
  return false;
}

// ── Block Rendering ──────────────────────────────────────────────────────────

function renderBlock(block: Block, key: number): React.ReactNode {
  switch (block.type) {
    case 'code':
      return (
        <pre key={key}>
          {block.lang && (
            <div style={{
              fontSize: '10px',
              color: 'var(--text-tertiary)',
              marginBottom: 'var(--space-1)',
              textTransform: 'uppercase',
            }}>
              {block.lang}
            </div>
          )}
          <code>{block.code}</code>
        </pre>
      );
    case 'heading':
      switch (block.level) {
        case 1: return <h1 key={key}>{renderInline(block.text)}</h1>;
        case 2: return <h2 key={key}>{renderInline(block.text)}</h2>;
        case 3: return <h3 key={key}>{renderInline(block.text)}</h3>;
        default: return <p key={key}>{renderInline(block.text)}</p>;
      }
    case 'blockquote':
      return <blockquote key={key}>{renderInline(block.text)}</blockquote>;
    case 'hr':
      return <hr key={key} />;
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul';
      return (
        <ListTag key={key}>
          {block.items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </ListTag>
      );
    }
    case 'paragraph':
      return <p key={key}>{renderInline(block.text)}</p>;
  }
}

// ── Inline Rendering ─────────────────────────────────────────────────────────

function renderInline(text: string): React.ReactNode {
  // Process inline markdown: bold, italic, code, links
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining) {
    // Inline code
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push(<code key={key++}>{codeMatch[1]}</code>);
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Bold + italic
    const boldItalicMatch = remaining.match(/^\*\*\*(.+?)\*\*\*/);
    if (boldItalicMatch) {
      parts.push(
        <strong key={key++}><em>{boldItalicMatch[1]}</em></strong>
      );
      remaining = remaining.slice(boldItalicMatch[0].length);
      continue;
    }

    // Bold
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      parts.push(<strong key={key++}>{boldMatch[1]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic
    const italicMatch = remaining.match(/^\*(.+?)\*/);
    if (italicMatch) {
      parts.push(<em key={key++}>{italicMatch[1]}</em>);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Link
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      parts.push(
        <a key={key++} href={linkMatch[2]} target="_blank" rel="noopener noreferrer">
          {linkMatch[1]}
        </a>
      );
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Plain text — consume until next special character
    const nextSpecial = remaining.search(/[`*[]/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    } else if (nextSpecial === 0) {
      // Special char that didn't match any pattern — consume it as text
      parts.push(remaining[0]);
      remaining = remaining.slice(1);
    } else {
      parts.push(remaining.slice(0, nextSpecial));
      remaining = remaining.slice(nextSpecial);
    }
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}
