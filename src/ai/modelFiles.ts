/**
 * KataGo 模型文件管理（见 围棋AI选型.md）。
 *
 * - 主网络：g170-b6c96（3.65 MiB，仓库 public/ai/ 内静态文件，判断停一手/胜负）
 * - 人类网络：b18c384nbt-humanv0（94.5 MiB，仓库内分片为 4 个 ~24 MiB 文件，
 *   以规避 Cloudflare Pages 单文件 25 MiB 上限）。前端下载时逐片拉取、
 *   拼接为 Blob URL 交给引擎 Worker（fetch 支持 blob: URL，引擎层零改动）。
 *
 * 下载结果写入 Cache Storage（'yiqi-models-v1'），长期复用、二次打开零下载。
 */
import pako from 'pako';
import { loadModelFile } from './modelCache';
import type { KataGoBackendPreference } from './types';

export const MAIN_MODEL_PATH = 'ai/g170-b6c96-s175395328-d26788732.bin.gz';
export const HUMAN_MODEL_SHARDS = [
  'ai/b18c384nbt-humanv0.bin.gz.00',
  'ai/b18c384nbt-humanv0.bin.gz.01',
  'ai/b18c384nbt-humanv0.bin.gz.02',
  'ai/b18c384nbt-humanv0.bin.gz.03',
];
export const HUMAN_MODEL_TOTAL_BYTES = 99066230; // 94.5 MiB（gzip 下载总体积 = 四分片之和）
export const MAIN_MODEL_TOTAL_BYTES = 3827339; // 3.65 MiB
export const TOTAL_DOWNLOAD_BYTES = HUMAN_MODEL_TOTAL_BYTES + MAIN_MODEL_TOTAL_BYTES;
export const HUMAN_MODEL_RAW_BYTES = 107185997; // 常驻内存 102.2 MiB（解压后）
export const MAIN_MODEL_RAW_BYTES = 4124446;
/** 各分片的磁盘字节数（split -b 切片）：传输完整性校验用。 */
export const HUMAN_SHARD_BYTES = [25165824, 25165824, 25165824, 23568758] as const;

const CACHE_NAME = 'yiqi-models-v2';

export type DownloadProgress = {
  receivedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
};

function withBase(path: string): string {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
  return base + path;
}

async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/** 四个人类网络分片 + 主网络是否都已在缓存中。 */
export async function modelsCached(): Promise<boolean> {
  const cache = await openCache();
  if (!cache) return false;
  try {
    for (const path of HUMAN_MODEL_SHARDS) {
      if (!(await cache.match(withBase(path)))) return false;
    }
    if (!(await cache.match(withBase(MAIN_MODEL_PATH)))) return false;
    return true;
  } catch {
    return false;
  }
}

type ProgressCb = (p: DownloadProgress) => void;

export type ModelPrepareResult = {
  /** 人类网络 Blob URL（标识字符串，供 Worker 侧缓存键；首请求以 buffer 零拷贝传输）。 */
  humanModelUrl: string;
  /** 人类网络原始字节（一次性 transfer 用）。 */
  humanBlob: Blob;
  /** 主网络 Blob URL（缓存或下载所得字节，Worker 无需重复下载）。 */
  mainModelUrl: string;
};

/**
 * 确保两个模型就绪：优先读缓存，缺哪个下哪个，进度统一汇报。
 * 完成后主网络写入缓存；人类网络分片按片写入缓存，Blob 每次启动时重建。
 */
export async function prepareModels(
  onProgress: ProgressCb,
  signal?: AbortSignal
): Promise<ModelPrepareResult> {
  const cache = await openCache();
  const started = Date.now();
  const counters = { human: 0, main: 0 };
  const report = () => {
    const received = counters.human + counters.main;
    const elapsed = Math.max(0.001, (Date.now() - started) / 1000);
    onProgress({
      receivedBytes: received,
      totalBytes: TOTAL_DOWNLOAD_BYTES,
      bytesPerSecond: received / elapsed,
    });
  };

  // 1) 人类网络：逐分片（缓存优先）。分片是同一个 gzip 流的连续字节切片（split -b），
  //    必须按序拼接成完整 gzip 后再一次性解压。分片尺寸按磁盘字节数严格校验，
  //    防止传输层二次压缩/截断造成的静默损坏。
  const shardBlobs: Blob[] = [];
  for (let i = 0; i < HUMAN_MODEL_SHARDS.length; i++) {
    const shard = HUMAN_MODEL_SHARDS[i]!;
    const expected = HUMAN_SHARD_BYTES[i]!;
    const blob = await loadModelFile(cache, withBase(shard), expected, (got) => {
      counters.human += got;
      report();
    }, signal);
    shardBlobs.push(blob);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
  // 拼接完整 gzip 并解压为原始模型字节
  const humanGzip = new Blob(shardBlobs, { type: 'application/gzip' });
  let humanRaw: Blob;
  try {
    humanRaw = await gunzipBlob(humanGzip);
    if (humanRaw.size !== HUMAN_MODEL_RAW_BYTES) {
      throw new Error(`人类网络解压结果异常：${humanRaw.size}B，期望 ${HUMAN_MODEL_RAW_BYTES}B`);
    }
  } catch (err) {
    // 同尺寸损坏也可能通过长度校验；清除全部分片，确保下一次重试可以自愈。
    if (cache) await Promise.all(HUMAN_MODEL_SHARDS.map(async (path) => {
      try { await cache.delete(withBase(path)); } catch { /* ignore */ }
    }));
    throw err;
  }
  signal?.throwIfAborted();

  // 无缓存/写缓存失败时也必须下载并使用主网络，而非让 Worker 再 fetch 静态路径。
  const mainBlob = await loadModelFile(cache, withBase(MAIN_MODEL_PATH), MAIN_MODEL_TOTAL_BYTES, (got) => {
    counters.main += got;
    report();
  }, signal);
  signal?.throwIfAborted();
  const humanModelUrl = URL.createObjectURL(humanRaw);
  try {
    return { humanModelUrl, humanBlob: humanRaw, mainModelUrl: URL.createObjectURL(mainBlob) };
  } catch (err) {
    revokeModelUrl(humanModelUrl);
    throw err;
  }
}

/** 优先使用浏览器流式解压；旧浏览器回退到同步 pako。 */
async function gunzipBlob(blob: Blob): Promise<Blob> {
  if (typeof DecompressionStream !== 'undefined') {
    return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
  }
  const raw = pako.ungzip(new Uint8Array(await blob.arrayBuffer()));
  return new Blob([raw], { type: 'application/octet-stream' });
}

/** 释放 Blob URL。 */
export function revokeModelUrl(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch { /* ignore */ }
}

/** 检测 WebGPU 可用性（决定下载弹窗里的提示文案）。 */
export async function preferredBackend(): Promise<KataGoBackendPreference> {
  try {
    const adapter = await (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter();
    return adapter ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

/** 浏览器是否支持 WebAssembly（含微型模块编译探测）。不支持的浏览器无法运行 tfjs WASM 后端。每次调用都实测。 */
export async function wasmSupported(): Promise<boolean> {
  try {
    if (typeof WebAssembly !== 'object') return false;
    // 最小合法 wasm 模块（仅 magic+version 头）
    await WebAssembly.instantiate(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    return true;
  } catch {
    return false;
  }
}

/** 浏览器是否提供可用的 WebGPU 适配器（仅影响速度，不影响可用性）。每次调用都实测。 */
export async function webgpuAvailable(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return gpu ? !!(await gpu.requestAdapter()) : false;
  } catch {
    return false;
  }
}
