import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createApp } from './server/app.ts';
import { initializeAuth, SESSION_IDLE_TIMEOUT_MS } from './server/auth.ts';
import { config } from './server/config.ts';
import { initializeDatabase, removeExpiredSessions } from './server/db/index.ts';
import { initializeFeaturedDemo, startPrivateAnalysisEviction } from './server/repoStore.ts';

export async function startServer(): Promise<void> {
  initializeDatabase();
  await initializeAuth();
  removeExpiredSessions(Date.now(), SESSION_IDLE_TIMEOUT_MS);
  initializeFeaturedDemo();
  startPrivateAnalysisEviction();

  const app = createApp();
  if (config.nodeEnv !== 'production') {
    process.env.EXPRESS_EMBEDDED = '1';
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Codebase Tutor listening on http://localhost:${config.port}`);
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  void startServer().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'Unknown startup error.';
    console.error(`Failed to start server: ${message}`);
    process.exitCode = 1;
  });
}
