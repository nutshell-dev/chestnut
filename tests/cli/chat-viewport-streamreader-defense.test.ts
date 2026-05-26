/**
 * Phase 1325 — chat-viewport streamReader.start defense
 *
 * 反向 3 项:
 * 1. streamReader.start() wrapped in try-catch (static source verification)
 * 2. catch block emits STREAM_READER_START_FAILED audit (static)
 * 3. catch block triggers fallback render via mainUI.withScope + handleEvent (static)
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { VIEWPORT_AUDIT_EVENTS } from '../../src/cli/commands/viewport-audit-events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewportPath = path.join(__dirname, '../../src/cli/commands/chat-viewport.ts');
const viewportSource = fs.readFileSync(viewportPath, 'utf-8');

describe('phase 1325 chat-viewport streamReader.start defense', () => {
  it('streamReader.start(recentTurnOffset) is wrapped in try-catch', () => {
    // Locate the streamReader.start call block
    const idx = viewportSource.indexOf('streamReader.start(recentTurnOffset)');
    expect(idx).toBeGreaterThan(-1);

    // Verify it sits inside a try block
    const preceding = viewportSource.slice(0, idx);
    const lastTry = preceding.lastIndexOf('try {');
    expect(lastTry).toBeGreaterThan(-1);

    // Verify there is a matching catch after it
    const following = viewportSource.slice(idx);
    expect(following).toMatch(/catch\s*\(\s*err\s*\)\s*\{/);
  });

  it('catch block emits STREAM_READER_START_FAILED via options.audit.write', () => {
    const idx = viewportSource.indexOf('streamReader.start(recentTurnOffset)');
    expect(idx).toBeGreaterThan(-1);

    // Extract catch block (approx 800 chars should cover it)
    const catchStart = viewportSource.indexOf('catch', idx);
    expect(catchStart).toBeGreaterThan(-1);
    const block = viewportSource.slice(catchStart, catchStart + 800);

    expect(block).toContain('VIEWPORT_AUDIT_EVENTS.STREAM_READER_START_FAILED');
    expect(block).toContain('options.audit.write(');
    expect(block).toContain('reason=');
    expect(block).toContain('offset=');
  });

  it('catch block triggers fallback render via mainUI.withScope + handleEvent', () => {
    const idx = viewportSource.indexOf('streamReader.start(recentTurnOffset)');
    expect(idx).toBeGreaterThan(-1);

    const catchStart = viewportSource.indexOf('catch', idx);
    expect(catchStart).toBeGreaterThan(-1);
    const block = viewportSource.slice(catchStart, catchStart + 800);

    expect(block).toContain('mainUI.withScope(');
    expect(block).toContain("'main'");
    expect(block).toContain('handleEvent(');
    expect(block).toContain('system_message');
  });

  it('STREAM_READER_START_FAILED const is declared in viewport-audit-events.ts', () => {
    expect(VIEWPORT_AUDIT_EVENTS.STREAM_READER_START_FAILED).toBe('chat_viewport_stream_reader_start_failed');
  });
});
