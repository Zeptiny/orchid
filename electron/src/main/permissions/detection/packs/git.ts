import type { DetectionPack } from '../types';

export const gitPack: DetectionPack = {
  name: 'git',
  safePatterns: [
    {
      name: 'checkout-new-branch',
      regex: /\bgit\s+(?:\S+\s+)*checkout\s+-b\s+/i,
      description: 'Creating a new branch with checkout -b',
    },
    {
      name: 'checkout-orphan',
      regex: /\bgit\s+(?:\S+\s+)*checkout\s+--orphan\s+/i,
      description: 'Creating an orphan branch',
    },
    {
      name: 'restore-staged',
      regex: /\bgit\s+(?:\S+\s+)*restore\b(?=\s)(?=.*\s--staged\b)/i,
      description: 'Restore --staged only (unstaging)',
    },
    {
      name: 'clean-dry-run',
      regex: /\bgit\s+(?:\S+\s+)*clean\s+(-[a-z]*n|--dry-run)/i,
      description: 'Git clean dry run preview',
    },
    {
      name: 'push-force-with-lease',
      regex: /\bgit\s+(?:\S+\s+)*push\s+.*--force-with-lease/i,
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
      regex: /\bgit\s+(?:\S+\s+)*restore\b(?=\s)(?!.*\s(?:--staged|-S)\b)/i,
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
