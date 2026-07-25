export interface DetectionPattern {
  name: string;
  regex: RegExp;
  description: string;
}

export interface DetectionPack {
  name: string;
  safePatterns: DetectionPattern[];
  destructivePatterns: DetectionPattern[];
}

export interface DetectionResult {
  flagged: boolean;
  pattern?: string;
  description?: string;
}
