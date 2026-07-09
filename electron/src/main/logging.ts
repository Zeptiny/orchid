/**
 * Persistent file logging — U3.
 *
 * Captures all console.* calls and mirrors them to ~/.orchid/logs/orchid.log.
 * Uses fs.createWriteStream with auto-flush for async, non-blocking writes.
 *
 * Format: YYYY-MM-DD HH:mm:ss LEVEL message
 * Log level controlled by ORCHID_LOG_LEVEL env var (default: INFO).
 *
 * Matches Python src/orchid/main.py:_setup_logging() behavior.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LOG_DIR = path.join(os.homedir(), '.orchid', 'logs');
export const LOG_FILE = path.join(LOG_DIR, 'orchid.log');

const _LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
type Level = (typeof _LEVELS)[number];

const LEVEL_RANK: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format a Date as YYYY-MM-DD HH:mm:ss. */
function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Format a log line matching Python's logging.Formatter output. */
export function formatLogLine(level: Level, args: unknown[]): string {
  const timestamp = formatTimestamp(new Date());
  const message = args
    .map((a) => (typeof a === 'string' ? a : safeInspect(a)))
    .join(' ');
  return `${timestamp} ${level} ${message}\n`;
}

/** Safe JSON.stringify with fallback for circular refs. */
function safeInspect(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

// ---------------------------------------------------------------------------
// FileLogger
// ---------------------------------------------------------------------------

export class FileLogger {
  private stream: fs.WriteStream | null = null;
  private minLevel: number;
  private failed = false;

  /** Original console methods — preserved so they always work. */
  private origLog: typeof console.log;
  private origWarn: typeof console.warn;
  private origError: typeof console.error;
  private origDebug: typeof console.debug;

  constructor(options?: { logDir?: string; logFile?: string }) {
    const logDir = options?.logDir ?? LOG_DIR;
    const logFile = options?.logFile ?? LOG_FILE;

    // Resolve min level from env
    const envLevel = (process.env['ORCHID_LOG_LEVEL'] ?? 'INFO').toUpperCase();
    this.minLevel = LEVEL_RANK[envLevel as Level] ?? LEVEL_RANK['INFO'];

    // Preserve originals
    this.origLog = console.log.bind(console);
    this.origWarn = console.warn.bind(console);
    this.origError = console.error.bind(console);
    this.origDebug = console.debug.bind(console);

    // Create log directory and stream
    try {
      fs.mkdirSync(logDir, { recursive: true });
      // Touch file synchronously so it exists before the stream opens.
      // This avoids a race where tests check existence before the async open completes.
      fs.writeFileSync(logFile, '', { flag: 'a' });
      this.stream = fs.createWriteStream(logFile, { flags: 'a' });
      this.stream.on('error', (err) => {
        // Stream errors are non-fatal — just stop writing to file
        this.failed = true;
        this.stream?.end();
        this.stream = null;
        this.origWarn('FileLogger: stream error, file logging disabled:', err.message);
      });
    } catch (err) {
      // Directory creation failed — disable file logging
      this.failed = true;
      this.origWarn('FileLogger: failed to initialize, file logging disabled:', err);
    }
  }

  /** Install console.* overrides. Call once at startup. */
  install(): void {
    console.log = (...args: unknown[]) => {
      this.origLog(...args);
      this.write('INFO', args);
    };

    console.warn = (...args: unknown[]) => {
      this.origWarn(...args);
      this.write('WARN', args);
    };

    console.error = (...args: unknown[]) => {
      this.origError(...args);
      this.write('ERROR', args);
    };

    console.debug = (...args: unknown[]) => {
      this.origDebug(...args);
      this.write('DEBUG', args);
    };
  }

  /** Restore original console.* methods. For cleanup in tests. */
  uninstall(): void {
    console.log = this.origLog;
    console.warn = this.origWarn;
    console.error = this.origError;
    console.debug = this.origDebug;
  }

  /** Close the write stream. Call on app shutdown. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) {
        resolve();
        return;
      }
      const s = this.stream;
      this.stream = null;
      s.end(() => resolve());
    });
  }

  /** Check if file logging is active. */
  get isActive(): boolean {
    return this.stream !== null && !this.failed;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private write(level: Level, args: unknown[]): void {
    if (this.failed || !this.stream) return;
    if (LEVEL_RANK[level] < this.minLevel) return;

    try {
      const line = formatLogLine(level, args);
      this.stream.write(line);
    } catch {
      // Write failed — don't crash, just disable
      this.failed = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton — initialized once at startup
// ---------------------------------------------------------------------------

let _instance: FileLogger | null = null;

/**
 * Initialize file logging. Call once at app startup.
 * Returns the FileLogger instance for testing.
 */
export function initFileLogging(options?: { logDir?: string; logFile?: string }): FileLogger {
  if (_instance) return _instance;
  _instance = new FileLogger(options);
  _instance.install();
  return _instance;
}

/**
 * Get the active FileLogger instance (or null if not initialized).
 */
export function getFileLogger(): FileLogger | null {
  return _instance;
}

/**
 * Close and reset the singleton. For graceful shutdown or testing.
 */
export async function closeFileLogging(): Promise<void> {
  const inst = _instance;
  _instance = null;
  if (inst) {
    await inst.close();
    inst.uninstall();
  }
}
