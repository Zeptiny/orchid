export { DetectionEngine } from './engine';
export type { DetectionResult, DetectionPack, DetectionPattern } from './types';
export { filesystemPack } from './packs/filesystem';
export { gitPack } from './packs/git';

import { DetectionEngine } from './engine';
import { filesystemPack } from './packs/filesystem';
import { gitPack } from './packs/git';

export function createDefaultEngine(): DetectionEngine {
  const engine = new DetectionEngine();
  engine.registerPack(filesystemPack);
  engine.registerPack(gitPack);
  return engine;
}
