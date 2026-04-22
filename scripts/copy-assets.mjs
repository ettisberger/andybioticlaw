#!/usr/bin/env node
// Copies non-TypeScript assets (migrations .sql, prompts .md) into dist/ so
// `node dist/index.js` finds them via the same relative paths used in src/.
import { readdirSync, statSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const srcRoot = resolve(root, 'src');
const outRoot = resolve(root, 'dist');

const extensions = new Set(['.sql', '.md']);
let copied = 0;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full);
      continue;
    }
    const ext = full.slice(full.lastIndexOf('.'));
    if (!extensions.has(ext)) continue;
    const rel = relative(srcRoot, full);
    const target = resolve(outRoot, rel);
    const targetDir = dirname(target);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    copyFileSync(full, target);
    copied += 1;
  }
}

walk(srcRoot);
console.log(`[copy-assets] copied ${copied} file(s) to dist/`);
