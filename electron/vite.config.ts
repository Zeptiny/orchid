import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'path';

function themeAssets() {
  const themeDir = path.resolve(__dirname, 'src/renderer/themes');
  return {
    name: 'orchid-theme-assets',
    generateBundle() {
      for (const fileName of fs.readdirSync(themeDir)) {
        if (!fileName.endsWith('.css')) continue;
        this.emitFile({
          type: 'asset',
          fileName: `themes/${fileName}`,
          source: fs.readFileSync(path.join(themeDir, fileName), 'utf8'),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), themeAssets()],
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    root: path.resolve(__dirname),
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    teardownTimeout: 1000,
  },
});
