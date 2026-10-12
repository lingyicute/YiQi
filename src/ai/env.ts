/**
 * Small environment helpers the vendored engine imports. Sourced from
 * web-katrain's utils (MIT).
 */

export function publicUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const trimmedPath = path.startsWith('/') ? path.slice(1) : path;
  return `${normalizedBase}${trimmedPath}`;
}

export type AnimationFrameHandle =
  | { kind: 'raf'; id: number }
  | { kind: 'timeout'; id: ReturnType<typeof setTimeout> };

type AnimationFrameApi = {
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
};

export function getAnimationFrameApi(): AnimationFrameApi | null {
  try {
    const request = globalThis.requestAnimationFrame;
    const cancel = globalThis.cancelAnimationFrame;
    if (typeof request !== 'function' || typeof cancel !== 'function') return null;
    return {
      request: request.bind(globalThis),
      cancel: cancel.bind(globalThis),
    };
  } catch {
    return null;
  }
}

export function getAnimationNow(): number {
  try {
    const now = globalThis.performance?.now;
    if (typeof now === 'function') return now.call(globalThis.performance);
  } catch {
    // Fall back below.
  }
  return Date.now();
}

export const getWorkerConstructor = (): typeof Worker | null => {
  try {
    const workerConstructor = globalThis.Worker;
    return typeof workerConstructor === 'function' ? workerConstructor : null;
  } catch {
    return null;
  }
};

/** How many WASM threads the search may take (cores minus headroom for the UI). */
export const MAX_SEARCH_THREADS = 8;
export const CORES_RESERVED_FOR_UI = 2;
export const LOW_MEMORY_GB = 4;
export const LOW_MEMORY_MAX_THREADS = 2;

export type ThreadBudgetInput = {
  hardwareConcurrency?: number;
  deviceMemoryGB?: number;
};

export function resolveSearchThreadCount({ hardwareConcurrency, deviceMemoryGB }: ThreadBudgetInput): number {
  const cores = Number(hardwareConcurrency);
  const usableCores = Number.isFinite(cores) && cores >= 1 ? Math.floor(cores) : 1;
  const memory = Number(deviceMemoryGB);
  const knownMemory = Number.isFinite(memory) && memory > 0 ? memory : null;
  const ceiling = knownMemory !== null && knownMemory < LOW_MEMORY_GB ? LOW_MEMORY_MAX_THREADS : MAX_SEARCH_THREADS;
  return Math.max(1, Math.min(ceiling, usableCores - CORES_RESERVED_FOR_UI));
}

/** Reads the signals a worker actually has: no window, no matchMedia. */
export function detectSearchThreadCount(
  scope: { navigator?: { hardwareConcurrency?: number; deviceMemory?: number } } = globalThis as never,
): number {
  return resolveSearchThreadCount({
    hardwareConcurrency: scope.navigator?.hardwareConcurrency,
    deviceMemoryGB: scope.navigator?.deviceMemory,
  });
}
