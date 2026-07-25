import type { DetectionPack } from '../types';

export const gitPack: DetectionPack = {
  name: 'git',
  safePatterns: [
    {
      name: 'checkout-new-branch',
      regex: /^\s*git\s+(?:\S+\s+)*checkout\s+-b\s+\S+(?:\s+\S+)*\s*$/i,
      description: 'Creating a new branch with checkout -b',
    },
    {
      name: 'checkout-orphan',
      regex: /^\s*git\s+(?:\S+\s+)*checkout\s+--orphan\s+\S+(?:\s+\S+)*\s*$/i,
      description: 'Creating an orphan branch',
    },
    {
      name: 'restore-staged',
      regex: /^\s*git\s+(?:\S+\s+)*restore\b(?=\s)(?=.*\s(?:--staged|-S)\b)(?!.*\s(?:--worktree|-W)\b).*\s*$/i,
      description: 'Restore --staged only (unstaging)',
    },
    {
      name: 'clean-dry-run',
      regex: /^\s*git\s+(?:\S+\s+)*clean\s+(?:-[a-z]*n[a-z]*|--dry-run)(?:\s+\S+)*\s*$/i,
      description: 'Git clean dry run preview',
    },
    {
      name: 'push-force-with-lease',
      regex: /^(?!.*(?:^|\s)(?:--force|-[a-z]*f[a-z]*)(?=\s|$))\s*git\s+(?:\S+\s+)*push\s+.*--force-with-lease(?:=\S+)?(?:\s+\S+)*\s*$/i,
      description: 'Safe force push with lease',
    },
  ],
  destructivePatterns: [
    {
      name: 'reset-hard',
      regex: /\bgit\s+(?:\S+\s+)*reset\s+--hard/i,
      description: 'Destroys uncommitted changes',
    },
    {
      name: 'checkout-discard',
      regex: /\bgit\s+(?:\S+\s+)*checkout\s+--\s+/i,
      description: 'Discards working tree changes',
    },
    {
      name: 'restore-worktree',
      regex: /\bgit\s+(?:\S+\s+)*restore\b(?=\s)(?:(?=.*\s(?:--worktree|-W)\b)|(?!.*\s(?:--staged|-S)\b))/i,
      description: 'Restore without --staged discards working tree changes',
    },
    {
      name: 'clean-force',
      regex: /\bgit\s+(?:\S+\s+)*clean\s+(?:-[a-z]*f|--force\b)/i,
      description: 'Force clean removes untracked files',
    },
    {
      name: 'push-force',
      regex: /\bgit\s+(?:\S+\s+)*push\s+(?:\S+\s+)*--force(?![-a-z])/i,
      description: 'Force push overwrites remote history',
    },
    {
      name: 'push-force-short',
      regex: /\bgit\s+(?:\S+\s+)*push\s+(?:\S+\s+)*-[a-z]*f/i,
      description: 'Short flag force push overwrites remote history',
    },
    {
      name: 'branch-force-delete',
      regex: /\bgit\s+(?:\S+\s+)*branch\s+(?:\S+\s+)*-D\b/i,
      description: 'Force delete branch',
    },
    {
      name: 'stash-drop',
      regex: /\bgit\s+(?:\S+\s+)*stash\s+drop\b/i,
      description: 'Drop a stash entry',
    },
    {
      name: 'stash-clear',
      regex: /\bgit\s+(?:\S+\s+)*stash\s+clear\b/i,
      description: 'Clear all stash entries',
    },
  ],
};
