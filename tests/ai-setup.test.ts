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
    return { init: vi.fn(async () => ({ backend: 'wasm' })), dispose: vi.fn(), cancel: vi.fn(), analyze: vi.fn() };
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
  it.each([true, false])('releases retry bytes only after successful human-policy loading: %s', async loaded => {
    vi.mocked(prepareModels).mockResolvedValue(result());
    const ai = new AiPlayer();
    await ai.setup(() => {});
    const client = vi.mocked(KataGoClient).mock.results[0]!.value;
    client.analyze.mockResolvedValue({
      humanPolicy: loaded ? new Float32Array(82) : undefined,
      ownership: new Float32Array(81), rootScoreLead: 0,
      moves: [{ order: 0, x: -1, y: -1 }],
    });
    await ai.chooseMove({ difficulty: 'easy', board: Array.from({ length: 9 }, () => Array(9).fill(null)), currentPlayer: 'black', moveHistory: [], rules: 'chinese-ogs', isLegal: () => true });
    expect(revokeModelUrl).toHaveBeenCalledTimes(loaded ? 1 : 0);
    ai.dispose();
  });

  it('a crashed worker is not ready and setup can replace it', async () => {
    vi.mocked(prepareModels).mockResolvedValue(result());
    const ai = new AiPlayer();
    await ai.setup(() => {});
    const client = vi.mocked(KataGoClient).mock.results[0]!.value;
    client.backendCrash = new Error('crashed');
    expect(ai.ready).toBe(false);
    await ai.setup(() => {});
    expect(client.dispose).toHaveBeenCalled();
    expect(KataGoClient).toHaveBeenCalledTimes(2);
    expect(ai.ready).toBe(true);
    ai.dispose();
  });

});
