import { afterAll } from 'vitest';
import { getTrackedDirs } from '../tests/utils/temp.js';

afterAll(() => {
  const remaining = getTrackedDirs();
  if (remaining.size > 0) {
    const list = Array.from(remaining).join('\n  ');
    const msg = `[temp-leak] ${remaining.size} tracked temp dirs not cleaned up:\n  ${list}`;
    if (process.env.CHESTNUT_KEEP_TEST_TMP === '1') {
      console.warn(msg);
      console.warn('[temp-leak] CHESTNUT_KEEP_TEST_TMP=1, preserving dirs for inspection');
    } else {
      throw new Error(msg);
    }
  }
});
