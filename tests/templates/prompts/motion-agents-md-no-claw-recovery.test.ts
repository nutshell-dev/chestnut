/**
 * Phase 1396 Step H: Motion AGENTS.md must not prescribe claw crash/inactivity
 * recovery actions. Watchdog owns daemon availability; Motion does not receive
 * claw_crashed / claw_inactivity notifications and must not be taught to
 * restart claws or wait for user instruction on technical daemon failures.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_PATH = path.resolve(__dirname, '../../../src/templates/motion/AGENTS.md');

describe('motion AGENTS.md no claw failure recovery prescription (phase 1396 Step H)', () => {
  const content = fs.readFileSync(AGENTS_PATH, 'utf-8');

  it('does not mention retired inbox types', () => {
    expect(content).not.toMatch(/claw_crashed|claw_inactivity/);
  });

  it('does not instruct Motion to restart a claw daemon', () => {
    expect(content).not.toMatch(/chestnut claw <claw-id> daemon/);
    expect(content).not.toMatch(/立即重启/);
  });

  it('does not ask the user for permission or wait for instruction on technical daemon failures', () => {
    expect(content).not.toMatch(/等待指示/);
    expect(content).not.toMatch(/等待用户/);
    expect(content).not.toMatch(/请用户 ratify/);
  });

  it('does not reference retired failure/crash classification fields', () => {
    expect(content).not.toMatch(/crash_class|failure_class|inactive_ms|last_error/);
  });
});
