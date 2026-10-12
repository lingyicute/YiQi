/**
 * YiQi 人机对战层（见 围棋AI选型.md 的配置参数）：
 *
 * - 人类网络（b18c384nbt-humanv0）负责「选哪手」：imitate 棋风，棋力由
 *   humanSLProfile 档位决定（四个难度 = 四个段位档：20k / 8k / 1d / 3d）。
 * - 主网络（g170-b6c96）只负责「该不该停一手」，maxVisits = 64。
 * - allowResignation = false（避免小网络误判）。
 */
import type { KataGoAnalysisPayload } from './katago/workerTypes';
import { pickHumanBotMove } from './humanBotMove';
import type { CandidateMove } from './types';
import { KataGoClient, type AnalyzeArgs, type InitResult } from './client';
import { prepareModels, modelsCached, revokeModelUrl, preferredBackend, TOTAL_DOWNLOAD_BYTES } from './modelFiles';
import type { BoardState, GameRules, Move, Player } from './types';
import { KOMI } from '../core/rules';

export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';

export const DIFFICULTY_PROFILES: Record<Difficulty, string> = {
  easy: 'rank_20k',
  medium: 'rank_8k',
  hard: 'rank_1d',
  expert: 'rank_3d',
};

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: '简单',
  medium: '中等',
  hard: '困难',
  expert: '专家',
};

export const DIFFICULTY_RANK_LABEL: Record<Difficulty, string> = {
  easy: '20级',
  medium: '8级',
  hard: '1段',
  expert: '3段',
};

export type AIStatus =
  | 'idle'        // 未开始（模型未下载）
  | 'downloading'
  | 'initializing'
  | 'ready'
  | 'failed';

export class AiPlayer {
  private client: KataGoClient | null = null;
  private mainModelUrl: string | null = null;
  private humanModelUrl: string | null = null;
  private humanBlob: Blob | null = null;
  private backend: string | null = null;
  private aborted = 0;
  status: AIStatus = 'idle';
  lastError: string | null = null;
  /** 最近一次分析的目差（黑方视角），供状态栏显示。 */
  lastScoreLead: number | null = null;

  /** 模型是否已可用（缓存命中即认为可用）。 */
  static async modelsCached(): Promise<boolean> {
    return modelsCached();
  }

  static totalDownloadBytes(): number {
    return TOTAL_DOWNLOAD_BYTES;
  }

  /** 下载（带进度回调）并初始化引擎。重复调用安全。 */
  async setup(onProgress: (received: number, total: number, speed: number) => void): Promise<void> {
    if (this.status === 'ready' || this.status === 'downloading' || this.status === 'initializing') return;
    this.status = 'downloading';
    this.lastError = null;
    try {
      const backend = await preferredBackend();
      const { humanModelUrl, humanBlob, mainModelUrl } = await prepareModels((p) => {
        onProgress(p.receivedBytes, p.totalBytes, p.bytesPerSecond);
      });
      this.humanModelUrl = humanModelUrl;
      this.mainModelUrl = mainModelUrl;
      // 记录 Blob 供首次 analyze 零拷贝 transfer；传输后即释放主线程引用
      this.humanBlob = humanBlob;
      this.status = 'initializing';
      this.client?.dispose();
      this.client = new KataGoClient();
      const init: InitResult = await this.client.init(mainModelUrl, backend);
      this.backend = init.backend;
      this.status = 'ready';
    } catch (err) {
      this.status = 'failed';
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  get ready(): boolean {
    return this.status === 'ready' && !!this.client;
  }

  get backendName(): string | null {
    return this.backend;
  }

  /** 让正在进行的思考作废（悔棋/重开/换难度）。返回作废令牌。 */
  cancel(): void {
    this.aborted++;
  }

  /**
   * 为当前局面计算 AI 的一手（可能为停一手）。
   * 返回前保证至少 elapsed 至 delayTarget 毫秒，落子节奏更像人。
   */
  async chooseMove(args: {
    difficulty: Difficulty;
    board: BoardState;
    previousBoard?: BoardState;
    previousPreviousBoard?: BoardState;
    currentPlayer: Player;
    moveHistory: Move[];
    repetitionHistory?: readonly string[];
    rules: GameRules;
    isLegal: (x: number, y: number) => boolean;
    onStarted?: () => void;
  }): Promise<{ x: number; y: number; isPass: boolean }> {
    if (!this.client || !this.mainModelUrl || !this.humanModelUrl) {
      throw new Error('AI 尚未就绪');
    }
    const token = ++this.aborted && this.aborted;
    args.onStarted?.();

    const analyzeArgs: AnalyzeArgs = {
      modelUrl: this.mainModelUrl,
      backend: this.backend === 'webgpu' ? 'webgpu' : undefined,
      board: args.board,
      previousBoard: args.previousBoard,
      previousPreviousBoard: args.previousPreviousBoard,
      currentPlayer: args.currentPlayer,
      moveHistory: args.moveHistory,
      repetitionHistory: args.repetitionHistory,
      komi: KOMI,
      rules: args.rules,
      // 围棋AI选型.md：maxVisits = 64 —— 主网络只判断停一手/胜负，64 visits 足够
      visits: 64,
      maxTimeMs: 60000,
      topK: 6,
      ownershipMode: 'root',
      nnRandomize: true,
      humanModelUrl: this.humanModelUrl,
      humanModelBlobProvider: () => {
        const b = this.humanBlob;
        this.humanBlob = null; // 一次性：transfer 后释放主线程引用
        if (b && this.humanModelUrl) revokeModelUrl(this.humanModelUrl); // URL 字符串仍作缓存键
        return b;
      },
      humanSlProfile: DIFFICULTY_PROFILES[args.difficulty],
      humanSlRootExploreProb: 0,
    };

    let analysis: KataGoAnalysisPayload | null = null;
    try {
      analysis = await this.client.analyze(analyzeArgs);
    } finally {
      if (this.aborted !== token) throw new Error('canceled');
    }
    if (!analysis) throw new Error('AI 分析失败');

    this.lastScoreLead = analysis.rootScoreLead;

    // 停一手由主网络判断：引擎首选为 pass 即停一手（humanSLChosenMoveIgnorePass）
    const engineBest = analysis.moves.find((m) => m.order === 0) ?? analysis.moves[0] ?? null;
    if (engineBest && engineBest.x < 0 && engineBest.y < 0) {
      return { x: -1, y: -1, isPass: true };
    }

    const pick = pickHumanBotMove({
      humanPolicy: analysis.humanPolicy ?? analysis.ownership.map(() => 0),
      boardSize: args.board.length,
      engineBest,
      candidates: analysis.moves as CandidateMove[],
      playerToMove: args.currentPlayer,
      turnNumber: args.moveHistory.length,
      isLegal: args.isLegal,
    });

    if (!pick) return { x: -1, y: -1, isPass: true };
    if (!args.isLegal(pick.x, pick.y)) {
      // 理论上不会发生（双方超级劫实现一致）；兜底：用引擎首选，再不行就停一手
      if (engineBest && engineBest.x >= 0 && args.isLegal(engineBest.x, engineBest.y)) {
        return { x: engineBest.x, y: engineBest.y, isPass: false };
      }
      return { x: -1, y: -1, isPass: true };
    }
    return { x: pick.x, y: pick.y, isPass: false };
  }

  /** 胜负判断用的终局归属（ownership），用于自动标死子。 */
  async finalOwnership(args: {
    board: BoardState;
    previousBoard?: BoardState;
    currentPlayer: Player;
    moveHistory: Move[];
    repetitionHistory?: readonly string[];
    rules: GameRules;
  }): Promise<Float32Array | null> {
    if (!this.client || !this.mainModelUrl) return null;
    try {
      const analysis = await this.client.analyze({
        modelUrl: this.mainModelUrl,
        board: args.board,
        previousBoard: args.previousBoard,
        currentPlayer: args.currentPlayer,
        moveHistory: args.moveHistory,
        repetitionHistory: args.repetitionHistory,
        komi: KOMI,
        rules: args.rules,
        visits: 64,
        maxTimeMs: 30000,
        ownershipMode: 'root',
        topK: 1,
      });
      return Float32Array.from(analysis.ownership);
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.cancel();
    this.client?.dispose();
    this.client = null;
    if (this.humanModelUrl) {
      revokeModelUrl(this.humanModelUrl);
      this.humanModelUrl = null;
    }
    this.status = 'idle';
  }
}
