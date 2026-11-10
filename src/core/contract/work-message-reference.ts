/**
 * @module L4.ContractSystem
 * Work message reference — owner 侧最小工作消息身份识别（phase 2094 Step B）
 *
 * 背景：Runtime 在 prepareInbox 领取消息后、格式化前需要判断「这条排队中的创建/
 * 续作指令是否仍属于一个未终结的契约」。身份（消息声称的 contract_id）与终态事实
 * 都归 ContractSystem；本模块只提供**纯函数**识别身份，不做查询、不读路径、不碰
 * 全局状态。
 *
 * 契约（plan phase2094 Step B）：
 * - 只认 `from === 'system'` 且 `type` 为 `contract_created` / `contract_resume`；
 * - 只认 `metadata.contract_id` 的**非空字符串**：不做 trim、不从 body 抽取、
 *   不回退到其他字段；
 * - 返回值只是「消息声称的契约 ID」，**不是**合法路径保证、也**不是**已证实
 *   active/terminal；路径安全与终态由 `readContractTerminalFact` 继续校验。
 *
 * 为什么放在这里：身份声明与终态查询同属 ContractSystem（M#1 单一可变方向），
 * Runtime 经 barrel 消费，避免在 Runtime 内复制一套消息类型表。
 */

/** 可信工作消息来源（system 生产者：CLI contract 创建 / start onboarding）。 */
const WORK_MESSAGE_SOURCE = 'system';

/** 可信工作消息类型：创建与续作两类「启动契约执行」的指令。 */
const WORK_MESSAGE_TYPES: readonly string[] = ['contract_created', 'contract_resume'];

/** 工作消息身份字段（Messaging 的通用 metadata 透传键，无需新格式版本）。 */
const WORK_MESSAGE_CONTRACT_ID_KEY = 'contract_id';

/**
 * 识别可信工作消息所声称的契约 ID。
 *
 * @param message 只取 `type` / `from` / `metadata` 三个字段；调用方可传完整消息
 *                （`InboxMessage` 结构兼容），函数不会读取 `content`（body）。
 * @returns 非空 `contract_id` 字符串；非可信来源、非工作类型、缺失/空/非字符串
 *          一律返回 `undefined`（调用方保持原有交付行为）。
 */
export function getContractWorkMessageId(message: {
  readonly type: string;
  readonly from: string;
  readonly metadata?: Readonly<Record<string, string>>;
}): string | undefined {
  if (message.from !== WORK_MESSAGE_SOURCE) return undefined;
  if (!WORK_MESSAGE_TYPES.includes(message.type)) return undefined;
  const contractId = message.metadata?.[WORK_MESSAGE_CONTRACT_ID_KEY];
  return typeof contractId === 'string' && contractId.length > 0 ? contractId : undefined;
}
