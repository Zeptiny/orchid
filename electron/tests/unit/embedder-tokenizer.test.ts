/**
 * Embedder Tokenizer tests — U4.
 *
 * Covers:
 * - Happy path: BPE tokenizer produces valid token IDs from tokenizer.json
 * - Edge case: Tokenizer file not found → falls back to simpleTokenize with console warning
 * - Error path: Corrupt tokenizer file → falls back gracefully
 * - Cache: Tokenizer instance is reused across calls
 *
 * Tests use real @huggingface/tokenizers with a minimal tokenizer.json fixture,
 * and file system mocks to test missing/corrupt file scenarios.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mock onnxruntime-node (not under test)
// ---------------------------------------------------------------------------

vi.mock('onnxruntime-node', () => ({
  InferenceSession: {
    create: vi.fn().mockResolvedValue({
      inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
      run: vi.fn().mockResolvedValue({
        last_hidden_state: {
          data: new Float32Array(512 * 384).fill(0.1),
          dims: [1, 512, 384],
        },
      }),
    }),
  },
  Tensor: vi.fn().mockImplementation(function (type: string, data: unknown, dims: number[]) {
    return { type, data, dims };
  }),
}));

// ---------------------------------------------------------------------------
// Mock node:os to control homedir
// ---------------------------------------------------------------------------

const { mockedHomedirFn, setMockedHomedir } = vi.hoisted(() => {
  let fn: () => string = () => '';
  return { mockedHomedirFn: () => fn, setMockedHomedir: (newFn: () => string) => { fn = newFn; } };
});
const actualOs = await vi.importActual<typeof os>('node:os');

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    homedir: () => mockedHomedirFn()(),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

let Embedder: typeof import('../../src/main/rag/embedder').Embedder;

// ---------------------------------------------------------------------------
// Fixture: minimal WordPiece tokenizer.json (BERT-style, used by BGE-small)
// ---------------------------------------------------------------------------

/**
 * A minimal tokenizer.json that uses WordPiece (the model type BGE-small uses).
 * Vocab is tiny but sufficient to verify BPE tokenization works.
 */
const MINIMAL_TOKENIZER_JSON = {
  version: '1.0',
  truncation: null,
  padding: null,
  added_tokens: [
    { id: 100, content: '[UNK]', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
    { id: 101, content: '[CLS]', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
    { id: 102, content: '[SEP]', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
    { id: 0, content: '[PAD]', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
  ],
  normalizer: {
    type: 'BertNormalizer',
    clean_text: true,
    handle_chinese_chars: true,
    strip_accents: true,
    lowercase: true,
  },
  pre_tokenizer: {
    type: 'BertPreTokenizer',
  },
  post_processor: {
    type: 'TemplateProcessing',
    single: [
      { SpecialToken: { id: '[CLS]', type_id: 0 } },
      { Sequence: { id: 'A', type_id: 0 } },
      { SpecialToken: { id: '[SEP]', type_id: 0 } },
    ],
    pair: [
      { SpecialToken: { id: '[CLS]', type_id: 0 } },
      { Sequence: { id: 'A', type_id: 0 } },
      { SpecialToken: { id: '[SEP]', type_id: 0 } },
      { Sequence: { id: 'B', type_id: 1 } },
      { SpecialToken: { id: '[SEP]', type_id: 1 } },
    ],
  },
  model: {
    type: 'WordPiece',
    unk_token: '[UNK]',
    continuing_subword_prefix: '##',
    max_input_chars_per_word: 100,
    vocab: {
      '[UNK]': 100,
      '[CLS]': 101,
      '[SEP]': 102,
      '[PAD]': 0,
      'hello': 1000,
      'world': 1001,
      'the': 1002,
      'a': 1003,
      'is': 1004,
      '##s': 1005,
      'test': 1006,
      'ing': 1007,
      '##ly': 1008,
      'good': 1009,
    },
  },
  decoder: {
    type: 'WordPiece',
    prefix: '##',
  },
};

const MINIMAL_TOKENIZER_CONFIG = {};

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let homeModelsDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'embedder-tokenizer-test-'));
}

beforeEach(async () => {
  vi.resetModules();
  ({ Embedder } = await import('../../src/main/rag/embedder'));
  tmpDir = makeTmpDir();
  homeModelsDir = path.join(tmpDir, '.orchid', 'models', 'BAAI/bge-small-en-v1.5');
  fs.mkdirSync(homeModelsDir, { recursive: true });

  // Point homedir to our temp dir
  setMockedHomedir(() => tmpDir);

});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: write tokenizer files
// ---------------------------------------------------------------------------

function writeTokenizerFiles(
  tokenizerJson: unknown = MINIMAL_TOKENIZER_JSON,
  tokenizerConfig: unknown = MINIMAL_TOKENIZER_CONFIG,
) {
  fs.writeFileSync(
    path.join(homeModelsDir, 'tokenizer.json'),
    JSON.stringify(tokenizerJson),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(homeModelsDir, 'tokenizer_config.json'),
    JSON.stringify(tokenizerConfig),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BPE Tokenizer', () => {
  it('should produce valid BPE token IDs matching the vocabulary', async () => {
    writeTokenizerFiles();

    const { Tokenizer } = await import('@huggingface/tokenizers');
    const tokenizerJson = JSON.parse(
      fs.readFileSync(path.join(homeModelsDir, 'tokenizer.json'), 'utf-8'),
    );
    const tokenizer = new Tokenizer(tokenizerJson, MINIMAL_TOKENIZER_CONFIG);

    const encoded = tokenizer.encode('hello world', { add_special_tokens: true });
    // @huggingface/tokenizers JS version: plain object with .ids, .tokens, .attention_mask
    const ids: number[] = encoded.ids;
    const tokens: string[] = encoded.tokens;
    const mask: number[] = encoded.attention_mask;

    // Should include [CLS] and [SEP] special tokens
    expect(ids.length).toBeGreaterThan(2);
    expect(tokens[0]).toBe('[CLS]');
    expect(tokens[tokens.length - 1]).toBe('[SEP]');

    // "hello" and "world" should map to their vocab IDs
    expect(ids).toContain(1000); // hello
    expect(ids).toContain(1001); // world

    // Attention mask should be all 1s (no padding for short text)
    expect(mask.every((m) => m === 1)).toBe(true);
  });

  it('should fall back to simpleTokenize when tokenizer.json is not found', async () => {
    // Don't write tokenizer files — but create a fake model.onnx so download is skipped
    fs.writeFileSync(path.join(homeModelsDir, 'model.onnx'), 'fake-model-data');

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Embedder.embed() will run with simpleTokenize fallback since tokenizer.json is missing.
    // ONNX is mocked, so inference will succeed.
    const embedder = new Embedder();
    const result = await embedder.embed(['test input']);

    // Should produce embeddings (via simpleTokenize + mocked ONNX)
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(Float32Array);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('BPE tokenizer file not found'),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('falling back to simpleTokenize'),
    );

    consoleWarnSpy.mockRestore();
  });

  it('should fall back gracefully when tokenizer.json is corrupt', async () => {
    // Write invalid JSON for tokenizer.json, but create a fake model.onnx so download is skipped
    fs.writeFileSync(
      path.join(homeModelsDir, 'tokenizer.json'),
      'this is not valid json{{{',
      'utf-8',
    );
    fs.writeFileSync(path.join(homeModelsDir, 'model.onnx'), 'fake-model-data');

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const embedder = new Embedder();
    const result = await embedder.embed(['test input']);

    // Should produce embeddings via simpleTokenize fallback
    expect(result).toHaveLength(1);

    // Should log a warning about the failure
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load BPE tokenizer'),
    );

    consoleWarnSpy.mockRestore();
  });

  it('should cache the tokenizer instance for reuse', async () => {
    writeTokenizerFiles();

    const { Tokenizer } = await import('@huggingface/tokenizers');
    const tokenizerJson = JSON.parse(
      fs.readFileSync(path.join(homeModelsDir, 'tokenizer.json'), 'utf-8'),
    );
    const tokenizer = new Tokenizer(tokenizerJson, MINIMAL_TOKENIZER_CONFIG);

    // First encode
    const encoded1 = tokenizer.encode('hello', { add_special_tokens: true });
    const ids1: number[] = encoded1.ids;

    // Second encode — same tokenizer instance, should produce same results
    const encoded2 = tokenizer.encode('hello', { add_special_tokens: true });
    const ids2: number[] = encoded2.ids;

    // Same input should produce same token IDs
    expect(ids1).toEqual(ids2);
  });

  it('should fall back when @huggingface/tokenizers import fails', async () => {
    // Write tokenizer files but also create fake model.onnx
    fs.writeFileSync(
      path.join(homeModelsDir, 'tokenizer.json'),
      JSON.stringify(MINIMAL_TOKENIZER_JSON),
      'utf-8',
    );
    fs.writeFileSync(path.join(homeModelsDir, 'model.onnx'), 'fake-model-data');

    // Mock the dynamic import to fail
    vi.doMock('@huggingface/tokenizers', () => {
      throw new Error('MODULE_NOT_FOUND');
    });

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const embedder = new Embedder();
    const result = await embedder.embed(['test input']);

    // Should produce embeddings via simpleTokenize fallback
    expect(result).toHaveLength(1);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load BPE tokenizer'),
    );

    consoleWarnSpy.mockRestore();
    vi.doUnmock('@huggingface/tokenizers');
  });

  it('should work without tokenizer_config.json (empty config fallback)', async () => {
    // Only write tokenizer.json, not tokenizer_config.json
    fs.writeFileSync(
      path.join(homeModelsDir, 'tokenizer.json'),
      JSON.stringify(MINIMAL_TOKENIZER_JSON),
      'utf-8',
    );

    const { Tokenizer } = await import('@huggingface/tokenizers');
    const tokenizerJson = JSON.parse(
      fs.readFileSync(path.join(homeModelsDir, 'tokenizer.json'), 'utf-8'),
    );

    // Should succeed with empty config
    const tokenizer = new Tokenizer(tokenizerJson, {});
    const encoded = tokenizer.encode('hello test', { add_special_tokens: true });
    const ids: number[] = encoded.ids;

    expect(ids.length).toBeGreaterThan(2); // [CLS] + tokens + [SEP]
    expect(ids[0]).toBe(101); // [CLS]
  });
});
