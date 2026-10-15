/** 缓存只是加速手段：读取失败或损坏时重新下载，校验成功后才写入。 */
export async function loadModelFile(
  cache: Cache | null,
  url: string,
  expectedBytes: number,
  onChunk: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        const blob = await hit.blob();
        signal?.throwIfAborted();
        if (blob.size === expectedBytes) {
          onChunk(blob.size);
          return blob;
        }
        await cache.delete(url);
      }
    } catch {
      signal?.throwIfAborted();
      // 隐私模式/缓存存储损坏不应阻止游戏。
    }
  }
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}（${url}）`);
  let blob: Blob;
  if (!response.body) {
    blob = await response.blob();
    onChunk(blob.size);
  } else {
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > expectedBytes) throw new Error(`模型体积超出预期：${url}`);
        parts.push(value);
        onChunk(value.byteLength);
      }
    } catch (err) {
      try { await reader.cancel(); } catch { /* 保留原始错误 */ }
      throw err;
    } finally {
      reader.releaseLock();
    }
    blob = new Blob(parts as BlobPart[], { type: 'application/octet-stream' });
  }
  signal?.throwIfAborted();
  if (blob.size !== expectedBytes) {
    throw new Error(`模型体积异常：${blob.size}B，期望 ${expectedBytes}B（${url}）`);
  }
  if (cache) {
    try {
      await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } }));
    } catch { /* 配额不足时仍使用本次下载结果 */ }
  }
  signal?.throwIfAborted();
  return blob;
}
