import * as fs from 'node:fs';

/**
 * Best-effort fsync. On Windows, fsync fails with EPERM on directory fds and
 * on files held by antivirus/indexing services. The atomic rename pattern still
 * provides crash safety; fsync is a durability optimization, not a requirement.
 */
export function safeFsync(fd: number): void {
  try {
    fs.fsyncSync(fd);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EINVAL' || code === 'EBADF') return;
    throw err;
  }
}
