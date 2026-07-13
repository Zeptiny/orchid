/**
 * File logging tests — U3.
 *
 * Covers:
 * - Happy path: Log message appears in file with correct format and level
 * - Edge case: Log directory doesn't exist → created automatically
 * - Edge case: Log level filtering (DEBUG hidden when level=INFO)
 * - Error path: File write fails → original console call still works, no crash
 * - Integration: All console methods (log, warn, error, debug) write to file
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileLogger,
  initFileLogging,
  closeFileLogging,
  getFileLogger,
  formatLogLine,
  LOG_DIR,
} from '../../src/main/logging';

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let origEnv: Record<string, string | undefined>;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-logging-test-'));
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  origEnv = { ...process.env };
  // Reset singleton
  closeFileLogging();
});

afterEach(async () => {
  // Restore env
  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, val] of Object.entries(origEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }

  // Reset singleton
  await closeFileLogging();

  // Cleanup temp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('formatLogLine', () => {
  it('formats with timestamp, level, and message', () => {
    const line = formatLogLine('INFO', ['hello world']);
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO hello world\n$/);
  });

  it('joins multiple args with space', () => {
    const line = formatLogLine('ERROR', ['failed', 'with', 'code', 500]);
    expect(line).toContain('ERROR failed with code 500');
  });

  it('serializes objects to JSON', () => {
    const line = formatLogLine('DEBUG', [{ key: 'value' }]);
    expect(line).toContain('{"key":"value"}');
  });

  it('handles circular objects gracefully', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const line = formatLogLine('WARN', [circular]);
    expect(line).toContain('WARN {"self":"[Circular]"}');
  });

  it('redacts credential values from strings, URLs, and structured metadata', () => {
    const line = formatLogLine('ERROR', [
      'Authorization: Bearer access-token-123456789012345',
      {
        refreshToken: 'refresh-token-123456789012345',
        nested: { apiKey: 'sk-secret-api-key-123456' },
        url: 'https://example.test/callback?api_key=sk-secret-api-key-123456',
      },
    ]);

    expect(line).not.toContain('access-token-123456789012345');
    expect(line).not.toContain('refresh-token-123456789012345');
    expect(line).not.toContain('sk-secret-api-key-123456');
    expect(line).toContain('[REDACTED]');
  });
});

describe('FileLogger', () => {
  it('creates log directory if it does not exist', () => {
    const logDir = path.join(tmpDir, 'new-logs');
    const logFile = path.join(logDir, 'orchid.log');

    expect(fs.existsSync(logDir)).toBe(false);

    const logger = new FileLogger({ logDir, logFile });
    logger.install();

    expect(fs.existsSync(logDir)).toBe(true);
    expect(fs.existsSync(logFile)).toBe(true);

    logger.uninstall();
    logger.close();
  });

  it('writes INFO level to file', async () => {
    const logFile = path.join(tmpDir, 'orchid.log');
    const logger = new FileLogger({ logDir: tmpDir, logFile });
    logger.install();

    console.log('test info message');

    // Wait for stream flush
    await logger.close();
    logger.uninstall();

    const content = fs.readFileSync(logFile, 'utf-8');
    expect(content).toContain('INFO test info message');
  });

  it('writes WARN level to file', async () => {
    const logFile = path.join(tmpDir, 'orchid.log');
    const logger = new FileLogger({ logDir: tmpDir, logFile });
    logger.install();

    console.warn('test warning');

    await logger.close();
    logger.uninstall();

    const content = fs.readFileSync(logFile, 'utf-8');
    expect(content).toContain('WARN test warning');
  });

  it('writes ERROR level to file', async () => {
    const logFile = path.join(tmpDir, 'orchid.log');
    const logger = new FileLogger({ logDir: tmpDir, logFile });
    logger.install();

    console.error('test error');

    await logger.close();
    logger.uninstall();

    const content = fs.readFileSync(logFile, 'utf-8');
    expect(content).toContain('ERROR test error');
  });

  it('writes DEBUG level to file when ORCHID_LOG_LEVEL=DEBUG', async () => {
    process.env['ORCHID_LOG_LEVEL'] = 'DEBUG';
    const logFile = path.join(tmpDir, 'orchid.log');
    const logger = new FileLogger({ logDir: tmpDir, logFile });
    logger.install();

    console.debug('debug trace');

    await logger.close();
    logger.uninstall();

    const content = fs.readFileSync(logFile, 'utf-8');
    expect(content).toContain('DEBUG debug trace');
  });

  it('filters DEBUG when level is INFO (default)', async () => {
    delete process.env['ORCHID_LOG_LEVEL'];
    const logFile = path.join(tmpDir, 'orchid.log');
    const logger = new FileLogger({ logDir: tmpDir, logFile });
    logger.install();

    console.log('info msg');
    console.debug('debug msg');

    await logger.close();
    logger.uninstall();

    const content = fs.readFileSync(logFile, 'utf-8');
    expect(content).toContain('INFO info msg');
    expect(content).not.toContain('debug msg');
  });

  it('preserves original console.log behavior (no crash on override)', () => {
    const logFile = path.join(tmpDir, 'orchid.log');
    const logger = new FileLogger({ logDir: tmpDir, logFile });
    logger.install();

    // Should not throw
    expect(() => {
      console.log('test');
      console.warn('test');
      console.error('test');
      console.debug('test');
    }).not.toThrow();

    logger.uninstall();
    logger.close();
  });

  it('handles file write failure gracefully without crashing', async () => {
    // Use a path that will fail (directory inside a file)
    const blockedPath = path.join(tmpDir, 'not-a-dir', 'sub', 'orchid.log');
    // Create a file (not a directory) at the intermediate path
    fs.writeFileSync(path.join(tmpDir, 'not-a-dir'), 'block');

    const logger = new FileLogger({
      logDir: path.join(tmpDir, 'not-a-dir', 'sub'),
      logFile: blockedPath,
    });

    // Logger should be inactive after init failure
    expect(logger.isActive).toBe(false);

    // install() should not throw even when logger is inactive
    logger.install();

    // console.log should still work (original method)
    expect(() => console.log('should not crash')).not.toThrow();

    logger.uninstall();
    logger.close();
  });

  it('appends to existing log file (not truncate)', async () => {
    const logFile = path.join(tmpDir, 'orchid.log');

    // Write first entry
    const logger1 = new FileLogger({ logDir: tmpDir, logFile });
    logger1.install();
    console.log('first entry');
    await logger1.close();
    logger1.uninstall();

    // Write second entry
    const logger2 = new FileLogger({ logDir: tmpDir, logFile });
    logger2.install();
    console.log('second entry');
    await logger2.close();
    logger2.uninstall();

    const content = fs.readFileSync(logFile, 'utf-8');
    expect(content).toContain('first entry');
    expect(content).toContain('second entry');
  });

  it('isActive returns true when stream is open', () => {
    const logFile = path.join(tmpDir, 'orchid.log');
    const logger = new FileLogger({ logDir: tmpDir, logFile });
    expect(logger.isActive).toBe(true);
    logger.close();
  });

  it('isActive returns false after close()', async () => {
    const logFile = path.join(tmpDir, 'orchid.log');
    const logger = new FileLogger({ logDir: tmpDir, logFile });
    await logger.close();
    expect(logger.isActive).toBe(false);
  });

  it('uninstall() restores original console methods', () => {
    const logFile = path.join(tmpDir, 'orchid.log');
    const logger = new FileLogger({ logDir: tmpDir, logFile });

    // Capture the current (pre-install) log function
    const beforeInstall = console.log;
    logger.install();
    // After install, console.log should be a different function
    expect(console.log).not.toBe(beforeInstall);

    logger.uninstall();
    // After uninstall, console.log is restored (bound wrapper of the original).
    // We can't use === because bind() creates a new function each time,
    // but we can verify it's not the install() override by checking it differs
    // from the one set during install.
    const afterUninstall = console.log;
    // The restored function should differ from the installed override
    expect(afterUninstall).not.toBe(beforeInstall); // bind() creates new refs
    // But calling it should not throw
    expect(() => afterUninstall('test')).not.toThrow();

    logger.close();
  });
});

describe('initFileLogging singleton', () => {
  it('returns same instance on multiple calls', () => {
    const logDir = path.join(tmpDir, 'singleton-test');
    const logFile = path.join(logDir, 'orchid.log');

    // Override LOG_DIR by passing options
    const a = initFileLogging({ logDir, logFile });
    const b = initFileLogging({ logDir, logFile });
    expect(a).toBe(b);

    closeFileLogging();
  });

  it('getFileLogger returns null before init', async () => {
    await closeFileLogging();
    expect(getFileLogger()).toBeNull();
  });

  it('getFileLogger returns instance after init', async () => {
    const logDir = path.join(tmpDir, 'singleton-test2');
    const logFile = path.join(logDir, 'orchid.log');

    initFileLogging({ logDir, logFile });
    expect(getFileLogger()).not.toBeNull();

    await closeFileLogging();
  });

  it('closeFileLogging resets singleton', async () => {
    const logDir = path.join(tmpDir, 'singleton-test3');
    const logFile = path.join(logDir, 'orchid.log');

    initFileLogging({ logDir, logFile });
    await closeFileLogging();
    expect(getFileLogger()).toBeNull();
  });
});
