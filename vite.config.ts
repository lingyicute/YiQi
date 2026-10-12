import { defineConfig, type Plugin } from 'vite';

/**
 * 模型分片是二进制权重，绝不能再被传输层压缩：
 * vite preview 会按体积压缩响应且沿用原 Content-Length，造成截断损坏。
 * 显式声明 octet-stream + identity，压缩中间件就会跳过。
 */
function modelContentType(): Plugin {
  const handler = (req: { url?: string }, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    const path = (req.url || '').split('?')[0]!;
    if (path.startsWith('/ai/')) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Encoding', 'identity');
    }
    next();
  };
  return {
    name: 'yiqi-model-content-type',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [modelContentType()],
  base: '/',
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    // 与生产（Cloudflare Pages `_headers`）一致：跨域隔离，启用 SharedArrayBuffer
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4200,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('@tensorflow')) return 'tfjs';
          if (id.includes('goban-engine') || id.includes('eventemitter3')) return 'rules';
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
