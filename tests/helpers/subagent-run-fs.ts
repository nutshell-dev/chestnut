import type { AtomicWriteResult, FileEntry, FileSystem } from '../../src/foundation/fs/index.js';

/** Minimal in-memory FileSystem for runSubagent tests, including no-replace claims. */
let nextMemoryFsId = 0;

export function makeSubagentRunFs(): FileSystem {
  const fsId = ++nextMemoryFsId;
  const files = new Map<string, string>();
  const normalize = (value: string) => value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  const missing = (recordPath: string) => Object.assign(new Error(`ENOENT: ${recordPath}`), { code: 'ENOENT' });
  const entries = (directory: string): FileEntry[] => {
    const prefix = `${normalize(directory)}/`;
    const children = new Map<string, FileEntry>();
    for (const [recordPath, content] of files) {
      const normalized = normalize(recordPath);
      if (!normalized.startsWith(prefix)) continue;
      const rest = normalized.slice(prefix.length);
      const [name, ...tail] = rest.split('/');
      const isDirectory = tail.length > 0;
      const childPath = `${prefix}${name}`;
      children.set(name, {
        name,
        path: childPath,
        isFile: !isDirectory,
        isDirectory,
        size: isDirectory ? 0 : content.length,
      });
    }
    return [...children.values()];
  };
  const durable = (): AtomicWriteResult => ({ kind: 'durable' });
  return {
    resolve: value => `memory-fs-${fsId}:/${value}`,
    ensureDir: async () => {},
    ensureDirSync: () => {},
    read: async recordPath => {
      const value = files.get(normalize(recordPath));
      if (value === undefined) throw missing(recordPath);
      return value;
    },
    write: async (recordPath, content) => { files.set(normalize(recordPath), content); },
    writeAtomic: async (recordPath, content) => {
      files.set(normalize(recordPath), content);
      return durable();
    },
    writeAtomicSync: (recordPath, content) => {
      files.set(normalize(recordPath), content);
      return durable();
    },
    append: async () => {},
    appendSync: () => {},
    delete: async recordPath => { files.delete(normalize(recordPath)); },
    exists: async recordPath => {
      const normalized = normalize(recordPath);
      return files.has(normalized) || [...files.keys()].some(key => key.startsWith(`${normalized}/`));
    },
    list: async directory => entries(directory),
    listSync: directory => entries(directory),
    linkExclusiveSync: (from, to) => {
      const source = files.get(normalize(from));
      if (source === undefined) throw missing(from);
      const target = normalize(to);
      if (files.has(target)) throw Object.assign(new Error(`EEXIST: ${to}`), { code: 'EEXIST' });
      files.set(target, source);
    },
    syncSync: () => {},
    watch: () => { throw new Error('watch is not supported by this test double'); },
    move: async () => { throw new Error('move is not supported by this test double'); },
    copy: async () => { throw new Error('copy is not supported by this test double'); },
    stat: async recordPath => {
      const content = files.get(normalize(recordPath));
      if (content === undefined) throw missing(recordPath);
      return { size: content.length, mtime: new Date(0) };
    },
  } as unknown as FileSystem;
}
