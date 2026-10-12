import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-core/dist/public/chained_ops/register_all_chained_ops';
import '@tensorflow/tfjs-backend-cpu';

import { parseKataGoModelV8 } from '../src/ai/katago/loadModelV8';
import { KataGoModelV8Tf } from '../src/ai/katago/modelV8';
import { MctsSearch } from '../src/ai/katago/analyzeMcts';
import { setBoardSize, BOARD_AREA } from '../src/ai/katago/fastBoard';
import { fillInputsV7FastForPosition } from '../src/ai/katago/positionInputsV7';
import { humanSlMetadataRow } from '../src/ai/katago/humanSlProfile';
import type { BoardState, Move } from '../src/ai/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.resolve(__dirname, '../public/ai/g170-b6c96-s175395328-d26788732.bin.gz');
const HUMAN_MODEL_PATH = path.resolve(__dirname, '../public/ai/b18c384nbt-humanv0.bin.gz.00');

export function hasModels(): boolean {
  return fs.existsSync(MODEL_PATH) && fs.existsSync(HUMAN_MODEL_PATH);
}

function emptyBoard(n: number): BoardState {
  return Array.from({ length: n }, () => Array.from({ length: n }, () => null));
}

async function loadModel(): Promise<KataGoModelV8Tf> {
  const gz = fs.readFileSync(MODEL_PATH);
  const raw = zlib.gunzipSync(gz);
  const parsed = parseKataGoModelV8(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  return new KataGoModelV8Tf(parsed);
}

describe('KataGo 引擎层（移植自 web-katrain，MIT）', () => {
  it('解析模型并完成一次前向', async () => {
    setBoardSize(9);
    const model = await loadModel();
    expect(model.modelVersion).toBe(8);

    const spatial = tf.zeros([1, 9, 9, 22], 'float32') as tf.Tensor4D;
    const global = tf.zeros([1, 19], 'float32') as tf.Tensor2D;
    const out = model.forwardValueOnly(spatial, global);
    const [value, scoreValue] = await Promise.all([out.value.data(), out.scoreValue.data()]);
    expect(value.length).toBe(3);
    expect(scoreValue.length).toBe(model.scoreValueChannels);
    spatial.dispose();
    global.dispose();
    out.value.dispose();
    out.scoreValue.dispose();
    model.dispose();
  });

  it('9×9 MCTS 搜索：64 visits 产出合法首选与 ownership', async () => {
    setBoardSize(9);
    const model = await loadModel();
    const board = emptyBoard(9);
    board[5]![4] = 'black'; // E4
    const history: Move[] = [{ x: 4, y: 5, player: 'black' }];

    const search = await MctsSearch.create({
      model,
      board,
      currentPlayer: 'white',
      moveHistory: history,
      komi: 7.5,
      rules: 'chinese-ogs',
      nnRandomize: false,
      conservativePass: true,
      maxChildren: 64,
      ownershipMode: 'root',
      rootSymmetrySamples: 1,
      wideRootNoise: 0.04,
    });
    const aborted = await search.run({ visits: 64, maxTimeMs: 120000, batchSize: 4 });
    expect(aborted).toBe(false);

    const analysis = search.getAnalysis({ topK: 5, analysisPvLen: 8, cloneBuffers: true });
    expect(analysis.rootVisits).toBeGreaterThanOrEqual(64);
    expect(analysis.ownership.length).toBe(BOARD_AREA);
    expect(analysis.policy.length).toBe(BOARD_AREA + 1);
    expect(analysis.moves.length).toBeGreaterThan(0);
    for (const mv of analysis.moves.slice(0, 3)) {
      expect(mv.x).toBeGreaterThanOrEqual(0);
      expect(mv.x).toBeLessThan(9);
      expect(mv.y).toBeGreaterThanOrEqual(0);
      expect(mv.y).toBeLessThan(9);
    }
    // 首选不应是第一手就 pass（开局 64 visits 下）
    const best = analysis.moves.find((m) => m.order === 0)!;
    expect(best.visits).toBeGreaterThan(0);
    // 根胜率在合理范围
    expect(analysis.rootWinRate).toBeGreaterThanOrEqual(0);
    expect(analysis.rootWinRate).toBeLessThanOrEqual(1);
    model.dispose();
  }, 300000);

  it('人类网络元数据行：段位档位可查询', () => {
    const row = humanSlMetadataRow({ profile: 'rank_1d', nextPlayer: 'black', boardArea: 361 });
    expect(row).not.toBeNull();
    expect(row!.length).toBeGreaterThan(0);
    const bad = humanSlMetadataRow({ profile: 'not_a_profile', nextPlayer: 'black', boardArea: 361 });
    expect(bad).toBeNull();
  });

  it('NN 输入填充：合法棋盘输入不抛错', () => {
    setBoardSize(9);
    const board = emptyBoard(9);
    board[4]![4] = 'white';
    const spatial = new Float32Array(9 * 9 * 22);
    const global = new Float32Array(19);
    fillInputsV7FastForPosition({
      board,
      currentPlayer: 'black',
      moveHistory: [{ x: 4, y: 4, player: 'white' }],
      komi: 7.5,
      rules: 'chinese-ogs',
      conservativePassAndIsRoot: true,
      outSpatial: spatial,
      outGlobal: global,
    });
    // 棋盘平面：白子位置应编码非零
    let nonzero = 0;
    for (const v of spatial) if (v !== 0) nonzero++;
    expect(nonzero).toBeGreaterThan(0);
  });
});
