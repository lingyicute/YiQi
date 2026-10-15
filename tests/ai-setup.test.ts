import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiPlayer } from '../src/ai/aiPlayer';
import { prepareModels, revokeModelUrl } from '../src/ai/modelFiles';
import { KataGoClient } from '../src/ai/client';

vi.mock('../src/ai/modelFiles', () => ({
  prepareModels: vi.fn(), revokeModelUrl: vi.fn(), preferredBackend: vi.fn(async () => 'wasm'),
  modelsCached: vi.fn(), TOTAL_DOWNLOAD_BYTES: 10,
}));
vi.mock('../src/ai/client', () => ({
  KataGoClient: vi.fn(function () {
    return { init: vi.fn(async () => ({ backend: 'wasm' })), dispose: vi.fn(), cancel: vi.fn() };
  }),
}));
const result = () => ({ humanModelUrl: 'blob:human', mainModelUrl: 'blob:main', humanBlob: new Blob(['human']) });
afterEach(() => vi.clearAllMocks());

describe('AI setup lifecycle', () => {
  it('concurrent callers wait for the same setup operation', async () => {
    let release!: (r: ReturnType<typeof result>) => void;
    vi.mocked(prepareModels).mockImplementation(() => new Promise(r => { release = r; }));
    const ai = new AiPlayer();
    const first = ai.setup(() => {});
    const second = ai.setup(() => {});
    expect(first).toBe(second);
    await Promise.resolve();
    expect(ai.ready).toBe(false);
    release(result());
    await Promise.all([first, second]);
    expect(prepareModels).toHaveBeenCalledTimes(1);
    expect(ai.ready).toBe(true);
    ai.dispose();
    expect(revokeModelUrl).toHaveBeenCalledWith('blob:human');
    expect(revokeModelUrl).toHaveBeenCalledWith('blob:main');
  });
  it('dispose during download cannot resurrect a ready worker or leak URLs', async () => {
    let release!: (r: ReturnType<typeof result>) => void;
    vi.mocked(prepareModels).mockImplementation(() => new Promise(r => { release = r; }));
    const ai = new AiPlayer();
    const pending = ai.setup(() => {});
    const rejected = expect(pending).rejects.toThrow('canceled');
    await Promise.resolve();
    ai.dispose();
    release(result());
    await rejected;
    expect(ai.status).toBe('idle');
    expect(KataGoClient).not.toHaveBeenCalled();
    expect(revokeModelUrl).toHaveBeenCalledTimes(2);
  });
});
