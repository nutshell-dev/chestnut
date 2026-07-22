/**
 * UTF-8 安全字符串原语。
 *
 * Node.js 内置 API 中性封装：提供验证 Unicode well-formed 与按 UTF-8 byte budget
 * 截取最长完整 code point prefix 的能力。不静默替换坏数据，不处理 grapheme cluster。
 */

export class InvalidUnicodeStringError extends Error {
  readonly code = 'INVALID_UNICODE_STRING' as const;
  constructor(
    readonly codeUnitIndex: number,
    readonly codeUnit: number,
  ) {
    super(`Unpaired UTF-16 surrogate at code unit ${codeUnitIndex}`);
    this.name = 'InvalidUnicodeStringError';
  }
}

/**
 * 验证字符串是否由完整 Unicode scalar value 组成（无孤立 surrogate）。
 *
 * Node 18 不依赖 String.prototype.isWellFormed/toWellFormed；手工扫描 UTF-16 code units。
 *
 * @throws InvalidUnicodeStringError 发现孤立 high/low surrogate 时抛出。
 */
export function assertWellFormedUnicode(input: string): void {
  for (let i = 0; i < input.length; i++) {
    const unit = input.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new InvalidUnicodeStringError(i, unit);
      }
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new InvalidUnicodeStringError(i, unit);
    }
  }
}

/**
 * 在 UTF-8 byte budget 内取最长完整 code point prefix。
 *
 * - 输入必须是 well-formed Unicode，否则显式抛错（不静默修复）。
 * - 返回必是原字符串 prefix，且 `Buffer.byteLength(result, 'utf8') <= maxBytes`。
 * - 若某个 code point 会跨 budget，则整个 code point 不保留（不切 surrogate pair）。
 *
 * @throws RangeError maxBytes 不是非负 safe integer 时抛出。
 * @throws InvalidUnicodeStringError 输入含孤立 surrogate 时抛出。
 */
export function truncateUtf8Prefix(input: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  assertWellFormedUnicode(input);
  let usedBytes = 0;
  let endCodeUnit = 0;
  for (const codePoint of input) {
    const bytes = Buffer.byteLength(codePoint, 'utf8');
    if (usedBytes + bytes > maxBytes) break;
    usedBytes += bytes;
    endCodeUnit += codePoint.length;
  }
  return input.slice(0, endCodeUnit);
}
