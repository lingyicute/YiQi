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

/** 带进度的分片下载（ReadableStream 计速），返回合并后的完整 gzip Blob。 */
async function fetchWithProgress(
  url: string,
  expectedBytes: number | null,
  onChunk: (got: number) => void,
  signal?: AbortSignal
): Promise<Blob> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}（${url}）`);
  if (!res.body) {
    const blob = await res.blob();
    onChunk(blob.size);
    return blob;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      parts.push(value);
      onChunk(value.byteLength);
    }
  }
  const blob = new Blob(parts as BlobPart[], { type: 'application/octet-stream' });
  if (expectedBytes && Math.abs(blob.size - expectedBytes) > 4096) {
    // 部分服务器会再做一层传输压缩（fetch 自动解压），此时体积与磁盘文件不同——只提示不失败
    console.info(`[yiqi] ${url} 传输体积 ${blob.size}B（磁盘 ${expectedBytes}B），可能经过传输层解压`);
  }
  return blob;
}

export type ModelPrepareResult = {
  /** 人类网络 Blob URL（标识字符串，供 Worker 侧缓存键；首请求以 buffer 零拷贝传输）。 */
  humanModelUrl: string;
  /** 人类网络原始字节（一次性 transfer 用）。 */
  humanBlob: Blob;
  /** 主网络 URL（静态路径，Worker 直接 fetch）。 */
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
    let blob: Blob | null = null;
    if (cache) {
      const hit = await cache.match(withBase(shard));
      if (hit) blob = await hit.blob();
    }
    if (!blob) {
      blob = await fetchWithProgress(withBase(shard), expected, (got) => {
        counters.human += got;
        report();
      }, signal);
      if (cache) {
        try {
          await cache.put(withBase(shard), new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } }));
        } catch { /* 容量不足等情况忽略，缓存只是加速手段 */ }
      }
    } else {
      counters.human += blob.size;
      report();
    }
    if (Math.abs(blob.size - expected) > 1024) {
      throw new Error(`分片 ${shard.split('/').pop()} 体积异常：${blob.size}B，期望 ${expected}B（可能被传输层重新压缩或截断，请刷新重试）`);
    }
    console.info(`[yiqi] 分片 ${shard.split('/').pop()} 就绪：${blob.size}B`);
    shardBlobs.push(blob);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
  // 拼接完整 gzip 并解压为原始模型字节
  const humanGzip = new Blob(shardBlobs, { type: 'application/gzip' });
  const humanRaw = await gunzipBlob(humanGzip);
  if (Math.abs(humanRaw.size - HUMAN_MODEL_RAW_BYTES) > 1024) {
    throw new Error(`人类网络解压结果异常：${humanRaw.size}B，期望 ${HUMAN_MODEL_RAW_BYTES}B`);
  }

  // 2) 主网络：缓存优先，否则下载并写缓存（保持 gzip；引擎 Worker 自带 maybeUngzip）
  if (cache && !(await cache.match(withBase(MAIN_MODEL_PATH)))) {
    const blob = await fetchWithProgress(withBase(MAIN_MODEL_PATH), MAIN_MODEL_TOTAL_BYTES, (got) => {
      counters.main += got;
      report();
    }, signal);
    if (Math.abs(blob.size - MAIN_MODEL_TOTAL_BYTES) > 1024) {
      throw new Error(`主网络模型体积异常：${blob.size}B，期望 ${MAIN_MODEL_TOTAL_BYTES}B`);
    }
    try {
      await cache.put(withBase(MAIN_MODEL_PATH), new Response(blob, { headers: { 'Content-Type': 'application/gzip' } }));
    } catch { /* ignore */ }
  } else if (cache) {
    const hit = await cache.match(withBase(MAIN_MODEL_PATH));
    counters.main += (await hit?.blob())?.size ?? MAIN_MODEL_TOTAL_BYTES;
    report();
  }

  return {
    humanModelUrl: URL.createObjectURL(humanRaw),
    humanBlob: humanRaw,
    mainModelUrl: withBase(MAIN_MODEL_PATH),
  };
}

/** 解压 gzip Blob（分块流式，避免阻塞 UI）；结果非 gzip 时原样返回。 */
async function gunzipBlob(blob: Blob): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x1f || head[1] !== 0x8b) return blob;
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
