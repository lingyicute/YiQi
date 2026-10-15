/** Serve the existing production build and run browser checks sequentially. */
import { spawn } from 'node:child_process';
import { preview } from 'vite';

const server = process.env.BASE_URL ? null : await preview({ preview: { port: 4173, strictPort: true } });
try {
  for (const script of ['e2e.mjs', 'e2e-regressions.mjs', 'e2e-model-cache.mjs', 'e2e-ai.mjs']) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [`tests/${script}`], { stdio: 'inherit', env: process.env });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${script}: ${signal ?? code}`)));
    });
  }
} finally {
  if (server) await new Promise((resolve, reject) => server.httpServer.close(err => err ? reject(err) : resolve()));
}
