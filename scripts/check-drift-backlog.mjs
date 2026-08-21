#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUBSECTION_DESIGNS = new Set(['l6_assembly_composer_framework.md']);
// phase 799 Runtime 已从 L5 迁 L4（modules/l4_runtime.md、backlog 文件同名）——旧映射 l4→l5 已 stale、删除（checker 默认 fileName→fileName）
const LEGACY_BACKLOG_NAMES = new Map();
// l5_runtime.md 是 phase 799 前 legacy 名占位（drift-backlog/README.md §legacy filename 映射）、兼容既有引用保留、豁免 orphan 检查
const LEGACY_BACKLOG_FILES = new Set(['l5_runtime.md']);

function unescapedPipeCount(line) {
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '|') continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) count += 1;
  }
  return count;
}

function tableColumnCount(line) {
  return unescapedPipeCount(line) - 1;
}

function isSeparatorRow(line) {
  return /^\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line);
}

function localMarkdownTargets(line) {
  const targets = [];
  for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('#')) {
      continue;
    }
    targets.push(target.replace(/#.*/, ''));
  }
  return targets;
}

function firstCell(line) {
  const cells = line.split(/(?<!\\)\|/);
  return cells.length >= 3 ? cells[1].trim() : '';
}

export function checkDriftBacklog(designRoot) {
  const violations = [];
  const modulesDir = path.join(designRoot, 'modules');
  const backlogDir = path.join(modulesDir, 'drift-backlog');

  if (!fs.existsSync(modulesDir) || !fs.existsSync(backlogDir)) {
    return [`${designRoot}: expected modules/ and modules/drift-backlog/`];
  }

  const moduleFiles = fs.readdirSync(modulesDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^l.*\.md$/.test(entry.name))
    .map(entry => entry.name);
  const backlogEntries = fs.readdirSync(backlogDir, { withFileTypes: true });
  const backlogFiles = backlogEntries
    .filter(entry => entry.isFile() && /^l.*\.md$/.test(entry.name))
    .map(entry => entry.name);

  for (const entry of backlogEntries) {
    if (entry.isFile() && entry.name !== 'README.md' && !/^l.*\.md$/.test(entry.name)) {
      violations.push(`${path.join(backlogDir, entry.name)}: non-module file in drift-backlog root`);
    }
  }

  const expectedBacklogs = new Set();
  for (const moduleFile of moduleFiles) {
    if (SUBSECTION_DESIGNS.has(moduleFile)) continue;
    expectedBacklogs.add(LEGACY_BACKLOG_NAMES.get(moduleFile) ?? moduleFile);
  }
  const actualBacklogs = new Set(backlogFiles);
  for (const expected of expectedBacklogs) {
    if (!actualBacklogs.has(expected)) {
      violations.push(`${path.join(backlogDir, expected)}: missing module backlog`);
    }
  }
  for (const actual of actualBacklogs) {
    if (!expectedBacklogs.has(actual) && !LEGACY_BACKLOG_FILES.has(actual)) {
      violations.push(`${path.join(backlogDir, actual)}: orphan module backlog`);
    }
  }

  for (const fileName of ['README.md', ...backlogFiles].filter(name => fs.existsSync(path.join(backlogDir, name)))) {
    const filePath = path.join(backlogDir, fileName);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    let expectedColumns;
    let tableHeader;
    let section;
    const ids = new Map();

    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      if (line.startsWith('#') && line.includes('7.A')) section = 'A';
      if (line.startsWith('#') && line.includes('7.B')) section = 'B';

      for (const target of localMarkdownTargets(line)) {
        const resolved = path.resolve(path.dirname(filePath), target);
        if (!fs.existsSync(resolved)) {
          violations.push(`${filePath}:${lineNumber}: broken local link ${target}`);
        }
      }

      if (/^（.*(?:0 open|0 ⚓|当前 0 drift)/.test(line)) {
        violations.push(`${filePath}:${lineNumber}: hand-written zero-state summary is not derived from live rows`);
      }

      if (!line.startsWith('|')) {
        expectedColumns = undefined;
        tableHeader = undefined;
        return;
      }

      const columns = tableColumnCount(line);
      if (isSeparatorRow(line)) {
        expectedColumns = columns;
        return;
      }
      if (expectedColumns !== undefined && columns !== expectedColumns) {
        violations.push(`${filePath}:${lineNumber}: table has ${columns} columns; expected ${expectedColumns}`);
      }

      if (expectedColumns === undefined) {
        tableHeader = line;
      } else if (tableHeader === line) {
        violations.push(`${filePath}:${lineNumber}: duplicate table header`);
      }

      const cell = firstCell(line);
      if (/~~/.test(cell)) {
        violations.push(`${filePath}:${lineNumber}: closed/struck row remains in live backlog`);
      }
      if (section === 'A' && /(?:\*\*|`)A[.\-]/.test(cell) && /(?:closed by|\bclose(?:d)?\b|已关闭)/i.test(line) && !/\|\s*open\s*\|?\s*$/.test(line)) {
        violations.push(`${filePath}:${lineNumber}: closed A row remains in live backlog`);
      }
      const idMatch = cell.match(/\*\*([^*]+)\*\*/);
      if (!idMatch) return;
      const id = idMatch[1].trim();
      if (!/^(?:A|B|L\d)/.test(id)) return;
      if (ids.has(id)) {
        violations.push(`${filePath}:${lineNumber}: duplicate live row ID ${id} (first at line ${ids.get(id)})`);
      } else {
        ids.set(id, lineNumber);
      }
    });
  }

  return violations;
}

function parseDesignRoot(argv) {
  const index = argv.indexOf('--design-root');
  if (index === -1 || !argv[index + 1]) return undefined;
  return path.resolve(argv[index + 1]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const designRoot = parseDesignRoot(process.argv.slice(2));
  if (!designRoot) {
    console.error('Usage: node scripts/check-drift-backlog.mjs --design-root <design-directory>');
    process.exitCode = 2;
  } else {
    const violations = checkDriftBacklog(designRoot);
    if (violations.length > 0) {
      console.error(`drift-backlog check failed (${violations.length}):\n${violations.map(item => `- ${item}`).join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log(`drift-backlog check passed: ${designRoot}`);
    }
  }
}
