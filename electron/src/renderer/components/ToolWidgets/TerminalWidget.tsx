/**
 * TerminalWidget — xterm.js terminal for execute_command tool.
 *
 * Features:
 * - Streaming output display
 * - Interactive input (if command is interactive)
 * - Fit addon for responsive sizing
 *
 * Supported tools: execute_command.
 */
import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ToolCallEvent } from './types';

// ── Props ────────────────────────────────────────────────────────────────────

interface TerminalWidgetProps {
  /** The tool call event. */
  event: ToolCallEvent;
}

// ── Component ────────────────────────────────────────────────────────────────

export function TerminalWidget({ event }: TerminalWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isInteractive, setIsInteractive] = useState(false);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#4a9eff',
        selectionBackground: '#4a9eff40',
      },
      fontSize: 12,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      cursorBlink: false,
      disableStdin: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Write initial command info
    const command = (event.args.command as string) ?? '';
    const isBg = event.args.background === true;
    const isInteractiveCmd = event.args.interactive === true;

    setIsInteractive(isInteractiveCmd && isBg);

    terminal.writeln(`\x1b[1;36m$\x1b[0m ${command}`);
    if (isBg) {
      terminal.writeln(`\x1b[33m[background process]\x1b[0m`);
    }
    terminal.writeln('');

    return () => {
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [event.id]);

  // Write result content when completed
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    if (event.status === 'completed' && event.result) {
      // Write output line by line
      const lines = event.result.split('\n');
      for (const line of lines) {
        terminal.writeln(line);
      }
      terminal.writeln('');
      terminal.writeln('\x1b[32m[completed]\x1b[0m');
    } else if (event.status === 'error' && event.error) {
      terminal.writeln(`\x1b[31m[error] ${event.error}\x1b[0m`);
    } else if (event.status === 'running') {
      terminal.writeln('\x1b[33m[running...]\x1b[0m');
    }
  }, [event.status, event.result, event.error]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      fitAddonRef.current?.fit();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Handle interactive input
  const handleInput = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && isInteractive) {
        const input = e.currentTarget.value;
        if (input && window.orchid?.tool?.execute) {
          window.orchid.tool.execute({
            name: 'send_input',
            args: { command_id: event.id, input },
          });
          terminalRef.current?.writeln(`\x1b[36m>\x1b[0m ${input}`);
          e.currentTarget.value = '';
        }
      }
    },
    [isInteractive, event.id],
  );

  return (
    <div className="tool-widget-terminal">
      <div className="tool-widget-terminal-header">
        <span className="tool-widget-terminal-label">Terminal</span>
        <span className="tool-widget-terminal-command">
          {(event.args.command as string) ?? ''}
        </span>
        <span className={`tool-widget-terminal-status tool-widget-terminal-status-${event.status}`}>
          {event.status}
        </span>
      </div>
      <div className="tool-widget-terminal-body" ref={containerRef} />
      {isInteractive && event.status === 'running' && (
        <div className="tool-widget-terminal-input-row">
          <span className="tool-widget-terminal-prompt">&gt;</span>
          <input
            type="text"
            className="tool-widget-terminal-input"
            placeholder="Type input and press Enter..."
            onKeyDown={handleInput}
            autoFocus
          />
        </div>
      )}
    </div>
  );
}
