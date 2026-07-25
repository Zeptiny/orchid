/**
 * ESM-only package loader for CommonJS builds.
 *
 * TypeScript transpiles `await import('x')` into `require('x')` when
 * `"module": "CommonJS"` — this helper uses `new Function` to preserve
 * the native dynamic `import()` so ESM-only packages can be loaded at runtime.
 */
const _dynamicImport: (specifier: string) => Promise<any> = // eslint-disable-line @typescript-eslint/no-explicit-any
  new Function('specifier', 'return import(specifier)') as any; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Dynamically import an ESM-only package from CommonJS code.
 *
 * @param specifier - The package specifier (e.g. `'ai'`, `'@ai-sdk/openai'`)
 * @returns The loaded module
 */
export async function importESM<T = unknown>(specifier: string): Promise<T> {
  return _dynamicImport(specifier) as Promise<T>;
}
