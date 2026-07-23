import type { DetectionPack, DetectionResult } from './types';

export class DetectionEngine {
  private packs: DetectionPack[] = [];

  registerPack(pack: DetectionPack): void {
    this.packs.push(pack);
  }

  evaluate(command: string): DetectionResult {
    for (const pack of this.packs) {
      for (const pattern of pack.safePatterns) {
        if (pattern.regex.test(command)) {
          return { flagged: false };
        }
      }
    }

    for (const pack of this.packs) {
      for (const pattern of pack.destructivePatterns) {
        if (pattern.regex.test(command)) {
          return {
            flagged: true,
            pattern: pattern.name,
            description: pattern.description,
          };
        }
      }
    }

    return { flagged: false };
  }
}
