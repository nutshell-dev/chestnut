/**
 * @module L2c.CommandTool.Env
 *
 * phase 1986 Step G：调用者 agent 身份 env 常量（零依赖，供 CLI 入口消费而不
 * 引入 CommandTool 全量模块）。
 */

/** 调用者 agent 身份 env（主代理=claw id，子代理=task id）；CommandTool 只注入、不解读。 */
export const CALLER_AGENT_ID_ENV = 'CHESTNUT_CALLER_AGENT_ID';
