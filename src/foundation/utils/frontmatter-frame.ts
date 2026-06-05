/**
 * Parse YAML frontmatter frame syntax (industry standard `---\n` delim + `:` split).
 *
 * Returns raw meta values (trimmed but NOT unquoted) + body. Callers apply own unquote variant
 * (per phase 461 ratify「各 caller 自治」+ phase 62 抽 frame syntax 共享、unquote 保独立).
 *
 * frame syntax 单源（ML#3 资源唯一归属）：
 * - `\r\n` → `\n` normalize
 * - `---\n` opener required (otherwise returns empty meta + body=raw)
 * - `\n---\n` closer (strict) / `\n---` EOF closer (opt-in via opts.eofTolerant)
 * - `:` first-occurrence split, key/value trim
 * - leading `:` lines skipped (`ci <= 0` continue)
 *
 * Sister design context (caller-specific unquote applied AFTER helper):
 * - `src/foundation/messaging/codec-inbox.ts` post-applies yamlUnquote (NUL placeholder + escape unescape)
 * - `src/foundation/skill-system/registry.ts` post-applies simple regex `/^["']|["']$/g`
 * - `src/core/memory/tools/memory_search.ts` post-applies simple regex
 *
 * @param raw input string
 * @param opts.eofTolerant accept `\n---` EOF without trailing newline as valid closer (phase 953 / r118 H fork)
 * @throws Error if frontmatter opener found but malformed (missing closing ---)
 */
export function parseFrontmatterFrame(
  raw: string,
  opts?: { eofTolerant?: boolean },
): { meta: Record<string, string>; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { meta: {}, body: raw };

  const afterOpen = normalized.slice(4);
  let closeIdx = afterOpen.indexOf('\n---\n');
  let bodySliceOffset = 5;
  let useEofClose = false;

  if (closeIdx < 0) {
    if (afterOpen.startsWith('---\n')) {
      // empty frontmatter: '---\n---\nbody' → afterOpen = '---\nbody'
      closeIdx = 0;
      bodySliceOffset = 4;
    } else if (opts?.eofTolerant && afterOpen.endsWith('\n---')) {
      closeIdx = afterOpen.length - 4;
      bodySliceOffset = 4;
      useEofClose = true;
    } else {
      throw new Error('Malformed frontmatter: missing closing ---');
    }
  }

  const meta: Record<string, string> = {};
  for (const line of afterOpen.slice(0, closeIdx).split('\n')) {
    const ci = line.indexOf(':');
    if (ci <= 0) continue;
    const key = line.slice(0, ci).trim();
    const value = line.slice(ci + 1).trim();
    meta[key] = value;
  }

  const body = useEofClose ? '' : afterOpen.slice(closeIdx + bodySliceOffset).trim();
  return { meta, body };
}
