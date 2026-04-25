/**
 * Deep Dream Prompt Builder
 *
 * Two LLM calls per session file:
 *   Call 1: dream generation  (DEEP_DREAM_SYSTEM_PROMPT + buildDreamInput)
 *   Call 2: compression       (same messages + COMPRESSION_PROMPT)
 */

export const DEEP_DREAM_SYSTEM_PROMPT = `\
你是帮助 AI claw 从自身工作经验中提炼洞见的梦境引擎。
你将收到一个 claw 的对话历史（可能含前序会话的压缩摘要）。

请围绕以下四个问题提炼洞见：

1. **决策质量**：这个会话里，claw 做了哪些关键决策？
   哪些决策是正确的、值得保留的模式？
   哪些决策导致了返工、绕路，或事后发现是错误的？

2. **反复出现的模式**：对比前序会话摘要（如有），有没有同样的错误犯了两次？
   或者某种方法在这类任务里一直奏效？
   如果这是第一个会话，只分析当前会话内的重复模式。

3. **新知识**：claw 在这个会话里学到了什么？
   哪些领域规律、工具用法、判断依据是值得长期记住的？

4. **如何做得更好**：如果重新做这个任务，哪一步应该不同？
   有没有可以提前做的事，能省掉后面的麻烦？

**输出要求**：
- 只写对 claw 未来工作有实际帮助的内容
- 每个洞见单独一条，直接说结论
- 不重复前序摘要已经提炼过的经验
- 如果这段会话平淡无奇、没有值得提炼的内容，输出"此会话无有价值洞见"`.trim();

/**
 * 构造 Call 1 的用户消息
 * @param compressions 前序会话的压缩摘要列表（可为空）
 * @param sessionText  当前会话的序列化文本
 */
export function buildDreamInput(
  compressions: string[],
  sessionText: string,
): string {
  const parts: string[] = [];
  if (compressions.length > 0) {
    parts.push(`## 前序会话压缩摘要\n\n${compressions.join('\n---\n')}`);
  }
  parts.push(`## 当前会话全文\n\n${sessionText}`);
  return parts.join('\n\n');
}

/** Call 2：请求压缩当前会话，供下一文件的 buildDreamInput 使用 */
export const COMPRESSION_PROMPT = `\
请将上面"当前会话全文"压缩为简洁摘要，供后续会话的梦境处理使用。

保留：任务背景、关键决策节点、工具调用结果摘要、最终结果
省略：冗余对话、重复步骤、格式化输出内容
长度：500 字以内`.trim();

/**
 * 元压缩：当 compressions 累积过长时，将多段合并再压一次
 * 用于压缩滑动窗口（deep-dream.ts 中调用）
 */
export const META_COMPRESSION_PROMPT = `\
以下是多段会话的压缩摘要，请进一步合并压缩为一段，保留最核心的上下文信息。
长度：800 字以内`.trim();
