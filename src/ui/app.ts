/**
 * YiQi 主控制器：对局流程、人机调度、终局计分、界面状态。
 * 模式：人机对战（四档，KataGo 人类网络imitate）/ 双人同屏。
 * 棋盘：9 / 13 / 19 路；规则：中国大陆规则（数子法，黑贴 7.5 目，禁全局同形）。
 */
import '../style.css';
import { GoGame, IllegalMoveError, KOMI, type ScoreSummary } from '../core/rules';
import { AiPlayer, DIFFICULTY_LABEL, DIFFICULTY_RANK_LABEL, type Difficulty } from '../ai/aiPlayer';
import { BoardRenderer, BLACK, WHITE } from './board';
import { playStoneSound, playWinSound, triggerHaptic } from './sounds';
import { LS, ACCENTS, emptyRecords, migrateRecords, type Records, type SessionSave, type Settings, normalizeSettings, parseSession } from './settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const MODE_LABEL: Record<string, string> = {
  'ai-easy': '简单', 'ai-medium': '中等', 'ai-hard': '困难', 'ai-expert': '专家', 'pvp': '双人',
};
const SUBTITLE: Record<string, string> = {
  'ai-easy': '人机对战 · 简单（20级）',
  'ai-medium': '人机对战 · 中等（8级）',
  'ai-hard': '人机对战 · 困难（1段）',
  'ai-expert': '人机对战 · 专家（3段）',
  'pvp': '双人同屏',
};
const MODE_TO_DIFF: Record<string, Difficulty> = {
  'ai-easy': 'easy', 'ai-medium': 'medium', 'ai-hard': 'hard', 'ai-expert': 'expert',
};
const SIZE_LABEL: Record<number, string> = { 9: '9路', 13: '13路', 19: '19路' };

const fmtTime = (s: number): string => {
  const m = Math.floor(s / 60), ss = s % 60;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};
const now = (): number => performance.now();

type Phase = 'play' | 'scoring';

class App {
  settings: Settings = normalizeSettings(LS.get<unknown>('settings', null));
  records: Records = migrateRecords(LS.get<unknown>('records', null));
  game: GoGame;
  renderer: BoardRenderer;

  mode = 'ai-hard';
  humanColor: number = BLACK;
  over = false;
  phase: Phase = 'play';
  recorded = false;
  aiThinking = false;
  private aiToken = 0;
  private scoringRevision = 0;
  private timerId: number | null = null;
  private timerRunning = false;
  elapsed = 0;

  ai = new AiPlayer();
  aiDownloadDismissed = false;
  private lastAnalyzedBoards: { cur: number[][] | null; prev: number[][] | null; prev2: number[][] | null } = { cur: null, prev: null, prev2: null };

  constructor() {
    this.game = new GoGame(this.settings.boardSize);
    this.mode = this.settings.mode in MODE_LABEL ? this.settings.mode : 'ai-hard';
    this.humanColor = this.settings.side === 'W' ? WHITE : BLACK;
    this.renderer = new BoardRenderer(
      $('board') as HTMLCanvasElement,
      $('boardWrap'),
      {
        size: this.settings.boardSize,
        board: this.game.board,
        lastMove: null,
        territory: null,
        removedPoints: new Set(),
        canPlay: true,
        scoring: false,
        previewColor: BLACK,
      },
    );
  }

  /* ================= 主题 ================= */

  applyTheme(theme: 'light' | 'dark'): void {
    document.documentElement.dataset.theme = theme;
    this.settings.theme = theme;
    LS.set('settings', this.settings);
    this.renderer.refreshPalette();
  }

  toggleTheme(): void {
    const cur = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    this.applyTheme(cur === 'light' ? 'dark' : 'light');
  }

  applyAccent(name: string): void {
    if (!ACCENTS[name]) return;
    document.documentElement.dataset.accent = name;
    this.settings.accent = name;
    LS.set('settings', this.settings);
    this.renderer.refreshPalette();
  }

  /* ================= HUD ================= */

  updateHUD(): void {
    const mv = $('moveLabel');
    const tv = $('turnValue');
    const caps = this.game.captures;
    $('capB').textContent = String(caps.byBlack);
    $('capW').textContent = String(caps.byWhite);
    let label = this.phase === 'scoring' ? '终局计分' : this.over ? `共 ${this.game.moveNumber} 手` : `第 ${this.game.moveNumber + 1} 手`;
    mv.textContent = label;

    const dot = (p: number) => `<span class="stone-dot ${p === BLACK ? 'black' : 'white'}"></span>`;
    let html: string;
    if (this.over) {
      html = this.resultText ? dot(this.resultWinner === 'black' ? BLACK : WHITE) + `<span>${this.resultText}</span>` : '<span>和棋</span>';
    } else if (this.phase === 'scoring') {
      html = `<span>标记死子后确认结果</span>`;
    } else if (this.mode === 'pvp') {
      html = dot(this.game.playerToMove === 'black' ? BLACK : WHITE) + `<span>${this.game.playerToMove === 'black' ? '黑棋' : '白棋'}回合</span>`;
    } else {
      const toMove = this.game.playerToMove === 'black' ? BLACK : WHITE;
      if (toMove === this.humanColor) {
        html = dot(toMove) + '<span>你的回合</span>';
      } else {
        html = dot(toMove) + `<span>${this.aiThinking ? 'AI 思考中…' : 'AI 回合'}</span>`;
      }
    }
    tv.innerHTML = html;

    const humanTurn = !this.over && this.phase === 'play' && (this.mode === 'pvp' || (this.game.playerToMove === 'black' ? BLACK : WHITE) === this.humanColor);
    ($('btnUndo') as HTMLButtonElement).disabled = this.aiThinking || this.phase === 'scoring' || this.game.moveNumber === 0;
    ($('btnPass') as HTMLButtonElement).disabled = !humanTurn;
    ($('btnResign') as HTMLButtonElement).disabled = this.over || this.phase === 'scoring' || this.game.moveNumber === 0;

    this.renderer.state.canPlay = humanTurn;
    this.renderer.state.scoring = this.phase === 'scoring';
    this.renderer.state.previewColor = (this.game.playerToMove === 'black' ? BLACK : WHITE);
    $('subtitle').textContent = SUBTITLE[this.mode] || '';
    const sizeChips = document.querySelectorAll('#sizes .chip');
    sizeChips.forEach((c) => c.classList.toggle('sel', Number((c as HTMLElement).dataset.size) === this.game.size));
    this.updateAILock();
  }

  updateAILock(): void {
    const locked = !this.ai.ready;
    const lockTip = this.wasmUnsupported ? '当前浏览器不支持 WASM，无法运行 AI' : '需要先下载 AI 模型';
    document.querySelectorAll('#modes .chip[data-mode^="ai-"]').forEach((c) => {
      const el = c as HTMLElement;
      el.classList.toggle('locked', locked);
      el.title = locked ? lockTip : '';
    });
  }

  /* ================= 计时 ================= */

  startTimer(): void {
    if (this.timerRunning) return;
    this.timerRunning = true;
    this.timerId = window.setInterval(() => {
      this.elapsed++;
      $('timer').textContent = fmtTime(this.elapsed);
    }, 1000);
  }

  stopTimer(): void {
    this.timerRunning = false;
    if (this.timerId) clearInterval(this.timerId);
    this.timerId = null;
  }

  /* ================= 对局流程 ================= */

  newGame(opts: { keepTimer?: boolean } = {}): void {
    this.ai.cancel();
    this.aiToken++;
    this.scoringRevision++;
    this.aiThinking = false;
    this.game = new GoGame(this.settings.boardSize);
    this.over = false;
    this.resultText = null;
    this.resultSGF = undefined;
    this.resultWinner = 'tie';
    this.phase = 'play';
    this.recorded = false;
    this.renderer.state.board = this.game.board;
    this.renderer.state.size = this.game.size;
    this.renderer.state.lastMove = null;
    this.renderer.state.territory = null;
    this.renderer.state.removedPoints = new Set();
    this.renderer.cursor = { x: 0, y: 0 };
    this.renderer.hover = null;
    this.renderer.kbdCursor = false;
    if (!opts.keepTimer) {
      this.stopTimer();
      this.elapsed = 0;
      $('timer').textContent = '00:00';
    }
    this.lastAnalyzedBoards = { cur: null, prev: null, prev2: null };
    LS.set('session', null);
    this.updateScoringUI();
    this.updateHUD();
    this.renderer.scheduleDraw();
    void this.maybeAI();
  }

  resultText: string | null = null;
  private resultSGF: string | undefined;
  resultWinner: 'black' | 'white' | 'tie' = 'tie';

  /** 渲染器棋盘与逻辑棋盘重新指向：GoGame 的 undo/resetToMoves 会整体重建引擎并更换 board 数组引用。 */
  private syncBoard(): void {
    this.renderer.state.board = this.game.board;
    this.renderer.state.size = this.game.size;
  }

  private snapshotBoards(): void {
    // 重放着法序列，得到当前局面的前一/前二手棋盘（NN 特征层需要）
    const replay = new GoGame(this.game.size);
    let prev2: number[][] | null = null;
    let prev: number[][] | null = null;
    for (const m of this.game.moves) {
      prev2 = prev;
      prev = replay.board.map((r) => r.slice());
      if (m.x === -1) replay.pass();
      else replay.place(m.x, m.y);
    }
    this.lastAnalyzedBoards = {
      cur: this.game.board.map((r) => r.slice()),
      prev,
      prev2,
    };
  }

  /** 落子（已通过规则校验后调用）。 */
  private commitMove(x: number, y: number, silent = false): void {
    const color = this.game.playerToMove === 'black' ? BLACK : WHITE;
    try {
      if (x === -1) this.game.pass();
      else this.game.place(x, y);
    } catch (err) {
      if (err instanceof IllegalMoveError) {
        // 超级劫拒绝时 GoGame 内部会重建引擎，board 数组引用已更换，必须重新同步渲染器
        this.syncBoard();
        this.toast(illegalMessage(err.code));
        return;
      }
      throw err;
    }
    this.snapshotBoards();
    if (!silent) playStoneSound(color === WHITE, this.settings.sound);
    triggerHaptic('move');
    this.renderer.state.lastMove = { x, y, at: now() };
    if (this.game.consecutivePasses >= 2) {
      this.enterScoring();
    } else {
      if (this.game.moveNumber > 0) this.startTimer();
    }
    this.updateHUD();
    this.saveSession();
    this.renderer.scheduleDraw();
  }

  /** 人类落子入口。 */
  humanPlace(x: number, y: number): boolean {
    if (this.dialogOpen || this.over || this.phase !== 'play' || this.aiThinking) return false;
    if (this.mode !== 'pvp' && (this.game.playerToMove === 'black' ? BLACK : WHITE) !== this.humanColor) return false;
    if (x >= 0 && this.game.board[y]![x] !== 0) return false;
    const moverIsBlack = this.game.playerToMove === 'black';
    this.renderer.kbdCursor = false;
    try {
      if (x === -1) this.game.pass();
      else this.game.place(x, y);
    } catch (err) {
      if (err instanceof IllegalMoveError) {
        this.syncBoard();
        this.toast(illegalMessage(err.code));
        this.renderer.hover = null;
        this.renderer.scheduleDraw();
        return false;
      }
      throw err;
    }
    this.snapshotBoards();
    playStoneSound(!moverIsBlack, this.settings.sound);
    triggerHaptic('move');
    this.renderer.state.lastMove = { x, y, at: now() };
    if (this.game.consecutivePasses >= 2) {
      this.enterScoring();
    } else {
      this.startTimer();
    }
    this.updateHUD();
    this.saveSession();
    this.renderer.scheduleDraw();
    void this.maybeAI();
    return true;
  }

  /* ================= AI ================= */

  async maybeAI(): Promise<void> {
    if (this.over || this.phase !== 'play' || this.mode === 'pvp' || this.aiThinking) return;
    const toMove = this.game.playerToMove === 'black' ? BLACK : WHITE;
    if (toMove === this.humanColor) return;
    if (!this.ai.ready) {
      // 模型未就绪：等待（AI 回合空转，直到模型就绪或用户改模式）
      const token = ++this.aiToken;
      setTimeout(() => {
        if (token === this.aiToken) void this.maybeAI();
      }, 1200);
      return;
    }
    const token = ++this.aiToken;
    this.aiThinking = true;
    this.updateHUD();
    try {
      const snap = this.lastAnalyzedBoards;
      // 合法性探针：独立棋盘试下+撤销，避免主棋盘被污染
      const probe = new GoGame(this.game.size);
      probe.resetToMoves(this.game.moves);
      const mv = await this.ai.chooseMove({
        difficulty: MODE_TO_DIFF[this.mode] || 'hard',
        board: snapToNN(this.game),
        previousBoard: nnFromGrid(snap.prev, this.game.size),
        previousPreviousBoard: nnFromGrid(snap.prev2, this.game.size),
        currentPlayer: this.game.playerToMove,
        moveHistory: this.game.nnMoveHistory(),
        repetitionHistory: this.game.repetitionHistory(),
        rules: 'chinese-ogs',
        isLegal: (x, y) => {
          if (x < 0 || y < 0) return true;
          if (probe.board[y]![x] !== 0) return false;
          try {
            probe.place(x, y);
          } catch {
            return false;
          }
          probe.undo(1);
          return true;
        },
      });
      if (token !== this.aiToken || this.over || this.phase !== 'play') return;
      this.aiThinking = false;
      this.commitMove(mv.x, mv.y);
      if (this.phase === 'play' && !this.over) void this.maybeAI();
    } catch (err) {
      if (token !== this.aiToken) return;
      this.aiThinking = false;
      if (err instanceof Error && err.message === 'canceled') {
        this.updateHUD();
        return;
      }
      console.error('[yiqi] AI 落子失败', err);
      this.toast('AI 出错：' + (err instanceof Error ? err.message : String(err)));
      this.updateHUD();
    }
  }

  /* ================= 终局计分 ================= */

  private enterScoring(autoMark = true): void {
    this.scoringRevision++;
    this.phase = 'scoring';
    this.stopTimer();
    this.ai.cancel();
    this.renderer.state.territory = this.computeTerritory();
    this.updateScoringUI();
    this.updateHUD();
    this.renderer.scheduleDraw();
    if (autoMark && this.mode !== 'pvp' && this.ai.ready) void this.autoMarkDead();
    this.toast('双方连续停一手，进入计分');
  }

  private computeTerritory(): Int8Array {
    const { ownership } = this.game.score();
    return ownership;
  }

  refreshScore(): void {
    this.renderer.state.removedPoints = this.game.removedPoints();
    this.renderer.state.territory = this.computeTerritory();
    this.renderer.scheduleDraw();
    const s = this.game.score();
    const el = $('scoreInfo');
    if (el) {
      el.textContent = `黑 ${trimNum(s.black)} 子 · 白 ${trimNum(s.white)} 子`;
    }
  }

  private async autoMarkDead(): Promise<void> {
    const game = this.game;
    const revision = this.scoringRevision;
    const ownership = await this.ai.finalOwnership({
      board: snapToNN(this.game),
      currentPlayer: this.game.playerToMove,
      moveHistory: this.game.nnMoveHistory(),
      repetitionHistory: this.game.repetitionHistory(),
      rules: 'chinese-ogs',
    });
    if (!ownership || this.phase !== 'scoring' || this.over || game !== this.game || revision !== this.scoringRevision) return;
    const n = this.game.size;
    // 按棋串多数票判死活，然后整组标记
    const visited = new Set<number>();
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const key = y * n + x;
        if (visited.has(key) || this.game.board[y]![x] === 0) continue;
        const color = this.game.board[y]![x]!;
        const group = this.game.groupAt(x, y);
        for (const p of group) visited.add(p.y * n + p.x);
        let deadVotes = 0;
        for (const p of group) {
          const own = ownership[p.y * n + p.x]!;
          if ((color === BLACK && own < 0) || (color === WHITE && own > 0)) deadVotes++;
        }
        if (deadVotes * 2 > group.length) {
          this.game.setGroupRemoved(x, y, true);
        }
      }
    }
    if (this.phase === 'scoring') {
      this.refreshScore();
      this.saveSession();
      this.toast('AI 已按形势判断标记死子，可点击棋子修改');
    }
  }

  private exitScoring(): void {
    this.scoringRevision++;
    this.ai.cancel();
    this.phase = 'play';
    this.game.clearRemoved();
    this.renderer.state.territory = null;
    this.renderer.state.removedPoints = new Set();
    this.updateScoringUI();
    this.updateHUD();
    this.renderer.scheduleDraw();
    this.startTimer();
  }

  /** 「继续对局」：从计分阶段回到对局。 */
  resumeFromScoring(): void {
    if (this.phase !== 'scoring') return;
    this.exitScoring();
    this.saveSession();
    void this.maybeAI();
    this.toast('已回到对局，继续落子');
  }

  /** 计分阶段：点击棋子切换死子状态。 */
  toggleDeadAt(x: number, y: number): void {
    if (this.phase !== 'scoring' || this.over) return;
    if (!this.game.board[y]![x]) return;
    this.scoringRevision++; // 手工判断优先于尚未返回的 AI 结果
    this.game.setGroupRemoved(x, y, !this.game.isRemoved(x, y));
    triggerHaptic('move');
    this.refreshScore();
    this.saveSession();
  }

  saveSettings(): void {
    LS.set('settings', this.settings);
  }

  saveRecords(): void {
    LS.set('records', this.records);
  }

  updateScoringUI(): void {
    const show = this.phase === 'scoring';
    $('scoringActions').style.display = show ? 'flex' : 'none';
    $('playHelp').style.display = show ? 'none' : 'block';
    $('scoringHelp').style.display = show ? 'block' : 'none';
    if (show) this.refreshScore();
  }

  confirmScore(): void {
    if (this.phase !== 'scoring') return;
    this.scoringRevision++;
    this.ai.cancel();
    const s = this.game.score();
    const diff = s.black - s.white;
    let winner: 'black' | 'white' | 'tie' = 'tie';
    let text = '和棋';
    if (diff > 0) { winner = 'black'; text = `黑胜 ${trimNum(diff)} 目`; }
    else if (diff < 0) { winner = 'white'; text = `白胜 ${trimNum(-diff)} 目`; }
    this.over = true;
    this.phase = 'play';
    this.resultText = text;
    this.resultWinner = winner;
    this.resultSGF = diff === 0 ? '0' : `${diff > 0 ? 'B' : 'W'}+${trimNum(Math.abs(diff))}`;
    this.renderer.state.territory = null;
    this.updateScoringUI();
    this.recordResult(winner);
    const humanWon = this.mode === 'pvp' ? true : (winner === 'black' ? BLACK : WHITE) === this.humanColor;
    if (this.mode === 'pvp' || humanWon) {
      setTimeout(() => { triggerHaptic('win'); playWinSound(this.settings.sound); }, 70);
    }
    this.updateHUD();
    this.saveSession();
    this.renderer.scheduleDraw();
    this.scheduleGameOver(650);
  }

  private recordResult(winner: 'black' | 'white' | 'tie'): void {
    if (this.mode === 'pvp' || this.recorded || winner === 'tie') return;
    const diff = MODE_TO_DIFF[this.mode] || 'hard';
    const r = this.records[diff] || { w: 0, l: 0 };
    const humanWon = (winner === 'black' ? BLACK : WHITE) === this.humanColor;
    if (humanWon) r.w++;
    else r.l++;
    this.records[diff] = r;
    this.recorded = true;
    LS.set('records', this.records);
  }

  /* ================= 悔棋 ================= */

  undo(): void {
    if (this.aiThinking || this.phase === 'scoring' || this.game.moveNumber === 0) return;
    if (this.over) {
      // 撤销终局结果
      if (this.mode !== 'pvp' && this.recorded) {
        const diff = MODE_TO_DIFF[this.mode] || 'hard';
        const r = this.records[diff];
        if (r) {
          const humanWon = (this.resultWinner === 'black' ? BLACK : WHITE) === this.humanColor;
          if (humanWon) r.w = Math.max(0, r.w - 1);
          else r.l = Math.max(0, r.l - 1);
          LS.set('records', this.records);
        }
        this.recorded = false;
      }
      this.over = false;
      this.resultText = null;
      this.resultSGF = undefined;
      this.startTimer();
    }
    const n = this.mode === 'pvp' ? 1 : Math.min(2, this.game.moveNumber);
    this.ai.cancel();
    this.aiToken++;
    this.scoringRevision++;
    this.game.undo(n);
    this.syncBoard();
    this.renderer.state.removedPoints = new Set();
    this.snapshotBoards();
    this.aiThinking = false;
    this.renderer.state.lastMove = null;
    this.updateHUD();
    this.saveSession();
    this.renderer.scheduleDraw();
    void this.maybeAI();
  }

  /* ================= 认输 ================= */

  /** 当前认输方：双人模式为行棋方，人机模式为人类。 */
  private resignLoserIsBlack(): boolean {
    return this.mode === 'pvp' ? this.game.playerToMove === 'black' : this.humanColor === BLACK;
  }

  requestResign(): void {
    if (this.over || this.phase === 'scoring' || this.game.moveNumber === 0) return;
    const loser = this.resignLoserIsBlack() ? '黑方' : '白方';
    // 双人模式不计入战绩（recordResult 对 pvp 直接跳过），文案须与之一致
    const body = this.mode === 'pvp'
      ? `${loser}中盘告负，对局立即结束。`
      : '你中盘告负，本局将计入战绩。';
    this.openDialog(`
      <div class="dlg-icon">${ICO.flag}</div>
      <div class="dlg-title">确认认输？</div>
      <div class="dlg-body">${body}</div>
      <div class="dlg-btns">
        <button class="btn-pill text" data-cmd="ok">继续比赛</button>
        <button class="btn-pill primary" data-cmd="resign-confirm">确认认输</button>
      </div>`);
  }

  confirmResign(): void {
    if (this.over || this.phase === 'scoring') return;
    this.closeDialog();
    this.ai.cancel();
    this.aiToken++;
    this.aiThinking = false;
    this.over = true;
    this.phase = 'play';
    this.resultWinner = this.resignLoserIsBlack() ? 'white' : 'black';
    this.resultText = this.resultWinner === 'black' ? '黑中盘胜' : '白中盘胜';
    this.resultSGF = this.resultWinner === 'black' ? 'B+R' : 'W+R';
    this.stopTimer();
    this.scoringRevision++;
    this.recordResult(this.resultWinner);
    this.updateHUD();
    this.saveSession();
    this.renderer.scheduleDraw();
    this.scheduleGameOver(400);
  }

  /* ================= 存档 ================= */

  saveSession(): void {
    if (!this.game.moveNumber) {
      LS.set('session', null);
      return;
    }
    const save: SessionSave = {
      mode: this.mode,
      side: this.humanColor === BLACK ? 'B' : 'W',
      size: this.game.size as 9 | 13 | 19,
      moves: this.game.moves.map((m) => ({ x: m.x, y: m.y })),
      elapsed: this.elapsed,
      over: this.over,
      phase: this.phase,
      removed: [...this.game.removedPoints()],
    };
    LS.set('session', save);
  }

  restoreSession(): void {
    const ses = parseSession(LS.get<unknown>('session', null));
    if (!ses || ses.over) return;
    this.settings.mode = ses.mode;
    this.settings.side = ses.side;
    this.settings.boardSize = ses.size;
    LS.set('settings', this.settings);
    this.mode = ses.mode;
    this.humanColor = ses.side === 'W' ? WHITE : BLACK;
    this.game = new GoGame(ses.size);
    try {
      this.game.resetToMoves(ses.moves);
    } catch {
      LS.set('session', null);
      this.newGame();
      return;
    }
    this.renderer.state.size = ses.size;
    this.renderer.state.board = this.game.board;
    this.snapshotBoards();
    this.renderer.fitBoard();
    this.elapsed = ses.elapsed;
    $('timer').textContent = fmtTime(this.elapsed);
    // 恢复各选项 UI
    document.querySelectorAll('#modes .chip').forEach((c) => c.classList.toggle('sel', (c as HTMLElement).dataset.mode === this.mode));
    document.querySelectorAll('#sides .chip').forEach((c) => c.classList.toggle('sel', (c as HTMLElement).dataset.side === ses.side));
    $('sides').style.display = this.mode === 'pvp' ? 'none' : 'flex';
    const scoring = ses.phase === 'scoring' || (ses.phase === undefined && this.game.consecutivePasses >= 2);
    if (scoring) {
      for (const point of ses.removed ?? []) this.game.setGroupRemoved(point % ses.size, Math.floor(point / ses.size), true);
      this.enterScoring(false);
    } else {
      this.startTimer();
      void this.maybeAI();
    }
    this.updateHUD();
    this.renderer.scheduleDraw();
  }

  /* ================= 下载与 AI 状态 ================= */

  /** 浏览器不支持 WebAssembly 时置真：不弹下载、AI 入口给出明确解释。 */
  wasmUnsupported = false;
  /** 浏览器无可用 WebGPU 时置真：下载前先弹一次显式提示（仅影响速度）。 */
  webgpuMissing = false;
  private webgpuNoticeShown = false;

  async bootstrapAI(): Promise<void> {
    const { wasmSupported, webgpuAvailable } = await import('../ai/modelFiles');
    if (!(await wasmSupported())) {
      this.wasmUnsupported = true;
      this.aiDownloadDismissed = true;
      this.updateAILock();
      return;
    }
    this.webgpuMissing = !(await webgpuAvailable());
    const cached = await AiPlayer.modelsCached();
    if (cached) {
      try {
        await this.ai.setup(() => { /* 缓存命中，无下载进度 */ });
        this.updateAILock();
        this.toast('AI 已就绪');
        void this.maybeAI();
        return;
      } catch (err) {
        console.error('[yiqi] AI 初始化失败', err);
        this.toast('AI 初始化失败，可在菜单中重试');
      }
    }
    if (!this.aiDownloadDismissed) {
      setTimeout(() => this.showDownloadDialog(), 500);
    }
    this.updateAILock();
  }

  toast(msg: string): void {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), 2200);
  }
  private toastTimer: number | null = null;

  dialogOpen = false;
  private dialogCloseTimer: number | null = null;
  private dialogRevision = 0;

  /* ================= 对话框 ================= */

  openDialog(html: string): void {
    this.dialogRevision++;
    if (this.dialogCloseTimer !== null) {
      window.clearTimeout(this.dialogCloseTimer);
      this.dialogCloseTimer = null;
      $('scrim').classList.remove('closing');
    }
    $('dialog').innerHTML = html;
    $('scrim').hidden = false;
    this.dialogOpen = true;
    const btn = $('dialog').querySelector('.btn-pill.primary');
    if (btn) setTimeout(() => (btn as HTMLElement).focus(), 30);
  }

  closeDialog(): void {
    const scrim = $('scrim');
    if (scrim.hidden || this.dialogCloseTimer !== null) return;
    this.dialogRevision++;
    this.dialogOpen = false;
    $('btnPalette').classList.remove('active');
    // 播放收起动画后再隐藏（与 up/fade 进场对称）
    scrim.classList.add('closing');
    this.dialogCloseTimer = window.setTimeout(() => {
      this.dialogCloseTimer = null;
      scrim.classList.remove('closing');
      scrim.hidden = true;
    }, 170);
  }

  /* ================= 终局 / 记录 / 规则 对话框 ================= */

  private scheduleGameOver(delay: number): void {
    const game = this.game;
    const revision = this.scoringRevision;
    setTimeout(() => {
      if (this.over && this.game === game && this.scoringRevision === revision) this.showGameOver();
    }, delay);
  }

  showGameOver(): void {
    const meta = `用时 ${fmtTime(this.elapsed)} · 共 ${this.game.moveNumber} 手`;
    let icon: string, title: string, body: string;
    if (this.mode === 'pvp') {
      icon = ICO.crown;
      title = this.resultWinner === 'tie' ? '和棋!' : `${this.resultWinner === 'black' ? '黑棋' : '白棋'}获胜!`;
      body = `${this.resultText || ''}<br>${meta}`;
    } else if (this.resultWinner !== 'tie' && (this.resultWinner === 'black' ? BLACK : WHITE) === this.humanColor) {
      const diff = MODE_TO_DIFF[this.mode] || 'hard';
      const r = this.records[diff] || { w: 0, l: 0 };
      const sideTxt = this.humanColor === BLACK ? '黑' : '白';
      icon = ICO.crown;
      title = '你赢了！';
      body = `恭喜！你执${sideTxt}在「${DIFFICULTY_LABEL[diff]}」难度战胜了 AI（${DIFFICULTY_RANK_LABEL[diff]}）。<br>${this.resultText} · ${meta}<br>本难度战绩 ${r.w} 胜 ${r.l} 负`;
    } else if (this.resultWinner === 'tie') {
      icon = ICO.handshake;
      title = '和棋!';
      body = `罕见的结果，势均力敌，${meta}。`;
    } else {
      icon = ICO.trophy;
      title = 'AI 获胜';
      body = `${this.resultText || ''}，${meta}。<br>调整策略后再试一次吧!`;
    }
    this.openDialog(`
      <div class="dlg-icon">${icon}</div>
      <div class="dlg-title">${title}</div>
      <div class="dlg-body" style="text-align:center">${body}</div>
      <div class="dlg-btns" style="justify-content:center">
        <button class="btn-pill text" data-cmd="ok">查看棋盘</button>
        <button class="btn-pill primary" data-cmd="again">再来一局</button>
      </div>`);
  }

  showWhatIsGo(): void {
    this.openDialog(`
      <div class="dlg-icon">${ICO.help}</div>
      <div class="dlg-title">什么是围棋?</div>
      <div class="dlg-body">
        <b>围棋（Go）</b>起源于中国，距今已有四千余年，是世界上最古老的棋类游戏，也是唯一能与之相称的策略艺术。<br><br>
        双方在棋盘交叉点上交替落子，目标是<b>围出更多的地盘</b>：用棋子围住对方的棋子即可将它吃掉，最终以围住的空点与存活的棋子合计多者获胜。<br><br>
        古人把它列入「琴棋书画」四艺。棋盘之上，一子一世界——十九路纵横三百六十一点，变化之多超越宇宙中原子的总数。<br><br>
        YiQi 采用<b>中国大陆规则</b>（数子法，黑贴 7.5 目），AI 由 <b>KataGo</b> 驱动。
      </div>
      <div class="dlg-btns"><button class="btn-pill primary" data-cmd="ok">知道了</button></div>`);
  }

  showHelp(): void {
    this.openDialog(`
      <div class="dlg-icon">${ICO.help}</div>
      <div class="dlg-title">规则说明</div>
      <div class="dlg-body">
        黑白轮流落子，<b>黑棋先行</b>，棋子落在交叉点上。棋子的「气」是紧邻的空点；<b>无气（被围死）的棋子被提离棋盘</b>。<br>
        <b>禁全局同形</b>：不得落子使局面回到对方下完最后一手前的形状（打劫需先在他处落子寻劫）。<b>禁自杀</b>：落子后自身无气且未提对方子，为禁着点。<br>
        <b>终局</b>：双方连续<b>停一手</b>（虚着）即进入计分。死子从棋盘上拿掉后，用<b>数子法</b>计分：你的活棋子数 + 围住的空点，<b>黑贴 7.5 目</b>（3 又 3/4 子）后多者胜。<br>
        计分阶段可<b>点击棋子标记/恢复死子</b>（YiQi 会自动标记，通常无需干预），确认后结算。<br>
        <b>人机模式</b>：可选 9 / 13 / 19 路棋盘，<b>我执黑先行 / 我执白后行</b>，难度分 <b>简单（20级）/ 中等（8级）/ 困难（1段）/ 专家（3段）</b> 四档。AI 由 KataGo 驱动，会像真实段位的棋手一样思考和停一手。<br>
        <b>双人模式</b>：两位玩家在同一设备上轮流落子。<br>
        键盘：<b>↑↓←→ / WASD</b> 移动光标，<b>空格 / 回车</b> 落子，<b>Z</b> 悔棋，<b>P</b> 停一手，<b>R</b> 重开。认输请点「认输」，判负并结束本局。
      </div>
      <div class="dlg-btns"><button class="btn-pill primary" data-cmd="ok">知道了</button></div>`);
  }

  showRecords(): void {
    const rowsOf = (bkt: Record<string, { w: number; l: number }>) =>
      (['easy', 'medium', 'hard', 'expert'] as Difficulty[]).map((k) => {
        const r = bkt[k] || { w: 0, l: 0 };
        const t = r.w + r.l;
        const rate = t ? Math.round((r.w / t) * 100) : 0;
        return `<div class="rec-row"><span>${DIFFICULTY_LABEL[k]}</span><span>${r.w} 胜 / ${r.l} 负</span><span class="rate">${rate}%</span></div>`;
      }).join('');
    this.openDialog(`
      <div class="dlg-icon">${ICO.trophy}</div>
      <div class="dlg-title">战绩统计</div>
      <div class="dlg-body">
        <div class="rec-head"><span>人机难度</span><span>战绩</span><span style="text-align:right">胜率</span></div>
        ${rowsOf(this.records)}
        <div style="margin-top:10px;font-size:12.5px">仅统计人机对战（执黑执白合并计数），双人模式不计入。</div>
      </div>
      <div class="dlg-btns"><button class="btn-pill primary" data-cmd="ok">知道了</button></div>`);
  }

  showClearConfirm(): void {
    this.openDialog(`
      <div class="dlg-icon">${ICO.trash}</div>
      <div class="dlg-title">清除记录</div>
      <div class="dlg-body">将清除本机保存的<b>全部人机对战战绩</b>与当前未完成的棋局，此操作不可恢复。</div>
      <div class="dlg-btns">
        <button class="btn-pill text" data-cmd="ok">取消</button>
        <button class="btn-pill primary" data-cmd="clear">清除</button>
      </div>`);
  }

  showPalette(): void {
    $('btnPalette').classList.add('active');
    const cur = document.documentElement.dataset.accent;
    const sw = Object.entries(ACCENTS).map(([k, c]) => `
      <button class="swatch ${k === cur ? 'sel' : ''}" data-accent="${k}" style="background:${c};color:${c}" title="${k}">
        ${k === cur ? '<svg class="ck" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.8l4.8 4.7L19.5 6.8"/></svg>' : ''}
      </button>`).join('');
    this.openDialog(`
      <div class="dlg-title" style="font-size:18px">选择配色</div>
      <div class="swatches">${sw}</div>`);
  }

  /* ================= 模型下载对话框 ================= */

  async showDownloadDialog(): Promise<void> {
    if (this.ai.ready) {
      this.toast('AI 模型已就绪');
      return;
    }
    // 每次打开都重新实测 WASM/WebGPU 能力（不沿用启动时的缓存结论）
    {
      const { wasmSupported, webgpuAvailable } = await import('../ai/modelFiles');
      this.wasmUnsupported = !(await wasmSupported());
      this.webgpuMissing = !(await webgpuAvailable());
    }
    if (this.wasmUnsupported) {
      this.openDialog(`
      <div class="dlg-icon">${ICO.chip}</div>
      <div class="dlg-title">无法启用 AI</div>
      <div class="dlg-body">当前浏览器不支持 <b>WebAssembly</b>，无法运行 KataGo 模型。<br>双人对战不受影响；换用近年版本的 Chrome / Edge / Firefox / Safari 即可启用人机对战。</div>
      <div class="dlg-btns">
        <button class="btn-pill primary" data-cmd="ok">知道了</button>
      </div>`);
      return;
    }
    if (this.webgpuMissing && !this.webgpuNoticeShown) {
      this.webgpuNoticeShown = true;
      this.openDialog(`
      <div class="dlg-icon"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z"/></svg></div>
      <div class="dlg-title">未检测到 WebGPU</div>
      <div class="dlg-body">当前浏览器没有可用的 WebGPU，AI 将以 <b>WASM 模式</b>运行：完全可用，但每手思考约需数秒（WebGPU 下更快）。<br><br>模型下载约 <b>103 MB</b>，是否继续？</div>
      <div class="dlg-btns">
        <button class="btn-pill text" data-cmd="skipdl">跳过</button>
        <button class="btn-pill primary" data-cmd="wg-continue">继续下载</button>
      </div>`);
      return;
    }
    this.openDialog(`
      <div class="dlg-icon">${ICO.chip}</div>
      <div class="dlg-title">下载 AI 模型</div>
      <div class="dlg-body">
        人机对战需要首次下载 KataGo 模型（人类模型 + 判断模型），共约 <b>103 MB</b>，下载后保存在浏览器中，长期复用。<br>
        不下载也可以正常使用<b>双人对战</b>。
      </div>
      <div class="dl-progress" id="dlProgress" style="display:none">
        <div class="dl-bar"><i id="dlBarFill"></i></div>
        <div class="dl-meta"><span id="dlPercent">0%</span><span id="dlSpeed"></span><span id="dlBytes"></span></div>
      </div>
      <div class="dlg-btns">
        <button class="btn-pill text" data-cmd="skipdl">跳过</button>
        <button class="btn-pill primary" data-cmd="startdl" id="btnStartDl">开始下载</button>
      </div>`);
  }

  async startDownload(): Promise<void> {
    const revision = this.dialogRevision;
    const prog = $('dlProgress');
    if (!prog) return;
    const percent = $('dlPercent'), speedLabel = $('dlSpeed'), bytes = $('dlBytes'), fill = $('dlBarFill');
    const btn = $('btnStartDl');
    prog.style.display = 'block';
    if (btn) { btn.style.display = 'none'; }
    const skipBtn = $('dialog').querySelector('[data-cmd="skipdl"]') as HTMLElement | null;
    if (skipBtn) skipBtn.textContent = '跳过';
    try {
      await this.ai.setup((received, total, speed) => {
        const pct = Math.min(99, Math.floor((received / total) * 100));
        percent.textContent = pct + '%';
        speedLabel.textContent = fmtSpeed(speed);
        bytes.textContent = `${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(0)} MB`;
        fill.style.width = pct + '%';
      });
      // 就绪：提示并关闭
      percent.textContent = '100%';
      speedLabel.textContent = '';
      bytes.textContent = '正在初始化 AI 引擎…';
      await new Promise((r) => setTimeout(r, 120));
      if (this.dialogRevision === revision) this.closeDialog();
      this.updateAILock();
      this.toast('AI 模型已就绪，开始人机对战吧');
      void this.maybeAI();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'canceled') return;
      console.error('[yiqi] 模型下载失败', err);
      bytes.textContent = '';
      speedLabel.textContent = '下载失败：' + msg;
      if (btn) {
        btn.style.display = '';
        btn.textContent = '重试';
      }
    }
  }

  skipDownload(): void {
    this.aiDownloadDismissed = true;
    this.closeDialog();
    // 跳过后 AI 不可用，留在人机模式会无法应答——直接切到双人对战
    if (this.mode.startsWith('ai-')) this.setMode('pvp', { toast: false });
    this.toast('已跳过：双人对战可用，AI 模型可在菜单中随时下载');
    this.updateAILock();
  }

  /** 切换模式（同步 chips/执子区 UI、开新对局）。 */
  setMode(mode: string, opts: { toast?: boolean } = {}): void {
    this.mode = mode;
    this.settings.mode = mode;
    this.saveSettings();
    document.querySelectorAll('#modes .chip').forEach((c) => c.classList.toggle('sel', (c as HTMLElement).dataset.mode === mode));
    $('sides').style.display = mode === 'pvp' ? 'none' : 'flex';
    this.newGame();
    if (opts.toast !== false) this.toast(mode === 'pvp' ? '双人对战开始' : '人机对战 · ' + $('modes').querySelector(`[data-mode="${mode}"]`)?.textContent?.trim());
  }

  /* ================= SGF 导出 ================= */

  exportSGF(): void {
    if (!this.game.moveNumber) {
      this.toast('当前没有棋谱可导出');
      return;
    }
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const result = this.over ? this.resultSGF : undefined;
    const sgf = this.game.toSGF({
      blackName: this.mode === 'pvp' ? '黑方' : (this.humanColor === BLACK ? '你' : `AI（${DIFFICULTY_LABEL[MODE_TO_DIFF[this.mode]]}）`),
      whiteName: this.mode === 'pvp' ? '白方' : (this.humanColor === WHITE ? '你' : `AI（${DIFFICULTY_LABEL[MODE_TO_DIFF[this.mode]]}）`),
      result,
      date,
    });
    try {
      const blob = new Blob([sgf], { type: 'application/x-go-sgf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `YiQi-${this.game.size}路-${date}.sgf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      this.toast('棋谱已导出（SGF）');
    } catch {
      this.toast('导出失败');
    }
  }

  /* ================= 初始化 ================= */

  init(): void {
    const preferLight = !window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = this.settings.theme || (preferLight ? 'light' : 'dark');
    document.documentElement.dataset.accent = ACCENTS[this.settings.accent] ? this.settings.accent : 'purple';
    this.renderer.refreshPalette();

    // 选项 chips 初始状态
    document.querySelectorAll('#modes .chip').forEach((c) => c.classList.toggle('sel', (c as HTMLElement).dataset.mode === this.mode));
    document.querySelectorAll('#sides .chip').forEach((c) => c.classList.toggle('sel', (c as HTMLElement).dataset.side === this.settings.side));
    document.querySelectorAll('#sizes .chip').forEach((c) => c.classList.toggle('sel', Number((c as HTMLElement).dataset.size) === this.settings.boardSize));
    $('sides').style.display = this.mode === 'pvp' ? 'none' : 'flex';
    this.updateSoundUI();
    this.updateCoordsUI();
    this.updateHUD();
    this.updateScoringUI();

    this.restoreSession();
    this.renderer.fitBoard();
    setTimeout(() => this.renderer.fitBoard(), 80);
    void this.bootstrapAI();
  }

  updateSoundUI(): void {
    const on = this.settings.sound;
    const icOn = $('icSoundOn'), icOff = $('icSoundOff'), txt = $('soundText');
    if (icOn && icOff && txt) {
      icOn.style.display = on ? 'block' : 'none';
      icOff.style.display = on ? 'none' : 'block';
      txt.textContent = '落子音效：' + (on ? '开' : '关');
    }
  }

  updateCoordsUI(): void {
    const txt = $('coordsText');
    if (txt) txt.textContent = '棋盘坐标：' + (this.settings.coords ? '开' : '关');
    this.renderer.showCoords = this.settings.coords;
    this.renderer.scheduleDraw();
  }
}

/* ================= 工具 ================= */

function snapToNN(game: GoGame) {
  return game.nnBoard();
}
function nnFromGrid(grid: number[][] | null, size: number) {
  if (!grid) return undefined;
  const out: (null | 'black' | 'white')[][] = [];
  for (let y = 0; y < size; y++) {
    const row: (null | 'black' | 'white')[] = [];
    for (let x = 0; x < size; x++) {
      const v = grid[y]?.[x] ?? 0;
      row.push(v === 1 ? 'black' : v === 2 ? 'white' : null);
    }
    out.push(row);
  }
  return out;
}
function trimNum(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
function fmtSpeed(bps: number): string {
  if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
  return Math.round(bps / 1024) + ' KB/s';
}
function illegalMessage(code: string): string {
  if (code === 'occupied') return '此处已有棋子';
  if (code === 'suicide') return '禁着点：落子后无气（自杀）';
  if (code === 'ko' || code === 'superko') return '禁着点：全局同形（打劫需先寻劫）';
  if (code === 'out_of_bounds') return '落点超出棋盘';
  return '此处不可落子';
}

const ICO = {
  help: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.6"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.9.6c0 1.6-2.3 2-2.3 3.5M12.1 16.8h.01"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 16.5V21M7 4h10v4.5a5 5 0 0 1-10 0z"/><path d="M7 5.5H4.6a2 2 0 0 0 2 3.7H7M17 5.5h2.4a2 2 0 0 1-2 3.7H17"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.5h15M9.5 6V4.5h5V6M6.5 6.5l.9 13.5h9.2l.9-13.5M10 10.5v6M14 10.5v6"/></svg>',
  crown: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17.5 3 8l5 3.5L12 5l4 6.5L21 8l-1 9.5z"/><path d="M5 21h14"/></svg>',
  flag: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h13l-2.5 4L18 12H5"/></svg>',
  handshake: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="9" r="3.2"/><circle cx="15.5" cy="9" r="3.2"/><path d="M3.5 20c.6-3 2.6-4.5 5-4.5s4.4 1.5 5 4.5M10.5 20c.6-3 2.6-4.5 5-4.5s4.4 1.5 5 4.5"/></svg>',
  chip: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="3"/><rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1.2"/><path d="M9 2.8v2.2M15 2.8v2.2M9 19v2.2M15 19v2.2M2.8 9h2.2M2.8 15h2.2M19 9h2.2M19 15h2.2"/></svg>',
};

export { App };
