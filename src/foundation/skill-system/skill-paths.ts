/**
 * SkillSystem 路径常量集中定义
 * 
 * 集中 'skills' / 'clawspace/dispatch-skills' 字面量 / caller 风格统一并轨第 5 次复用模板
 * 同 phase345 audit event / phase347 tool name / phase349 watchdog audit / phase355 audit factory + skill events
 * 
 * phase370 已立 + phase399 补 SUBDIR 派生 / B.p169-2 完整闭环
 * 
 * 应然（design/modules/l2_skill_system.md）：
 * - skillsDir 必填 / 不预设默认值（B.p169-3 闭环）
 * - 字符串字面量集中 const（B.p169-2 闭环）
 */


/** per-agent 自身 skills 目录默认值（motion 自有 + 各 claw 各自 skills） */
export const SKILLS_DIR_DEFAULT = 'skills' as const;

/**
 * skill 目录发布态 marker（Phase 1913 Step C，RACE-PUBLISH-PRECOMMIT-VISIBILITY）。
 * owner = 本模块（foundation）；发布方（CLI skill install）在 absent 目标占位后
 * 立即写入、落位+sweep 通过后删除（删除=提交，单向事实可从磁盘重建）。
 * registry 只消费此 marker 的在与不在：在 = in_progress 不可消费；不在 =
 * 已提交完整版本或普通用户内容。CLI 私有 claim 文件名语义不进入本层。
 *
 * Phase 1915 Step B（RACE-SKILL-TARGET-PRECOMMIT）：marker 是 target-local
 * 提交事实——只承诺本 skillsDir 下该目标自身完整发布，不推出任何其他目标
 * （Motion self / dispatch pool / Claw copy）的状态；registry 只判断当前
 * skillsDir 目标自身发布态，不读取跨目标 CLI install intent。发布后副本
 * 是独立可编辑资源，post-install 编辑是合法业务动作。
 *
 * Phase 1916 Step B（RACE-DISPATCH-SOURCE-PROTOCOL-ARTIFACT）：本 marker 同时
 * 是 source 侧协议工件边界——skill install 拍 source snapshot 时，source 根
 * 含本 marker = source 发布未提交，必须 fail-closed/retry，marker 字节绝不
 * 进入 snapshot/manifest/target payload。过滤边界只含本 owner 声明的保留名
 * （不含其他隐藏文件——用户合法 payload 如 `.env` 模板照常复制）。
 */
export const SKILL_PUBLISH_MARKER = '.skill-publishing' as const;

/**
 * skill 安装 source snapshot 目录名前缀（Phase 1915 Step C，
 * RACE-DISPATCH-SOURCE-SNAPSHOT）。owner = 本模块（foundation）；CLI 安装方把
 * 可变 source（dispatch pool / 用户 source dir）先 materialize 成 claim 同级
 * 隐藏快照目录 `<prefix><skillName>-<token>`——快照即本次安装的 source
 * identity，随 install intent 持久化，发布与恢复都只从快照读取。registry
 * 按隐藏目录规则（`.` 前缀）不注册快照；清扫/重建归 CLI 发布协议。
 */
export const SKILL_SOURCE_SNAPSHOT_PREFIX = '.skill-srcsnap-' as const;

/**
 * skill 安装 post-commit 身份证据（Phase 1916 Step C follow-up，
 * RACE-SKILL-COMMITTING-ABSENT-IDENTITY）。owner = 本模块（foundation）；
 * CLI 发布方在 absent 分支删 marker（提交点）前写入 target 根——内容
 * {installId, manifestHash, branch, committedAt}，证明「marker 删除是本
 * intent 的提交动作」；intent 登记 published 后由 CLI best-effort 清理
 * （残留为惰性证据：不进 payload/manifest，下次更新随旧版入 trash）。
 * 本工件不是技能 payload：computeSkillSourceManifest/copyDir 快照边界按本
 * 保留名过滤（仅根级），registry 只消费 marker 在与不在、不读本工件；
 * 普通 snapshot sweep 不得删除它（它随 target 存亡，不在 claim 同级）。
 */
export const SKILL_COMMIT_PROOF = '.skill-committed' as const;

/** 源码树 bundled skills 资源目录名（非运行期 agent subdir） */
export const BUNDLED_SKILLS_DIR_NAME = 'skills' as const;

// dispatch-skills const 物理迁 evolution-system/dispatch-skills-paths.ts (phase411 / 资源归属 EvolutionSystem)
