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
