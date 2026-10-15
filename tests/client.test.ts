import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KataGoClient, type AnalyzeArgs } from '../src/ai/client';

class FakeWorker {
  static current: FakeWorker;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.current = this; }
  message(data: unknown) { this.onmessage?.({ data }); }
}
const args: AnalyzeArgs = { modelUrl: '/model', board: [[null]], currentPlayer: 'black', moveHistory: [], komi: 7.5 };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

beforeEach(() => vi.stubGlobal('Worker', FakeWorker));
afterEach(() => vi.unstubAllGlobals());

describe('KataGoClient lifecycle', () => {
  it('dispose rejects pending init and analyze instead of leaving them unsettled', async () => {
    const client = new KataGoClient();
    const init = client.init('/model');
    const analyze = client.analyze(args);
    const settled = Promise.allSettled([init, analyze]);
    client.dispose();
    expect((await settled).every(r => r.status === 'rejected')).toBe(true);
    await expect(client.analyze(args)).rejects.toThrow();
  });

  it('a second init is rejected without overwriting the first promise', async () => {
    const client = new KataGoClient();
    const first = client.init('/one');
    await expect(client.init('/two')).rejects.toThrow();
    FakeWorker.current.message({ type: 'katago:init_result', ok: true, backend: 'wasm' });
    await expect(first).resolves.toEqual({ backend: 'wasm', modelName: undefined });
    client.dispose();
  });

  it('init postMessage failure rejects and permits a retry', async () => {
    const client = new KataGoClient();
    FakeWorker.current.postMessage.mockImplementationOnce(() => { throw new Error('clone failed'); });
    await expect(client.init('/model')).rejects.toThrow('clone failed');
    const retry = client.init('/model');
    FakeWorker.current.message({ type: 'katago:init_result', ok: true });
    await expect(retry).resolves.toMatchObject({ backend: 'unknown' });
    client.dispose();
  });

  it('cancel interrupts requests and prevents delayed Blob preparation from posting', async () => {
    const client = new KataGoClient();
    let release!: (blob: Blob) => void;
    const pending = client.analyze({ ...args, humanModelUrl: 'blob:human', humanModelBlobProvider: () => new Promise(r => { release = r; }) });
    const rejected = expect(pending).rejects.toThrow('canceled');
    await flush();
    client.cancel();
    release(new Blob(['model']));
    await rejected;
    await flush();
    expect(FakeWorker.current.postMessage.mock.calls.some(([msg]) => msg.type === 'katago:analyze')).toBe(false);
    client.dispose();
  });

  it('crash during Blob preparation rejects promptly and stays terminal after late notices', async () => {
    const client = new KataGoClient();
    const pending = client.analyze({ ...args, humanModelUrl: 'blob:human', humanModelBlobProvider: () => new Promise(() => {}) });
    const rejected = expect(pending).rejects.toThrow('crashed');
    await flush();
    FakeWorker.current.onerror?.({ message: 'crashed' });
    await rejected;
    FakeWorker.current.message({ type: 'katago:notice', level: 'info', message: 'late notice' });
    await expect(client.analyze(args)).rejects.toThrow('crashed');
    client.dispose();
  });

  it('concurrent analyses transfer a human Blob once and resolve out-of-order responses', async () => {
    const client = new KataGoClient();
    const provider = vi.fn(() => new Blob(['model']));
    const first = client.analyze({ ...args, humanModelUrl: 'blob:human', humanModelBlobProvider: provider });
    const second = client.analyze({ ...args, humanModelUrl: 'blob:human', humanModelBlobProvider: provider });
    await flush();
    expect(provider).toHaveBeenCalledTimes(1);
    const requests = FakeWorker.current.postMessage.mock.calls.map(([msg]) => msg);
    expect(requests).toHaveLength(2);
    expect(requests[0].humanModelBuffer).toBeInstanceOf(ArrayBuffer);
    expect(requests[1].humanModelBuffer).toBeUndefined();
    for (const request of [...requests].reverse()) FakeWorker.current.message({ type: 'katago:analyze_result', id: request.id, ok: true, analysis: { rootVisits: request.id } });
    expect((await first).rootVisits).toBe(requests[0].id);
    expect((await second).rootVisits).toBe(requests[1].id);
    client.dispose();
  });
});
