import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnixDomainSocketTransport } from '../../src/foundation/transport/unix-socket.js';

const mockDelete = vi.fn().mockResolvedValue(undefined);
const mockFs = { delete: mockDelete };

function createMockServer(scenario: {
  error?: { code: string };
  closeError?: Error;
} = {}) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'error' && scenario.error) {
        handler({ code: scenario.error.code } as unknown as Error);
      } else {
        (listeners[event] ||= []).push(handler);
      }
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      (listeners[event] ||= []).push(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const idx = listeners[event]?.indexOf(handler) ?? -1;
      if (idx !== -1) listeners[event].splice(idx, 1);
    }),
    listen: vi.fn((_path: string, cb: () => void) => {
      if (!scenario.error) cb();
    }),
    close: vi.fn((cb: (err?: Error) => void) => {
      cb(scenario.closeError);
    }),
  };
}

vi.mock('node:net', () => ({
  createServer: vi.fn(() => createMockServer()),
  connect: vi.fn(),
}));

import { createServer } from 'node:net';

describe('UnixDomainSocketTransport', () => {
  let transport: UnixDomainSocketTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockResolvedValue(undefined);
    transport = new UnixDomainSocketTransport({ fs: mockFs as unknown as import('../../src/foundation/fs/index.js').FileSystem });
  });

  it('cleans socketPath even when server.close() fails', async () => {
    const socketPath = '/tmp/test-phase971.sock';
    const mockServer = createMockServer({ closeError: new Error('EIO') });
    (createServer as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockServer);

    await transport.listen({ socketPath });
    expect((transport as { socketPath: string | null }).socketPath).toBe(socketPath);

    await expect(transport.close()).rejects.toThrow('EIO');
    expect(mockDelete).toHaveBeenCalledWith(socketPath);
    expect((transport as { socketPath: string | null }).socketPath).toBeNull();
  });

  it('does not set socketPath when listen fails', async () => {
    const socketPath = '/tmp/test-phase971.sock';
    const mockServer = createMockServer({ error: { code: 'EACCES' } });
    (createServer as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockServer);

    await expect(transport.listen({ socketPath })).rejects.toThrow();
    expect((transport as { socketPath: string | null }).socketPath).toBeNull();
  });
});
