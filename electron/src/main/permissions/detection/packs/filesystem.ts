import type { DetectionPack } from '../types';

export const filesystemPack: DetectionPack = {
  name: 'filesystem',
  safePatterns: [
    {
      name: 'rm-temp',
      regex: /\brm\s+.*(?:\/tmp\/|\/var\/tmp\/|node_modules\/\.cache|\.next\/cache)/i,
      description: 'rm targeting temporary or cache paths',
    },
    {
      name: 'rm-help',
      regex: /\brm\s+(?:--help|--version)\b/i,
      description: 'rm help or version output',
    },
    {
      name: 'find-help',
      regex: /\bfind\s+(?:--help|--version)\b/i,
      description: 'find help or version output',
    },
  ],
  destructivePatterns: [
    {
      name: 'rm-recursive',
      regex: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive\s+--force|-r\s+-f|--force\s+--recursive)\b/i,
      description: 'Recursive force delete',
    },
    {
      name: 'rm-recursive-alt',
      regex: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*r)\b/i,
      description: 'Combined -fr flag recursive delete',
    },
    {
      name: 'rm-rf-path',
      regex: /\brm\s+-rf?\s+(?!\/tmp\/|\/var\/tmp\/)/i,
      description: 'rm -rf not targeting temp directories',
    },
    {
      name: 'find-delete',
      regex: /\bfind\s+.*-delete\b/i,
      description: 'find with -delete flag',
    },
    {
      name: 'find-exec-rm',
      regex: /\bfind\s+.*-exec\s+rm\b/i,
      description: 'find with -exec rm',
    },
    {
      name: 'truncate-zero',
      regex: /\btruncate\s+-s\s*0\b/i,
      description: 'Truncate file to zero bytes',
    },
    {
      name: 'shred',
      regex: /\bshred\b/i,
      description: 'Shred command for secure file deletion',
    },
    {
      name: 'unlink-non-temp',
      regex: /\bunlink\s+(?!\/tmp\/|\/var\/tmp\/)/i,
      description: 'Unlink outside temp directories',
    },
    {
      name: 'mkfs',
      regex: /\bmkfs\b/i,
      description: 'Filesystem format command',
    },
    {
      name: 'dd-device',
      regex: /\bdd\s+.*of=\/dev\//i,
      description: 'dd writing to a device',
    },
  ],
};
