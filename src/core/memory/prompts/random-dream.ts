/**
 * Random Dream Prompt Builder
 *
 * 随机梦境子代理使用 `dream` tool profile（已在 `src/core/tools/profiles.ts` 定义）：
 * `['read', 'search', 'ls', 'memory_search']`，只读探索，无写权限。
 *
 * ### 契约权重说明
 *
 * 权重由 `random-dream.ts`（Step 3）计算后注入 prompt，高权重排在前面。
 *
 * | 因素 | 权重方向 | 依据字段 |
 * |------|----------|---------|
 * | 近期完成 | 高 | `progress.json` subtask 的 `completed_at` |
 * | 失败/困难 | 高 | `failed` subtask 或 `retry_count >= 2` |
 * | 不同 claw | 高 | 本次尚未出现过的 clawId 优先 |
 * | 已被处理 | 低 | `.random-dream-state.json` 中的 `processedContractIds` |
 *
 * ### [DREAM_OUTPUT] 格式
 *
 * 带 `contract_id` 属性，供 handler 解析并更新 state：
 * ```
 * [DREAM_OUTPUT contract_id="xyz-123"]
 * ...梦境洞见...
 * [/DREAM_OUTPUT]
 * ```
 */

export const RANDOM_DREAM_SYSTEM_PROMPT = `\
你是跨 claw 梦境引擎，运行在 motion 进程中。
你的任务是从多个 claw 的已归档契约中随机探索，提炼跨 claw 的共性经验和洞见。

## 工作流程（每轮循环）

1. 从列表中选一个契约（高权重的排在前面，优先选择权重高的）
2. 读取该目录下的 contract.yaml 和 progress.json，了解任务概况
3. **自由探索**：随意读取相关文件——任务日志、对话历史，甚至看起来无关的文件
   可以用 search 搜索关键词，用 ls 浏览目录
4. 输出梦境洞见（格式见下）
5. 立刻开始下一轮（不等待指令）

## 输出格式

每轮探索后必须输出：

[DREAM_OUTPUT contract_id="<契约ID>"]
（跨 claw 共性经验、模式、值得所有 claw 知道的洞见——不是对单个契约的简单总结）
[/DREAM_OUTPUT]

当感到上下文已经很长、难以继续时，输出：

[DREAM_COMPLETE]

然后停止。

## 约束

- 只使用 read、search、ls、memory_search 工具，不写文件
- [DREAM_OUTPUT] 必须有跨 claw 视角
- 契约 ID 从 contract.yaml 的 id 字段读取`.trim();

/**
 * 构造随机梦境子代理的初始 prompt
 * @param weightedContracts 按权重排序的契约信息（高权重在前）
 */
export function buildRandomDreamPrompt(
  weightedContracts: Array<{
    clawId: string;
    contractId: string;
    contractDir: string;   // 绝对路径
    weight: number;
    hint: string;          // 权重原因，如 "近期完成" "执行困难" "尚未被梦境处理"
  }>
): string {
  const listLines = weightedContracts.map((c, i) =>
    `${i + 1}. [权重 ${c.weight}] claw: ${c.clawId} | ${c.contractDir}（${c.hint}）`
  );

  return `\
以下是所有已归档契约，按优先级排序（权重高的优先处理）：

${listLines.join('\n')}

请从第 1 条开始探索，完成后继续第 2 条，以此类推，直到上下文耗尽。`.trim();
}
