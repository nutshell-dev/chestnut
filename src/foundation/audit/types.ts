/** Compile-time brand field — prevents structural matching of plain `{ write: ... }` mocks. */
export interface AuditLog {
  readonly __brand: 'AuditLog';
  write(type: string, ...cols: (string | number)[]): void;
  dispose?(): void;
}
