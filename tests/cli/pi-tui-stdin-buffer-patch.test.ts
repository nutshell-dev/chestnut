import { afterEach, describe, expect, it, vi } from 'vitest';
import { StdinBuffer } from '@mariozechner/pi-tui';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

describe('patched pi-tui bracketed paste buffering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('searches only new chunk data plus delimiter overlap and preserves split delimiters', () => {
    const originalIndexOf = String.prototype.indexOf;
    let searchedChars = 0;
    vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
      searchString: string,
      position?: number,
    ): number {
      const value = String(this);
      if (searchString === PASTE_END) {
        searchedChars += Math.max(0, value.length - (position ?? 0));
      }
      return originalIndexOf.call(value, searchString, position);
    });

    const stdin = new StdinBuffer();
    const emitted: string[] = [];
    stdin.on('paste', text => emitted.push(text));
    const content = Array.from({ length: 3_000 }, (_, i) => `line-${i}\n`).join('');

    stdin.process(PASTE_START);
    for (let offset = 0; offset < content.length; offset += 31) {
      stdin.process(content.slice(offset, offset + 31));
    }
    stdin.process(PASTE_END.slice(0, 3));
    stdin.process(PASTE_END.slice(3));

    expect(emitted).toEqual([content]);
    // Linear upper bound: all content once plus a small delimiter overlap per chunk.
    expect(searchedChars).toBeLessThan(content.length * 2);
  });
});
