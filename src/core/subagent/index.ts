/**
 * SubAgent exports
 */

export { SubAgent, type SubAgentOptions } from './agent.js';

import { SubAgent } from './agent.js';
import type { SubAgentOptions } from './agent.js';

/**
 * 装配工厂（phase229 新增）：构造 SubAgent 代理。
 * 与 `new SubAgent(opts)` 完全等价（thin proxy）；
 * 装配方改调工厂以便未来依赖组合扩展时单点修改。
 */
export function createSubAgent(opts: SubAgentOptions): SubAgent {
  return new SubAgent(opts);
}
