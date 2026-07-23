import { describe, expect, it } from 'vitest';

import { createDefaultEngine } from '../../src/main/permissions/detection';

describe('permission command detection', () => {
  const compoundCommands = [
    'rm -rf /tmp/cache && rm -rf /',
    'rm -rf /tmp/cache || rm -rf /',
    'rm -rf /tmp/cache; rm -rf /',
    'rm -rf /tmp/cache | rm -rf /',
    'rm -rf /tmp/cache\nrm -rf /',
    '(rm -rf /tmp/cache; rm -rf /)',
    'rm -rf / && rm -rf /tmp/cache',
    'rm -rf / /tmp/cache',
    'rm -rf /tmp/cache/../..',
    'git clean -n && git reset --hard',
    'git restore --staged --worktree tracked.txt',
    'git push --force --force-with-lease origin main',
    'git push -f --force-with-lease origin main',
  ];

  it.each(compoundCommands)(
    'flags a destructive executable segment in %j',
    (command) => {
      expect(createDefaultEngine().evaluate(command)).toMatchObject({
        flagged: true,
      });
    },
  );

  it.each([
    'rm -rf /tmp/cache',
    'rm -rf "/tmp/cache;still-one-path"',
    'rm -rf "/tmp/cache&&still-one-path"',
    String.raw`rm -rf /tmp/cache\;still-one-path`,
    String.raw`rm -rf /tmp/cache\&\&still-one-path`,
    'git clean -n',
  ])('keeps independently safe commands unflagged: %j', (command) => {
    expect(createDefaultEngine().evaluate(command)).toEqual({ flagged: false });
  });

  it('does not let a safe suffix inside a quoted subshell launder deletion', () => {
    const result = createDefaultEngine().evaluate(
      'echo "$(rm -rf /)" && rm -rf /tmp/cache',
    );

    expect(result).toMatchObject({ flagged: true });
  });

  it.each([
    'rm -rf /tmp/$(echo cache)',
    'rm -rf "/tmp/$(echo cache)"',
    'rm -rf /tmp/`echo cache`',
    'rm -rf /tmp/$CACHE_DIR',
    'rm -rf /tmp/$((1 + 1))',
    'rm -rf /tmp/{cache,build}',
    'rm -rf /tmp/cache*',
    'rm -rf /tmp/cache > /tmp/log',
    'rm -rf /tmp/cache < /tmp/list',
    'rm -rf /tmp/cache <(echo nested)',
    'git clean -n > /tmp/preview',
    'git clean -n "$(git reset --hard)"',
    'git push --force-with-lease origin ${BRANCH}',
    'git checkout -b feature/{one,two}',
    '(git clean -n)',
    'git clean -n &',
    String.raw`git clean -n \
--dry-run`,
  ])('flags non-literal shell syntax instead of applying a safe exception: %j', (command) => {
    expect(createDefaultEngine().evaluate(command)).toMatchObject({
      flagged: true,
      pattern: 'unsupported-shell-syntax',
    });
  });
});
