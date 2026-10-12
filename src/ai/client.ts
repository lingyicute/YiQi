/**
 * 引擎 Worker 客户端：主线程 ↔ KataGo 引擎（Web Worker）的消息协议封装。
 * 协议与 web-katrain（MIT）保持一致；此处是精简的单请求队列版本。
 */
import { getWorkerConstructor } from './env';
import type {
  KataGoAnalyzeRequest,
  KataGoAnalysisPayload,
  KataGoWorkerResponse,
} from './katago/workerTypes';
import type { BoardState, GameRules, KataGoBackendPreference, Move, Player } from './types';

export type AnalyzeArgs = {
  modelUrl: string;
  backend?: KataGoBackendPreference;
  board: BoardState;
  previousBoard?: BoardState;
  previousPreviousBoard?: BoardState;
  currentPlayer: Player;
  moveHistory: Move[];
  repetitionHistory?: readonly string[];
  komi: number;
  rules?: GameRules;
  visits?: number;
  maxTimeMs?: number;
  batchSize?: number;
  maxChildren?: number;
  topK?: number;
  ownershipMode?: 'none' | 'root' | 'tree';
  nnRandomize?: boolean;
  conservativePass?: boolean;
  humanModelUrl?: string;
  /** 人类网络字节的来源 Blob（只读一次，随后零拷贝 transfer 给 Worker）。 */
  humanModelBlobProvider?: () => Promise<Blob> | Blob | null;
  humanSlProfile?: string;
  humanSlRootExploreProb?: number;
};

export type InitResult = { backend: string; modelName?: string };

export class KataGoClient {
  private worker: Worker;
  private nextId = 1;
  private pendingAnalyze = new Map<number, {
    resolve: (a: KataGoAnalysisPayload) => void;
    reject: (e: Error) => void;
  }>();
  private pendingInit: { resolve: (r: InitResult) => void; reject: (e: Error) => void } | null = null;
  private crashed: Error | null = null;
  private humanBufferSent = false;

  constructor() {
    const Ctor = getWorkerConstructor();
    if (!Ctor) throw new Error('当前浏览器不支持 Web Worker，无法运行 AI 引擎');
    // 直接 new Worker(...)（Vite 依赖这一模式静态分析并打包 worker）
    this.worker = new Worker(new URL('./katago/engineWorker.ts', import.meta.url), { type: 'module' });
    void Ctor;
    this.worker.onmessage = (ev: MessageEvent<KataGoWorkerResponse>) => {
      this.crashed = null;
      const msg = ev.data;
      if (msg.type === 'katago:notice') {
        if (msg.level === 'warn') console.warn('[katago]', msg.message);
        else console.info('[katago]', msg.message);
        return;
      }
      if (msg.type === 'katago:init_result') {
        const pending = this.pendingInit;
        if (!pending) return;
        this.pendingInit = null;
        if (msg.ok) pending.resolve({ backend: msg.backend ?? 'unknown', modelName: msg.modelName });
        else pending.reject(new Error(msg.error ?? '引擎初始化失败'));
        return;
      }
      if (msg.type === 'katago:analyze_result') {
        const pending = this.pendingAnalyze.get(msg.id);
        if (!pending) return;
        this.pendingAnalyze.delete(msg.id);
        if (msg.canceled) {
          pending.reject(new Error('canceled'));
          return;
        }
        if (!msg.ok || !msg.analysis) pending.reject(new Error(msg.error ?? '分析失败'));
        else pending.resolve(msg.analysis);
      }
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'AI 引擎崩溃');
      this.crashed = err;
      for (const [, p] of this.pendingAnalyze) p.reject(err);
      this.pendingAnalyze.clear();
      this.pendingInit?.reject(err);
      this.pendingInit = null;
    };
  }

  get backendCrash(): Error | null {
    return this.crashed;
  }

  init(modelUrl: string, backend?: KataGoBackendPreference): Promise<InitResult> {
    this.rejectIfCrashed();
    const p = new Promise<InitResult>((resolve, reject) => {
      this.pendingInit = { resolve, reject };
    });
    this.post({ type: 'katago:init', modelUrl, backend });
    return p;
  }

  async analyze(args: AnalyzeArgs): Promise<KataGoAnalysisPayload> {
    this.rejectIfCrashed();
    const id = this.nextId++;
    const req: KataGoAnalyzeRequest & { humanModelBuffer?: ArrayBuffer } = {
      type: 'katago:analyze',
      id,
      modelUrl: args.modelUrl,
      backend: args.backend,
      board: args.board,
      previousBoard: args.previousBoard,
      previousPreviousBoard: args.previousPreviousBoard,
      currentPlayer: args.currentPlayer,
      moveHistory: args.moveHistory,
      repetitionHistory: args.repetitionHistory,
      komi: args.komi,
      rules: args.rules,
      visits: args.visits,
      maxTimeMs: args.maxTimeMs,
      batchSize: args.batchSize,
      maxChildren: args.maxChildren,
      topK: args.topK,
      ownershipMode: args.ownershipMode,
      nnRandomize: args.nnRandomize,
      conservativePass: args.conservativePass,
      humanModelUrl: args.humanModelUrl,
      humanSlProfile: args.humanSlProfile,
      humanSlRootExploreProb: args.humanSlRootExploreProb,
    };
    // 人类网络字节只传输一次（transferable 零拷贝），之后 Worker 常驻已解析的模型
    let transfer: Transferable[] | undefined;
    if (!this.humanBufferSent && args.humanModelUrl && args.humanModelBlobProvider) {
      const blob = await args.humanModelBlobProvider();
      if (blob) {
        req.humanModelBuffer = await blob.arrayBuffer();
        transfer = [req.humanModelBuffer];
      }
      this.humanBufferSent = true;
    }
    const p = new Promise<KataGoAnalysisPayload>((resolve, reject) => {
      this.pendingAnalyze.set(id, { resolve, reject });
    });
    try {
      this.post(req, transfer);
    } catch (err) {
      this.pendingAnalyze.delete(id);
      throw err instanceof Error ? err : new Error(String(err));
    }
    return p;
  }

  dispose(): void {
    try {
      this.worker.terminate();
    } catch { /* ignore */ }
    this.pendingAnalyze.clear();
    this.pendingInit = null;
  }

  private rejectIfCrashed(): void {
    if (this.crashed) throw this.crashed;
  }

  private post(msg: object, transfer?: Transferable[]): void {
    if (transfer && transfer.length) this.worker.postMessage(msg, transfer);
    else this.worker.postMessage(msg);
  }
}
