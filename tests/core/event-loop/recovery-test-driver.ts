import { setImmediate } from 'node:timers/promises';

/** 测试本地事件握手：保留已发生事实，订阅不会丢失先到的事件。 */
export class TestEventSignal<T> {
  readonly events: T[] = [];
  private listeners = new Set<(event: T) => void>();

  emit(event: T): void {
    this.events.push(event);
    for (const listener of [...this.listeners]) listener(event);
  }

  waitForCount(target: number): Promise<void> {
    if (this.events.length >= target) return Promise.resolve();
    return new Promise(resolve => {
      const listener = () => {
        if (this.events.length < target) return;
        this.listeners.delete(listener);
        resolve();
      };
      this.listeners.add(listener);
    });
  }

  waitFor(predicate: (event: T) => boolean, occurrence = 1): Promise<T> {
    const existing = this.events.filter(predicate)[occurrence - 1];
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise(resolve => {
      let observed = this.events.filter(predicate).length;
      const listener = (event: T) => {
        if (!predicate(event)) return;
        observed += 1;
        if (observed < occurrence) return;
        this.listeners.delete(listener);
        resolve(event);
      };
      this.listeners.add(listener);
    });
  }
}

/** 假定时器不接管 setImmediate；让真实文件 I/O 与 Promise 链完成本轮。 */
export async function flushRealEventLoop(): Promise<void> {
  await setImmediate();
}
