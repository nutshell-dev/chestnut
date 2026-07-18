/**
 * Motion AGENTS.md crash self-heal guidance smoke test (phase 1207 gap C)
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_PATH = path.resolve(__dirname, '../../../src/templates/motion/AGENTS.md');

describe('motion AGENTS.md crash self-heal N≥3 bailout (phase 1207 gap C)', () => {
  const content = fs.readFileSync(AGENTS_PATH, 'utf-8');

  it('contains N<3 immediate restart guidance', () => {
    expect(content).toContain('同 source claw_crashed < 3 次');
    expect(content).toContain('立即重启');
  });

  it('contains N≥3 bailout with cancelContract option and no pauseContract', () => {
    expect(content).toContain('同 source claw_crashed ≥ 3 次');
    expect(content).toContain('cancelContract');
    expect(content).not.toContain('pauseContract');
  });

  it('references last_events forensic field for diagnosis', () => {
    expect(content).toContain('last_events');
  });
});
