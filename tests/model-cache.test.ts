import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadModelFile } from '../src/ai/modelCache';

const url = '/ai/model';
const cached = (body?: string) => ({
  match: vi.fn(async () => body === undefined ? undefined : new Response(body)),
  put: vi.fn(async () => {}),
  delete: vi.fn(async () => true),
});
afterEach(() => vi.unstubAllGlobals());

describe('model cache validation', () => {
  it('serves validated cached bytes without network', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const cache = cached('good'); const progress = vi.fn();
    expect(await (await loadModelFile(cache as unknown as Cache, url, 4, progress)).text()).toBe('good');
    expect(fetch).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith(4);
  });
  it('evicts corrupt cache and replaces it with a validated download', async () => {
    const cache = cached('bad');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('good')));
    const blob = await loadModelFile(cache as unknown as Cache, url, 4, () => {});
    expect(await blob.text()).toBe('good');
    expect(cache.delete).toHaveBeenCalledWith(url);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });
  it.each(['bad', 'oversize'])('never caches a truncated or oversized response: %s', async (body) => {
    const cache = cached();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    await expect(loadModelFile(cache as unknown as Cache, url, 4, () => {})).rejects.toThrow();
    expect(cache.put).not.toHaveBeenCalled();
  });
  it('downloads without Cache Storage and tolerates cache read/write failures', async () => {
    const fetch = vi.fn(async () => new Response('good')); vi.stubGlobal('fetch', fetch);
    const cache = cached();
    cache.match.mockRejectedValue(new Error('private mode'));
    cache.put.mockRejectedValue(new Error('quota exceeded'));
    for (const storage of [null, cache as unknown as Cache]) {
      expect(await (await loadModelFile(storage, url, 4, () => {})).text()).toBe('good');
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not read cache or fetch when already aborted', async () => {
    const cache = cached(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const abort = new AbortController(); abort.abort();
    await expect(loadModelFile(cache as unknown as Cache, url, 4, () => {}, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(cache.match).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels a failing stream rather than continuing an oversized download', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel,
    }))));
    await expect(loadModelFile(null, url, 4, () => {})).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
  });
});
