/** Single owner for the prebuilt tool-input parse-error wire text. */
const TOOL_INPUT_PARSE_ERROR_PREFIX = 'Tool input JSON parse failed for' as const;

export function formatToolInputParseError(toolName: string, raw: string): string {
  return `${TOOL_INPUT_PARSE_ERROR_PREFIX} "${toolName}". Raw: ${raw}`;
}

export function isToolInputParseError(content: string): boolean {
  return content.startsWith(TOOL_INPUT_PARSE_ERROR_PREFIX);
}

export function parseToolInputErrorName(content: string): string | undefined {
  if (!isToolInputParseError(content)) return undefined;
  const quotedStart = TOOL_INPUT_PARSE_ERROR_PREFIX.length + 1;
  if (content[quotedStart] !== '"') return undefined;
  const quotedEnd = content.indexOf('"', quotedStart + 1);
  return quotedEnd < 0 ? undefined : content.slice(quotedStart + 1, quotedEnd);
}
