/**
 * Gemini message formatter — pure function
 * 抽自 gemini.ts (phase 642 / mirror phase 630)
 */

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export function formatGeminiMessages(
  messages: Array<{ role: string; content: unknown }>,
): GeminiContent[] {
  // Build tool_use_id -> name mapping (Gemini functionResponse needs name, not id)
  const idToName = new Map<string, string>();
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (b.type === 'tool_use') {
          idToName.set(b.id as string, b.name as string);
        }
      }
    }
  }

  const result: GeminiContent[] = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];

    if (!Array.isArray(m.content)) {
      parts.push({ text: m.content as string });
    } else {
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (b.type === 'text') {
          parts.push({ text: b.text as string });
        } else if (b.type === 'tool_use') {
          parts.push({ functionCall: { name: b.name as string, args: (b.input ?? {}) as Record<string, unknown> } });
        } else if (b.type === 'tool_result') {
          const name = idToName.get(b.tool_use_id as string) ?? (b.tool_use_id as string);
          const response: Record<string, unknown> = typeof b.content === 'string'
            ? { output: b.content }
            : (b.content as Record<string, unknown>) ?? {};
          parts.push({ functionResponse: { name, response } });
        }
      }
    }

    if (parts.length > 0) {
      result.push({ role, parts });
    }
  }
  return result;
}
