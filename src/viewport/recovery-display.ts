/**
 * Phase 1826: 恢复安排的展示分类。
 * 穷尽显示——quota / rate-limit / transient / 需配置变化分别可辨；
 * 未知分类原样透出，不吞、不一律当作 transient。
 */
export function formatRecoveryErrorClass(errorClass: string): string {
  switch (errorClass) {
    case 'quota': return 'quota';
    case 'rate_limit': return 'rate-limit';
    case 'transient': return 'transient';
    case 'permanent': return 'config change needed';
    case 'unknown': return 'unknown';
    default: return errorClass;
  }
}
