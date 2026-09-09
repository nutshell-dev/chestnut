export interface DialogStoreAuditSink {
  write(type: string, ...cols: (string | number)[]): void;
}
