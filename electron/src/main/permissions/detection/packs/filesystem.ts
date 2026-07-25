import type { DetectionPack } from '../types';

export const filesystemPack: DetectionPack = {
  name: 'filesystem',
  safePatterns: [
    {
      name: 'rm-temp',
      regex: /^(?!.*(?:^|\/)\.\.(?:\/|\s|["']|$))\s*rm\s+(?:(?:-[a-z]+|--[a-z-]+)\s+)*(?:(?:["']?(?:\/tmp\/|\/var\/tmp\/)[^\s"']+["']?|["']?\S*(?:node_modules\/\.cache|\.next\/cache)(?:\/[^\s"']*)?["']?)\s*)+$/i,
      description: 'rm targeting temporary or cache paths',
    },
    {
      name: 'rm-help',
      regex: /^\s*rm\s+(?:--help|--version)\s*$/i,
      description: 'rm help or version output',
    },
    {
      name: 'find-help',
      regex: /^\s*find\s+(?:--help|--version)\s*$/i,
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
      name: 'rm-long-recursive',
      regex: /\brm\b.*--recursive\b/i,
      description: 'Recursive delete via long-form --recursive flag',
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
      name: 'find-execdir',
      regex: /\bfind\s+.*-execdir\b/i,
      description: 'find with -execdir running a command per match',
    },
    {
      name: 'chmod-recursive',
      regex: /\bchmod\s+(?:\S+\s+)*-[a-zA-Z]*R[a-zA-Z]*(?:\s|$)/i,
      description: 'Recursive chmod changes permissions across a tree',
    },
    {
      name: 'chown-recursive',
      regex: /\bchown\s+(?:\S+\s+)*-[a-zA-Z]*R[a-zA-Z]*(?:\s|$)/i,
      description: 'Recursive chown changes ownership across a tree',
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
