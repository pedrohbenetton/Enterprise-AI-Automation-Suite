#!/usr/bin/env node
// Gera workflows/*.json (formato de import do n8n) a partir de workflows/src/*.mjs.
//   npm run build            -> (re)gera os arquivos
//   npm run build -- --check -> falha se o JSON versionado estiver desatualizado (CI)

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../workflows/src/lib.mjs';

const SRC_DIR = path.join(ROOT, 'workflows', 'src');
const OUT_DIR = path.join(ROOT, 'workflows');

export async function buildAll() {
  const files = readdirSync(SRC_DIR).filter((f) => /^\d{2}-.+\.mjs$/.test(f)).sort();
  const outputs = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(SRC_DIR, file)).href);
    const workflow = mod.default();
    outputs.push({
      file: path.join(OUT_DIR, file.replace(/\.mjs$/, '.json')),
      content: `${JSON.stringify(workflow, null, 2)}\n`,
      workflow,
    });
  }
  return outputs;
}

async function main() {
  const check = process.argv.includes('--check');
  const outputs = await buildAll();
  let stale = 0;
  for (const { file, content } of outputs) {
    const rel = path.relative(ROOT, file);
    if (check) {
      const current = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
      if (current !== content) {
        stale++;
        console.error(`desatualizado: ${rel}`);
      }
    } else {
      writeFileSync(file, content, 'utf8');
      console.log(`gerado: ${rel}`);
    }
  }
  if (check && stale) {
    console.error('Rode "npm run build" e versione o resultado.');
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
