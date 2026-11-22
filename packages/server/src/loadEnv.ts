import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Reads the repo-root .env if there is one (any Node 20+; variables already set in the environment win).
 * A missing file is fine: everything then runs in demo mode. `envFile` says where it looked and what happened,
 * so "skipped" messages can point at the real problem (wrong folder, Notepad's .env.txt, unreadable file).
 */
export const envFile = { path: fileURLToPath(new URL('../../../.env', import.meta.url)), status: 'not found' };
try {
  if (existsSync(envFile.path)) {
    const raw = readFileSync(envFile.path);
    // Notepad can save as UTF-16 ("Unicode"); otherwise UTF-8, with or without a byte-order mark
    const text = (raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8')).replace(/^﻿/, '');
    let n = 0;
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue; // blank lines and # comments
      const value = /^(["']).*\1$/.test(m[2]) ? m[2].slice(1, -1) : m[2];
      if (!process.env[m[1]]) { process.env[m[1]] = value; n++; }
    }
    envFile.status = `read (${n} values)`;
  } else if (existsSync(`${envFile.path}.txt`)) {
    envFile.status = 'not found, but .env.txt is there: rename it to .env (Windows hides the .txt ending)';
  }
} catch (e) {
  envFile.status = `could not be read: ${(e as Error).message}`;
  console.warn(`.env at ${envFile.path} ${envFile.status}`);
}
