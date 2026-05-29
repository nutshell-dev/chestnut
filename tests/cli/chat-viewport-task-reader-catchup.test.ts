import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// phase 1401 Bug A invariant: task stream reader 必从 0 catch-up，不从 EOF tail。
// 防 regression 误改回 `taskReader.start();`（默认 EOF）让 shadow 早期事件
// (task_attempt_start / turn_start / llm_start) 漏读，间接触发 stale-sweep 误杀。
describe('phase 1401: task stream reader catch-up from 0', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const FILE = `${ROOT}/src/cli/commands/chat-viewport-event-handler.ts`;

  it('taskReader.start(0) explicit — 不 fall back EOF tail', () => {
    const src = readFileSync(FILE, 'utf-8');
    expect(src).toMatch(/taskReader\.start\(0\)/);
    expect(src).not.toMatch(/taskReader\.start\(\s*\)\s*;/);
  });

  it('反向自检 — sample 含 start() 应被命中', () => {
    const badSample = 'taskReader.start();';
    expect(/taskReader\.start\(\s*\)\s*;/.test(badSample)).toBe(true);
    const goodSample = 'taskReader.start(0);';
    expect(/taskReader\.start\(\s*\)\s*;/.test(goodSample)).toBe(false);
    expect(/taskReader\.start\(0\)/.test(goodSample)).toBe(true);
  });
});
