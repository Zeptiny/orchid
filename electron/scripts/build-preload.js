#!/usr/bin/env node
/**
 * Bundle the preload script with esbuild.
 * Required because sandbox:true restricts require() to the preload's own directory.
 */
const esbuild = require('esbuild');
const path = require('path');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'preload', 'index.ts')],
  bundle: true,
  outfile: path.join(__dirname, '..', 'dist', 'preload', 'index.js'),
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
});
