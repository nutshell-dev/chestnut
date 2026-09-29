/**
 * @module L2a.Credentials
 *
 * 极简 `.env` 解析（Phase 1925 Step B）。
 *
 * 只支持凭据回退所需的子集：`KEY=VALUE`、忽略 `#` 注释与空行、
 * 支持单/双引号包裹值、忽略行首 `export ` 前缀。不支持多行值、
 * 转义序列与变量插值 —— 超出子集的行静默忽略（回退层 best-effort）。
 */

/** 解析 .env 文本为键值 Record（后写覆盖先写）。 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (key === '') continue;
    let value = withoutExport.slice(eq + 1).trim();
    // 单/双引号包裹值：剥壳、不处理内部转义（极简子集）
    if (value.length >= 2) {
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
        value = value.slice(1, -1);
      }
    }
    result[key] = value;
  }
  return result;
}
