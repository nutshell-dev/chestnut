import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCapturingFetch,
  type HttpErrorCapture,
} from '../../../src/foundation/llm-provider/pi-ai-capture.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createCapturingFetch', () => {
  it('captures non-2xx status, retry-after and body without replacing the response', async () => {
    const original = new Response('provider error', {
      status: 400,
      headers: { 'retry-after': '3' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(original));
    const capture: HttpErrorCapture = {};

    const response = await createCapturingFetch(capture)('https://provider.test', {});

    expect(response).toBe(original);
    expect(capture).toEqual({ status: 400, retryAfter: '3', body: 'provider error' });
  });

  it('distinguishes an absent body from a body-read failure', async () => {
    const original = new Response(null, { status: 400 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(original));
    const capture: HttpErrorCapture = {};

    const response = await createCapturingFetch(capture)('https://provider.test', {});

    expect(response).toBe(original);
    expect(capture).toEqual({ status: 400, retryAfter: null, body: '' });
    expect(capture.bodyReadError).toBeUndefined();
  });

  it('preserves clone text rejection and returns the original response', async () => {
    const bodyReadError = new Error('body stream failed');
    const original = new Response(null, { status: 400 });
    vi.spyOn(original, 'clone').mockReturnValue({
      text: vi.fn().mockRejectedValue(bodyReadError),
    } as unknown as Response);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(original));
    const capture: HttpErrorCapture = {};

    const response = await createCapturingFetch(capture)('https://provider.test', {});

    expect(response).toBe(original);
    expect(capture).toMatchObject({ status: 400, bodyReadError });
    expect(capture.body).toBeUndefined();
    expect(capture.networkError).toBeUndefined();
  });

  it('preserves clone rejection as body-read evidence', async () => {
    const bodyReadError = new Error('clone failed');
    const original = new Response(null, { status: 500 });
    vi.spyOn(original, 'clone').mockImplementation(() => {
      throw bodyReadError;
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(original));
    const capture: HttpErrorCapture = {};

    const response = await createCapturingFetch(capture)('https://provider.test', {});

    expect(response).toBe(original);
    expect(capture).toMatchObject({ status: 500, bodyReadError });
    expect(capture.networkError).toBeUndefined();
  });

  it('does not clone a successful response', async () => {
    const original = new Response('ok', { status: 200 });
    const clone = vi.spyOn(original, 'clone');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(original));
    const capture: HttpErrorCapture = {};

    const response = await createCapturingFetch(capture)('https://provider.test', {});

    expect(response).toBe(original);
    expect(clone).not.toHaveBeenCalled();
    expect(capture).toEqual({});
  });

  it('records only networkError and rethrows fetch rejection', async () => {
    const networkError = new Error('socket failed');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));
    const capture: HttpErrorCapture = {};

    await expect(createCapturingFetch(capture)('https://provider.test', {}))
      .rejects.toBe(networkError);
    expect(capture).toEqual({ networkError });
  });
});
