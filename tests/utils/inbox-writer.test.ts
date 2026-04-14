/**
 * inbox-writer.ts tests
 *
 * Covers yamlQuote() edge cases (via writeInboxMessage extraFields)
 * and the atomic write pattern.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { writeInboxMessage } from '../../src/utils/inbox-writer.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `inbox-writer-test-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readWrittenFile(): string {
  const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.md'));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8');
}

// ─── yamlQuote: numeric passthrough ──────────────────────────────────────────

describe('yamlQuote — numeric extraFields', () => {
  it('integer values are written unquoted', () => {
    writeInboxMessage({
      inboxDir: tmpDir,
      type: 'test',
      source: 'test',
      priority: 'normal',
      body: 'body',
      extraFields: { count: '42', offset: '-3' },
    });
    const content = readWrittenFile();
    expect(content).toContain('\ncount: 42\n');
    expect(content).toContain('\noffset: -3\n');
  });

  it('float values are written unquoted', () => {
    writeInboxMessage({
      inboxDir: tmpDir,
      type: 'test',
      source: 'test',
      priority: 'normal',
      body: 'body',
      extraFields: { ratio: '1.5', zero: '0.0' },
    });
    const content = readWrittenFile();
    expect(content).toContain('\nratio: 1.5\n');
    expect(content).toContain('\nzero: 0.0\n');
  });
});

// ─── yamlQuote: boolean passthrough ──────────────────────────────────────────

describe('yamlQuote — boolean extraFields', () => {
  it('true/false are written unquoted', () => {
    writeInboxMessage({
      inboxDir: tmpDir,
      type: 'test',
      source: 'test',
      priority: 'normal',
      body: 'body',
      extraFields: { active: 'true', disabled: 'false' },
    });
    const content = readWrittenFile();
    expect(content).toContain('\nactive: true\n');
    expect(content).toContain('\ndisabled: false\n');
  });
});

// ─── yamlQuote: special character escaping ───────────────────────────────────

describe('yamlQuote — string escaping', () => {
  it('backslash is escaped to \\\\', () => {
    writeInboxMessage({
      inboxDir: tmpDir,
      type: 'test',
      source: 'test',
      priority: 'normal',
      body: 'body',
      extraFields: { path: 'C:\\Users\\foo' },
    });
    const content = readWrittenFile();
    // YAML line should be: path: "C:\\Users\\foo"
    expect(content).toContain('path: "C:\\\\Users\\\\foo"');
  });

  it('double-quote is escaped to \\"', () => {
    writeInboxMessage({
      inboxDir: tmpDir,
      type: 'test',
      source: 'test',
      priority: 'normal',
      body: 'body',
      extraFields: { msg: 'say "hello"' },
    });
    const content = readWrittenFile();
    expect(content).toContain('msg: "say \\"hello\\""');
  });

  it('newline in value is escaped to \\n', () => {
    writeInboxMessage({
      inboxDir: tmpDir,
      type: 'test',
      source: 'test',
      priority: 'normal',
      body: 'body',
      extraFields: { desc: 'line1\nline2' },
    });
    const content = readWrittenFile();
    expect(content).toContain('desc: "line1\\nline2"');
  });

  it('carriage return in value is escaped to \\r', () => {
    writeInboxMessage({
      inboxDir: tmpDir,
      type: 'test',
      source: 'test',
      priority: 'normal',
      body: 'body',
      extraFields: { val: 'a\rb' },
    });
    const content = readWrittenFile();
    expect(content).toContain('val: "a\\rb"');
  });
});

// ─── atomic write ─────────────────────────────────────────────────────────────

describe('writeInboxMessage atomic write', () => {
  it('leaves no .tmp file after write', () => {
    writeInboxMessage({
      inboxDir: tmpDir,
      type: 'test',
      source: 'test',
      priority: 'normal',
      body: 'hello',
    });
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('final file has complete YAML frontmatter and body', () => {
    writeInboxMessage({
      inboxDir: tmpDir,
      type: 'ping',
      source: 'motion',
      priority: 'high',
      body: 'test body content',
    });
    const content = readWrittenFile();
    expect(content).toContain('type: ping');
    expect(content).toContain('from: "motion"');
    expect(content).toContain('priority: high');
    expect(content).toContain('test body content');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('\n---\n');
  });
});
