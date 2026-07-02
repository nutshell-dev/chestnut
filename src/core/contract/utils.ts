/**
 * @module L4.ContractSystem
 * @layer L4 业务层（Contract 工具函数）
 * @depends L1.FileSystem
 * @consumers L6.Watchdog, L6.ChatViewport
 * @contract design/modules/l4_contract_system.md
 *
 * Contract directory inspection utilities (read-only).
 *
 * Phase 792: getContractCreatedMs 已内联进 lightweight-query.ts 的 getActiveContractTimestamp，
 * 本文件暂留作未来 contract 只读工具函数的统一入口。
 */
