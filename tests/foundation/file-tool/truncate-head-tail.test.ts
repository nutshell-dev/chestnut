import { describe, expect, it } from 'vitest';
import { truncateHeadTail } from '../../../src/foundation/file-tool/truncate-head-tail.js';
import {
  assertWellFormedUnicode,
  InvalidUnicodeStringError,
} from '../../../src/foundation/node-utils/utf8.js';

const TRUNCATION_MARKER = /\n\[\.\.\.truncated (\d+) bytes\.\.\.\]\n/;

function parsePreview(preview: string) {
  const marker = TRUNCATION_MARKER.exec(preview);
  if (!marker) throw new Error('Expected a truncation marker in preview');
  expect(marker.index).toBeGreaterThanOrEqual(0);
  const head = preview.slice(0, marker.index);
  const remainder = preview.slice(marker.index + marker[0].length);
  const hintIndex = remainder.lastIndexOf('\nFull output (');
  const tail = hintIndex >= 0 ? remainder.slice(0, hintIndex) : remainder;
  const hint = hintIndex >= 0 ? remainder.slice(hintIndex) : '';
  return { head, tail, hint, omitted: Number(marker![1]) };
}

function parseReadHint(hint: string): string {
  const json = /read: (\{.*\})/.exec(hint)?.[1];
  expect(json).toBeDefined();
  return (JSON.parse(json!) as { path: string }).path;
}

function expectByteConservation(input: string, preview: string) {
  const parsed = parsePreview(preview);
  expect(Buffer.byteLength(parsed.head, 'utf8')).toBeLessThanOrEqual(600);
  expect(Buffer.byteLength(parsed.tail, 'utf8')).toBeLessThanOrEqual(1400);
  expect(parsed.omitted).toBeGreaterThanOrEqual(0);
  expect(
    parsed.omitted
      + Buffer.byteLength(parsed.head, 'utf8')
      + Buffer.byteLength(parsed.tail, 'utf8'),
  ).toBe(Buffer.byteLength(input, 'utf8'));
  expect(() => assertWellFormedUnicode(preview)).not.toThrow();
  expect(preview).not.toContain('\uFFFD');
  return parsed;
}

describe('truncateHeadTail UTF-8 preview', () => {
  it.each([
    ['empty', ''],
    ['short ASCII', 'short output'],
    ['short Unicode', '前缀😀后缀'],
    ['exactly 2000 bytes', 'x'.repeat(2000)],
  ])('%s：未省略正文时不生成虚假标记', (_name, input) => {
    expect(truncateHeadTail(input)).toBe(input);
    expect(truncateHeadTail(input, '../tasks/sync/read/full.md')).toBe(
      `${input}\nFull output (${Buffer.byteLength(input, 'utf8')} bytes) saved. Use \`read\` with offset/limit to view ranges (read is capped per call, paginate by offset):\n  read: { "path": "../tasks/sync/read/full.md", "offset": 1, "limit": 200 }`,
    );
  });

  it('ASCII：按实际头尾字节计算省略量，无路径时不附加 read 提示', () => {
    const input = 'a'.repeat(2001);
    const parsed = expectByteConservation(input, truncateHeadTail(input));

    expect(parsed.head).toBe('a'.repeat(600));
    expect(parsed.tail).toBe('a'.repeat(1400));
    expect(parsed.omitted).toBe(1);
    expect(parsed.hint).toBe('');
  });

  it('多字节：两侧 emoji 跨预算时保留完整码点并按实际量守恒', () => {
    const input = `${'a'.repeat(599)}😀${'中'.repeat(1000)}😀${'z'.repeat(1399)}`;
    const parsed = expectByteConservation(input, truncateHeadTail(input));

    expect(parsed.head).toBe('a'.repeat(599));
    expect(parsed.tail).toBe('z'.repeat(1399));
    expect(parsed.omitted).toBe(3008);
  });

  it('恰 2000 字节但码点跨独立头尾预算时只报告真实未拼接部分', () => {
    const input = `${'a'.repeat(599)}😀${'z'.repeat(1397)}`;
    expect(Buffer.byteLength(input, 'utf8')).toBe(2000);
    const parsed = expectByteConservation(input, truncateHeadTail(input));

    expect(parsed.head).toBe('a'.repeat(599));
    expect(parsed.tail).toBe('z'.repeat(1397));
    expect(parsed.omitted).toBe(4);
  });

  it('带路径：Full output 使用原输入 UTF-8 总字节且保留既有路径格式', () => {
    const input = `${'a'.repeat(599)}😀${'中'.repeat(1000)}😀${'z'.repeat(1399)}`;
    const parsed = expectByteConservation(
      input,
      truncateHeadTail(input, '../tasks/sync/exec/full.md'),
    );

    expect(parsed.hint).toBe(
      `\nFull output (${Buffer.byteLength(input, 'utf8')} bytes) saved. Use \`read\` with offset/limit to view ranges (read is capped per call, paginate by offset):\n  read: { "path": "../tasks/sync/exec/full.md", "offset": 1, "limit": 200 }`,
    );
  });

  it.each([
    ['双引号', '../tasks/sync/read/"full".md'],
    ['反斜杠', '..\\tasks\\sync\\read\\full.md'],
    ['换行', '../tasks/sync/read/full\nname.md'],
    ['长路径', `../tasks/sync/read/${'nested/'.repeat(100)}full.md`],
  ])('路径提示序列化：%s解析后保持原路径', (_name, relPath) => {
    const input = 'x'.repeat(2001);
    const parsed = expectByteConservation(input, truncateHeadTail(input, relPath));

    expect(parseReadHint(parsed.hint)).toBe(relPath);
  });

  it.each(['x\uD800', 'x\uDC00'])('非法 Unicode 显式抛错：%j', (input) => {
    expect(() => truncateHeadTail(input)).toThrow(InvalidUnicodeStringError);
  });
});
