#!/usr/bin/env node
/**
 * Phase 2133: inventory test files that replace process stdout/stderr.write.
 * Node built-ins only so the same scanner can run in architecture tests and CI.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ISOLATED_LIST_NAMES = [
  'VI_MOCK_FILES',
  'VI_DOMOCK_FILES',
  'VI_GLOBALS_FILES',
  'PROCESS_OUTPUT_FILES',
  'INTEGRATION_PROCESS_FILES',
  'INTEGRATION_IO_FILES',
  'INFRA_FILES',
  'ARCH_COMPILE_FILES',
];

function canStartRegex(output) {
  const prefix = output.trimEnd();
  if (!prefix) return true;
  const last = prefix[prefix.length - 1];
  return '=([{,:;!&|?+-*%^~<>'.includes(last)
    || /\b(?:return|case|throw|typeof|instanceof|in|of)$/.test(prefix);
}

/** Mask comments and literals while retaining the property key 'write'. */
export function maskCommentsAndLiterals(source) {
  let output = '';
  let index = 0;
  let quoteStart = -1;
  let quote = '';

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (!quote) {
      if (char === '/' && next === '/') {
        const end = source.indexOf('\n', index + 2);
        const stop = end === -1 ? source.length : end;
        output += ' '.repeat(stop - index);
        index = stop;
      } else if (char === '/' && next === '*') {
        const end = source.indexOf('*/', index + 2);
        const stop = end === -1 ? source.length : end + 2;
        output += source.slice(index, stop).replace(/[^\n]/g, ' ');
        index = stop;
      } else if (char === '/' && canStartRegex(output)) {
        let cursor = index + 1;
        let inCharacterClass = false;
        while (cursor < source.length) {
          if (source[cursor] === '\\') {
            cursor += 2;
            continue;
          }
          if (source[cursor] === '[') inCharacterClass = true;
          if (source[cursor] === ']') inCharacterClass = false;
          if (source[cursor] === '/' && !inCharacterClass) {
            cursor += 1;
            break;
          }
          cursor += 1;
        }
        output += source.slice(index, cursor).replace(/[^\n]/g, ' ');
        index = cursor;
      } else if (char === "'" || char === '"' || char === '`') {
        quote = char;
        quoteStart = index;
        output += char;
        index += 1;
      } else {
        output += char;
        index += 1;
      }
    } else if (char === '\\') {
      output += '  ';
      index += 2;
    } else if (char === quote) {
      const value = source.slice(quoteStart + 1, index);
      const literalLength = index - quoteStart - 1;
      if (quote !== '`' && value === 'write') {
        output = output.slice(0, -literalLength) + value;
      }
      output += char;
      quote = '';
      index += 1;
    } else {
      output += char === '\n' ? '\n' : ' ';
      index += 1;
    }
  }
  return output;
}

/** Return recognizable process-global output replacements with source lines. */
export function detectProcessOutputReplacements(source) {
  const clean = maskCommentsAndLiterals(source);
  const hits = [];
  const patterns = [
    ['spy', /\bvi\s*\.\s*spyOn\s*\(\s*process\s*\.\s*(?:stdout|stderr)\s*,\s*['"]write['"]\s*\)/g],
    ['spy', /\bvi\s*\.\s*spyOn\s*\(\s*process\s*\.\s*(?:stdout|stderr)\s*\[\s*['"]write['"]\s*\]\s*,/g],
    ['assignment', /\bprocess\s*\.\s*(?:stdout|stderr)\s*(?:\.\s*write|\[\s*['"]write['"]\s*\])\s*=(?!=)/g],
  ];

  for (const [kind, pattern] of patterns) {
    for (const match of clean.matchAll(pattern)) {
      hits.push({ kind, index: match.index });
    }
  }

  const aliases = new Set();
  const aliasPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\s*\.\s*(?:stdout|stderr)(?:\s+as\s+[^;=\n]+)?\s*(?:;|\n)/g;
  for (const match of clean.matchAll(aliasPattern)) aliases.add(match[1]);
  const destructuredAliasPattern = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\s*(?:;|\n)/g;
  for (const match of clean.matchAll(destructuredAliasPattern)) {
    for (const binding of match[1].split(',')) {
      const parsed = binding.match(/^\s*(stdout|stderr)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*$/);
      if (parsed) aliases.add(parsed[2] ?? parsed[1]);
    }
  }

  for (const alias of aliases) {
    const escaped = alias.replace(/[$]/g, '\\$');
    const aliasPatterns = [
      ['spy', new RegExp(`\\bvi\\s*\\.\\s*spyOn\\s*\\(\\s*${escaped}\\s*,\\s*['"]write['"]\\s*\\)`, 'g')],
      ['assignment', new RegExp(`\\b${escaped}\\s*(?:\\.\\s*write|\\[\\s*['"]write['"]\\s*\\])\\s*=(?!=)`, 'g')],
    ];
    for (const [kind, pattern] of aliasPatterns) {
      for (const match of clean.matchAll(pattern)) hits.push({ kind, index: match.index });
    }
  }

  return hits
    .filter((hit) => Number.isInteger(hit.index))
    .map((hit) => ({
      kind: hit.kind,
      line: clean.slice(0, hit.index).split('\n').length,
    }))
    .sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}

export function matchesTestPattern(file, pattern) {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '<<<DOUBLESTAR_SLASH>>>')
    .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<DOUBLESTAR_SLASH>>>/g, '(?:.*/)?')
    .replace(/<<<DOUBLESTAR>>>/g, '.*');
  return new RegExp(`^${expression}$`).test(file);
}

/** Scan test files recursively, excluding dependencies and build output. */
export async function scanProcessOutputGlobalState(repo) {
  const hits = [];

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        const source = await readFile(path, 'utf8');
        const replacements = detectProcessOutputReplacements(source);
        if (replacements.length > 0) {
          hits.push({ file: relative(repo, path), replacements });
        }
      }
    }
  }

  await walk(join(repo, 'tests'));
  hits.sort((a, b) => a.file.localeCompare(b.file));
  return { count: hits.length, hits };
}

/** Parse active entries from the flat file-list constants in vitest.config.ts. */
export function loadConfiguredIsolatedFiles(configSource) {
  const files = new Set();
  for (const name of ISOLATED_LIST_NAMES) {
    const startMarker = `const ${name} = [`;
    const start = configSource.indexOf(startMarker);
    if (start === -1) continue;
    const end = configSource.indexOf('];', start + startMarker.length);
    if (end === -1) throw new Error(`Could not find closing ]; for ${name}`);
    const block = configSource.slice(start + startMarker.length, end);
    for (const match of block.matchAll(/^\s*'(tests\/[^']+)'/gm)) files.add(match[1]);
  }
  return files;
}

export function classifyAuditHits(hits, isolatedFiles) {
  return hits.map((hit) => {
    const isolated = [...isolatedFiles].some((pattern) =>
      pattern === hit.file || (pattern.includes('*') && matchesTestPattern(hit.file, pattern)));
    return { ...hit, project: isolated ? 'isolated' : 'fast' };
  });
}

async function main() {
  const repo = resolve(process.argv[2] ?? new URL('..', import.meta.url).pathname);
  const [config, result] = await Promise.all([
    readFile(join(repo, '.config/vitest.config.ts'), 'utf8'),
    scanProcessOutputGlobalState(repo),
  ]);
  const isolated = loadConfiguredIsolatedFiles(config);
  const hits = classifyAuditHits(result.hits, isolated);
  const unregistered = hits.filter((hit) => hit.project !== 'isolated');
  console.log(JSON.stringify({
    count: hits.length,
    unregisteredCount: unregistered.length,
    hits,
  }, null, 2));
  if (unregistered.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
