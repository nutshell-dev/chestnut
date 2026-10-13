export interface TurnTracker {
  begin(): void;
  end(): void;
  abort(): void;
  interrupted(): void;
  requestInterrupt(source: 'esc'): void;
  forceReset(): void;
  isActive(): boolean;
  getInterruptSource(): 'esc' | null;
  destroy(): void;
}

/** phase 1937 Step C: 输入层到历史窗口的控制面（display.historyControls 兑现）。 */
export interface ViewportHistoryControls {
  isBrowsing(): boolean;
  scrollUp(lines: number): void;
  scrollDown(lines: number): void;
  pageUp(): void;
  pageDown(): void;
  toOldest(): void;
  toBottom(): void;
}
