/** CLI custom-method numeric choices map directly to explicit wire protocols. */
export const FORMAT_MAP: Record<string, 'anthropic' | 'openai' | 'gemini'> = {
  '1': 'anthropic',
  '2': 'openai',
  '3': 'gemini',
};
