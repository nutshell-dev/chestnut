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
 */
export const SKILL_PUBLISH_MARKER = '.skill-publishing' as const;

/** 源码树 bundled skills 资源目录名（非运行期 agent subdir） */
export const BUNDLED_SKILLS_DIR_NAME = 'skills' as const;

// dispatch-skills const 物理迁 evolution-system/dispatch-skills-paths.ts (phase411 / 资源归属 EvolutionSystem)
