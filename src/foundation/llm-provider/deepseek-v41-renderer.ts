/** @module L1.LLMProvider.DeepseekV41
 * Text subset of deepseek-recipe 0.2.0, commit 935817c (MIT; tokenizers/LICENSE.deepseek).
 * Keep plain text and explicit special tokens separate, including tool instructions.
 */
import instructions from './tokenizers/deepseek-tool-instructions.json' with { type: 'json' };

export type PromptSegment = { kind: 'plain' | 'special'; text: string };
type Obj = Record<string, unknown>;
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text: string;
  thinking?: string;
  calls?: { id: string; name: string; input: Obj }[];
  id?: string;
}
const TOK = {
  bos: '<｜begin▁of▁sentence｜>', eos: '<｜end▁of▁sentence｜>',
  system: '<｜System｜>', user: '<｜User｜>', assistant: '<｜Assistant｜>',
  think: '<think>', endThink: '</think>', dsml: '｜DSML｜',
};
const ASSISTANT_SPECIAL = /(<｜\/?(?:ref|box|point|polygon)｜>)/g;

function object(value: unknown): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
  return value as Obj;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('expected string');
  return value;
}
function blocks(value: unknown): Obj[] {
  if (!Array.isArray(value)) throw new Error('expected content blocks');
  return value.map(object);
}

/** serde_json preserve_order with Python-style spaced separators / small float exponents. */
export function stringifyDeepseek(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stringifyDeepseek).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${stringifyDeepseek(v)}`).join(', ')}}`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number');
    const text = value !== 0 && Math.abs(value) < 1e-4 ? value.toExponential() : JSON.stringify(value);
    return text.replace(/e-(\d)$/, 'e-0$1');
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('non-JSON input');
  return text;
}

function textContent(value: unknown, system = false): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return blocks(value).filter((b, i) => !(system && i === 0 && typeof b.text === 'string'
    && b.text.toLowerCase().startsWith('x-anthropic-billing-header'))).map(b => {
    if (b.type !== 'text') throw new Error(`unsupported content: ${String(b.type)}`);
    return string(b.text);
  }).join('\n\n');
}

function convertMessages(body: Obj): ChatMessage[] {
  const result: ChatMessage[] = [];
  const append = (message: ChatMessage) => {
    const previous = result.at(-1);
    if (message.role === 'user' && previous?.role === 'user') previous.text += '\n\n' + message.text;
    else result.push(message);
  };
  if (body.system !== undefined) append({ role: 'system', text: textContent(body.system, true) });
  const pending = new Map<string, number>();
  for (const message of blocks(body.messages)) {
    if (message.role !== 'user' && message.role !== 'assistant') throw new Error('unsupported message role');
    if (typeof message.content === 'string') {
      if (pending.size) throw new Error('unanswered tool call');
      append({ role: message.role, text: message.content });
      continue;
    }
    const content = blocks(message.content);
    if (content.length === 0) throw new Error('empty message content');
    if (message.role === 'assistant') {
      if (pending.size) throw new Error('unanswered tool call');
      const assistant: ChatMessage = { role: 'assistant', text: '', calls: [] };
      for (const block of content) {
        if (block.type === 'text') {
          if (assistant.calls!.length) throw new Error('text after tool use');
          assistant.text += (assistant.text ? '\n\n' : '') + string(block.text);
        } else if (block.type === 'thinking') {
          assistant.thinking = (assistant.thinking === undefined ? '' : assistant.thinking + '\n\n') + string(block.thinking);
        } else if (block.type === 'tool_use') {
          const id = string(block.id);
          if (pending.has(id)) throw new Error('duplicate tool use');
          pending.set(id, assistant.calls!.length);
          assistant.calls!.push({ id, name: string(block.name), input: object(block.input) });
        } else throw new Error(`unsupported assistant content: ${String(block.type)}`);
      }
      append(assistant);
    } else {
      const toolResults: { message: ChatMessage; order: number }[] = [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          const id = string(block.tool_use_id), order = pending.get(id);
          if (order === undefined) throw new Error('unmatched tool result');
          pending.delete(id);
          toolResults.push({ message: { role: 'tool', id, text: textContent(block.content) }, order });
        } else if (block.type === 'text') {
          if (pending.size) throw new Error('text before tool results');
          toolResults.sort((a, b) => a.order - b.order).forEach(r => append(r.message));
          toolResults.length = 0;
          append({ role: 'user', text: string(block.text) });
        } else throw new Error(`unsupported user content: ${String(block.type)}`);
      }
      if (pending.size) throw new Error('unanswered tool call');
      toolResults.sort((a, b) => a.order - b.order).forEach(r => append(r.message));
    }
  }
  if (pending.size) throw new Error('unanswered tool call');
  return result;
}

export function renderDeepseekV41(body: Obj): PromptSegment[] {
  const messages = convertMessages(body);
  const tools = body.tools === undefined ? [] : blocks(body.tools);
  const choice = body.tool_choice === undefined ? 'auto' : object(body.tool_choice).type;
  if (choice !== 'auto' && choice !== 'none') throw new Error('unsupported tool choice');
  for (const tool of tools) {
    if (tool.type !== undefined || tool.defer_loading === true) throw new Error('unsupported server/deferred tool');
    string(tool.name); object(tool.input_schema);
  }
  const withTools = tools.length > 0 && choice !== 'none';
  const thinkingType = body.thinking === undefined ? undefined : object(body.thinking).type;
  const effort = body.output_config === undefined ? undefined : object(body.output_config).effort;
  if (thinkingType !== undefined && !['enabled', 'adaptive', 'disabled'].includes(String(thinkingType))) throw new Error('unsupported thinking mode');
  const thinking = thinkingType === undefined ? effort !== undefined && effort !== 'none' : thinkingType !== 'disabled';
  const score = effort === 'low' || effort === 'minimal' ? '50' : effort === 'max' || effort === 'ultra' ? '100' : '75';
  if (body.output_config !== undefined && object(body.output_config).format !== undefined) throw new Error('unsupported output format');
  const result: PromptSegment[] = [];
  const plain = (text: string) => {
    if (!text) return;
    const previous = result.at(-1);
    if (previous?.kind === 'plain') previous.text += text;
    else result.push({ kind: 'plain', text });
  };
  const special = (text: string) => { result.push({ kind: 'special', text }); };
  const marked = (text: string, pattern: RegExp) => {
    for (const [index, piece] of text.split(pattern).entries()) {
      if (index % 2) special(piece); else plain(piece);
    }
  };
  if (withTools && messages[0]?.role !== 'system') messages.unshift({ role: 'system', text: '' });
  special(TOK.bos);
  for (const [index, m] of messages.entries()) {
    if (index === 0 && (thinking || m.role === 'system')) special(TOK.system);
    if (index === 0 && thinking) plain(`Reasoning Effort: ${score} (range 1-100, the higher the value, the more thorough the reasoning)\n\n`);
    if (m.role === 'system') {
      if (index > 0) special(TOK.system);
      plain(m.text);
      if (index === 0 && withTools) {
        plain('\n\n');
        marked(instructions, /(｜DSML｜|<think>|<\/think>)/g);
        plain(tools.map(t => stringifyDeepseek({ name: t.name, description: t.description ?? '', parameters: t.input_schema })).join('\n'));
        plain('\n\nYou MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.\n');
      }
    } else if (m.role === 'user' || m.role === 'tool') {
      if (['user', 'tool'].includes(messages[index - 1]?.role)) plain('\n\n'); else special(TOK.user);
      plain(m.role === 'tool' ? `<tool_result>${m.text}</tool_result>` : m.text);
    } else {
      special(TOK.assistant);
      if (thinking && index > 0 && withTools) {
        special(TOK.think); marked(m.thinking ?? '', ASSISTANT_SPECIAL); special(TOK.endThink);
      } else special(TOK.endThink);
      marked(m.text, ASSISTANT_SPECIAL);
      if (m.calls?.length) {
        plain('\n\n<'); special(TOK.dsml); plain(' calls>\n');
        m.calls.forEach((call, i) => {
          if (i > 0) plain('\n');
          plain('<'); special(TOK.dsml); plain(` invoke name="${call.name}">\n`);
          Object.entries(call.input).forEach(([key, value], j) => {
            if (j > 0) plain('\n');
            plain('<'); special(TOK.dsml);
            plain(` parameter name="${key}" string="${typeof value === 'string'}">${typeof value === 'string' ? value : stringifyDeepseek(value)}</`);
            special(TOK.dsml); plain(' parameter>');
          });
          plain('\n</'); special(TOK.dsml); plain(' invoke>');
        });
        plain('\n</'); special(TOK.dsml); plain(' calls>');
      }
      special(TOK.eos);
    }
  }
  special(TOK.assistant); special(thinking ? TOK.think : TOK.endThink);
  return result;
}
