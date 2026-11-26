import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  clearRepositoryCache,
  getAnalyzedRepo,
  getRepositoryRecord,
  listRepositories,
  PONYTAIL_REPO_URL,
  startRepositoryAnalysis,
} from './repoStore.ts';
import { verifyGitHubToken } from './github.ts';
import {
  generateGroundedExplanation,
  generateSpeechAudio,
  isServerGeminiKeyRejected,
  verifyGeminiApiKey,
} from './gemini.ts';
import { config } from './config.ts';
import {
  consumeGeminiDailyQuota,
  createSession,
  deleteSession,
  findUserByEmail,
  getSessionUser,
  insertUser,
  type StoredUser,
} from './db/index.ts';
import type { ChatContext, DiagramType, UserProfile } from '../src/types/codebase.ts';

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password: string, salt: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: config.jsonBodyLimitBytes }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('Origin');
    if (!origin) {
      next();
      return;
    }
    if (!config.allowedOrigins.includes(origin)) {
      if (req.path === '/api' || req.path.startsWith('/api/')) {
        res.status(403).json({ error: 'Origin is not allowed.' });
        return;
      }
      next();
      return;
    }

    res.vary('Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-Gemini-Api-Key, X-Gemini-Model, X-Github-Token'
    );
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  function getRequestUser(req: Request): UserProfile | undefined {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    return token ? getSessionUser(token) : undefined;
  }

  function requireUser(req: Request, res: Response): UserProfile | undefined {
    const user = getRequestUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in is required for this feature.' });
      return undefined;
    }
    return user;
  }

  function reserveServerKeyRequest(userId: string, apiKeyOverride?: string): boolean {
    if (apiKeyOverride?.trim() || !config.allowServerKey) return true;
    const today = new Date().toISOString().slice(0, 10);
    return consumeGeminiDailyQuota(userId, today, config.serverKeyDailyCap);
  }

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'codebase-tutor' });
});

// Auth routes
app.post('/api/auth/signup', (req: Request, res: Response) => {
  const { name, email, password, role } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    role?: string;
  };
  const cleanEmail = (email ?? '').trim().toLowerCase();
  const cleanName = (name ?? '').trim();
  if (!cleanName || !cleanEmail || !password || password.length < 6) {
    res.status(400).json({ error: 'Name, valid email, and a password of at least 6 characters are required.' });
    return;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const user: StoredUser = {
    id: crypto.randomUUID(),
    name: cleanName,
    email: cleanEmail,
    role: (role ?? 'Student / Developer').trim(),
    salt,
    passwordHash: hashPassword(password, salt),
  };
  if (!insertUser(user)) {
    res.status(409).json({ error: 'An account with that email already exists.' });
    return;
  }

  const token = crypto.randomBytes(config.sessionTokenBytes).toString('hex');
  const profile: UserProfile = { id: user.id, name: user.name, email: user.email, role: user.role };
  createSession(token, user.id, Date.now() + config.sessionTtlMs);
  res.status(201).json({ token, user: profile });
});

app.post('/api/auth/login', (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  const cleanEmail = (email ?? '').trim().toLowerCase();
  const user = findUserByEmail(cleanEmail);
  if (!user || !password || !verifyPassword(password, user.salt, user.passwordHash)) {
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }
  const token = crypto.randomBytes(config.sessionTokenBytes).toString('hex');
  const profile: UserProfile = { id: user.id, name: user.name, email: user.email, role: user.role };
  createSession(token, user.id, Date.now() + config.sessionTtlMs);
  res.json({ token, user: profile });
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  const user = getRequestUser(req);
  if (!user) {
    res.status(401).json({ error: 'Not signed in.' });
    return;
  }
  res.json({ user });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token) deleteSession(token);
  res.json({ ok: true });
});

// Repositories API
app.get('/api/repositories', (req: Request, res: Response) => {
  const user = getRequestUser(req);
  res.json({
    repositories: listRepositories(user?.id),
    featuredDemoUrl: PONYTAIL_REPO_URL,
  });
});

// Settings status & credential verification (never returns server secrets)
app.get('/api/settings/status', (req: Request, res: Response) => {
  if (!requireUser(req, res)) return;
  const geminiKey = config.geminiApiKey ?? '';
  const githubTok = config.githubToken ?? '';
  res.json({
    hasServerGeminiKey:
      config.allowServerKey && Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY') && !isServerGeminiKeyRejected(),
    serverGeminiRejected: isServerGeminiKeyRejected(),
    hasServerGithubToken: Boolean(githubTok),
  });
});

app.post('/api/settings/verify', async (req: Request, res: Response) => {
  if (!requireUser(req, res)) return;
  const body = (req.body ?? {}) as {
    geminiApiKey?: string;
    geminiModel?: string;
    githubToken?: string;
  };
  const geminiKey = (body.geminiApiKey ?? req.header('x-gemini-api-key') ?? '').trim();
  const geminiModel = (body.geminiModel ?? req.header('x-gemini-model') ?? '').trim();
  const githubToken = (body.githubToken ?? req.header('x-github-token') ?? '').trim();

  const result: {
    gemini?: { valid: boolean; model: string; error?: string };
    github?: { valid: boolean; username?: string; remaining?: number; limit?: number; error?: string };
  } = {};

  if (geminiKey) {
    result.gemini = await verifyGeminiApiKey(geminiKey, geminiModel || undefined);
  }
  if (githubToken) {
    result.github = await verifyGitHubToken(githubToken);
  }

  res.json(result);
});

app.post('/api/repositories/analyze', async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { url, forceRefresh } = req.body as { url?: string; forceRefresh?: boolean };
  const githubToken = req.header('x-github-token')?.trim() || undefined;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'Repository URL is required.' });
    return;
  }
  try {
    const record = await startRepositoryAnalysis(url, {
      forceRefresh: Boolean(forceRefresh),
      githubToken,
      userId: user.id,
    });
    res.json({ repository: record });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Invalid repository URL.',
    });
  }
});

app.get('/api/repositories/:id/analysis', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const user = getRequestUser(req);
  const record = getRepositoryRecord(id, user?.id);
  if (!record) {
    res.status(404).json({ error: 'Repository not found. Please import it first.' });
    return;
  }
  res.json({ repository: record });
});

app.get('/api/repositories/:id/files', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const user = getRequestUser(req);
  const data = getAnalyzedRepo(id, user?.id);
  if (!data) {
    res.status(404).json({ error: 'Repository analysis is not ready yet.' });
    return;
  }
  res.json({
    tree: data.analysis.fileTree,
    files: data.analysis.filesMeta,
  });
});

app.get('/api/repositories/:id/files/content', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const filePath = String(req.query.path ?? '');
  const user = getRequestUser(req);
  const data = getAnalyzedRepo(id, user?.id);
  if (!data) {
    res.status(404).json({ error: 'Repository analysis is not ready yet.' });
    return;
  }
  const fileMeta = data.analysis.filesMeta.find((f) => f.path === filePath);
  if (!fileMeta) {
    res.status(404).json({ error: `File "${filePath}" not found in repository.` });
    return;
  }

  const content = data.analysis.fileContents[filePath] ?? '// Binary or asset file (content preview omitted)';
  const symbols = data.analysis.symbols.filter((s) => s.file_path === filePath);
  const fileNodeId = `file:${filePath}`;

  const incomingDependencies = data.graph.edges
    .filter((e) => e.target === fileNodeId && e.relationship === 'imports')
    .map((e) => ({
      file_path: e.source.replace(/^file:/, ''),
      relationship: e.relationship,
      line: e.evidence?.start_line,
    }));

  const outgoingDependencies = data.graph.edges
    .filter((e) => e.source === fileNodeId && (e.relationship === 'imports' || e.relationship === 'uses'))
    .map((e) => ({
      file_path: e.target.replace(/^file:/, '').replace(/^ext:/, 'pkg:'),
      relationship: e.relationship,
      line: e.evidence?.start_line,
    }));

  res.json({
    file: fileMeta,
    content,
    symbols,
    incomingDependencies,
    outgoingDependencies,
  });
});

app.get('/api/repositories/:id/trace', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const rawQuery = String(req.query.q ?? '').trim();
  const preferredFile = String(req.query.preferredFile ?? '').trim();
  const user = getRequestUser(req);
  const data = getAnalyzedRepo(id, user?.id);
  if (!data) {
    res.status(404).json({ error: 'Repository analysis is not ready yet.' });
    return;
  }
  if (!rawQuery || rawQuery.length < 2) {
    res.json({ match: null });
    return;
  }

  const clean = rawQuery.replace(/^['"]|['"]$/g, '').replace(/\([^)]*\)$/, '').trim();
  const baseIdent = clean.includes('.') ? clean.split('.').pop()!.trim() : clean;
  const needles = Array.from(new Set([clean, baseIdent].filter((n) => n.length >= 2)));

  // 1. Check extracted symbols first
  const matchingSymbols = data.analysis.symbols.filter((s) =>
    needles.some((n) => s.name === n || s.name.toLowerCase() === n.toLowerCase())
  );
  if (matchingSymbols.length > 0) {
    const picked =
      matchingSymbols.find((s) => preferredFile && s.file_path === preferredFile) ||
      matchingSymbols.find((s) => needles.includes(s.name)) ||
      matchingSymbols[0];
    res.json({
      match: {
        file_path: picked.file_path,
        start_line: picked.start_line,
        end_line: picked.end_line,
        symbol_id: picked.id,
      },
    });
    return;
  }

  // 2. Search file contents (prioritize preferredFile; rank exact decl > case-insensitive decl > non-import ref > filename match > import ref)
  const orderedFiles = [...data.analysis.filesMeta]
    .filter((f) => f.role !== 'asset')
    .sort((a, b) => {
      if (a.path === preferredFile) return -1;
      if (b.path === preferredFile) return 1;
      return 0;
    });

  let ciDeclMatch: { file_path: string; start_line: number; end_line: number } | null = null;
  let nonImportMatch: { file_path: string; start_line: number; end_line: number } | null = null;
  let fallbackMatch: { file_path: string; start_line: number; end_line: number } | null = null;

  const isImportLine = (line: string) => /^\s*(?:import|from|require\s*\()/.test(line);

  for (const needle of needles) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isWord = /^[A-Za-z0-9_$-]+$/.test(needle);
    const declPattern = `\\b(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:function|const|let|var|type|interface|class|enum|def|app\\.(?:get|post|put|delete))\\s+${escaped}\\b`;
    const exactDeclRe = isWord ? new RegExp(declPattern) : null;
    const ciDeclRe = isWord ? new RegExp(declPattern, 'i') : null;
    const wordRe = isWord ? new RegExp(`\\b${escaped}\\b`) : null;
    const ciWordRe = isWord ? new RegExp(`\\b${escaped}\\b`, 'i') : null;

    for (const meta of orderedFiles) {
      const text = data.analysis.fileContents[meta.path];
      if (!text) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (exactDeclRe && exactDeclRe.test(line)) {
          res.json({
            match: {
              file_path: meta.path,
              start_line: i + 1,
              end_line: Math.min(lines.length, i + 15),
            },
          });
          return;
        }
        if (!ciDeclMatch && ciDeclRe && ciDeclRe.test(line)) {
          ciDeclMatch = {
            file_path: meta.path,
            start_line: i + 1,
            end_line: Math.min(lines.length, i + 15),
          };
        }
        if (!nonImportMatch && !isImportLine(line) && (wordRe ? wordRe.test(line) : line.includes(needle))) {
          nonImportMatch = {
            file_path: meta.path,
            start_line: i + 1,
            end_line: i + 1,
          };
        }
        if (!fallbackMatch && (ciWordRe ? ciWordRe.test(line) : line.toLowerCase().includes(needle.toLowerCase()))) {
          fallbackMatch = {
            file_path: meta.path,
            start_line: i + 1,
            end_line: i + 1,
          };
        }
      }
    }
  }

  const stemMatch = orderedFiles.find(
    (f) => f.name.replace(/\.[^.]+$/, '').toLowerCase() === clean.toLowerCase()
  );

  res.json({
    match:
      ciDeclMatch ??
      nonImportMatch ??
      (stemMatch ? { file_path: stemMatch.path, start_line: 1, end_line: Math.min(30, stemMatch.lineCount || 30) } : null) ??
      fallbackMatch,
  });
});

app.get('/api/repositories/:id/graph', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const user = getRequestUser(req);
  const data = getAnalyzedRepo(id, user?.id);
  if (!data) {
    res.status(404).json({ error: 'Repository analysis is not ready yet.' });
    return;
  }
  res.json({ graph: data.graph });
});

app.get('/api/repositories/:id/diagrams', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const user = getRequestUser(req);
  const data = getAnalyzedRepo(id, user?.id);
  if (!data) {
    res.status(404).json({ error: 'Repository analysis is not ready yet.' });
    return;
  }
  const list = Object.values(data.diagrams).map((d) => ({
    id: d.id,
    type: d.type,
    title: d.title,
    subtitle: d.subtitle,
    available: d.available,
    availabilityNote: d.availabilityNote,
    summary: d.summary,
    nodeCount: d.nodes.length,
    edgeCount: d.edges.length,
  }));
  res.json({ diagrams: list });
});

app.get('/api/repositories/:id/diagrams/:type', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const type = String(req.params.type) as DiagramType;
  const user = getRequestUser(req);
  const data = getAnalyzedRepo(id, user?.id);
  if (!data) {
    res.status(404).json({ error: 'Repository analysis is not ready yet.' });
    return;
  }
  const diagram = data.diagrams[type];
  if (!diagram) {
    res.status(404).json({ error: `Unknown diagram type "${type}".` });
    return;
  }
  res.json({ diagram });
});

app.get('/api/repositories/:id/diagrams/:type/nodes/:nodeId', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const type = String(req.params.type) as DiagramType;
  const nodeId = decodeURIComponent(String(req.params.nodeId));
  const user = getRequestUser(req);
  const data = getAnalyzedRepo(id, user?.id);
  if (!data) {
    res.status(404).json({ error: 'Repository analysis is not ready yet.' });
    return;
  }
  const diagram = data.diagrams[type];
  const node = diagram?.nodes.find((n) => n.id === nodeId || n.graphNodeId === nodeId);
  if (!node) {
    res.status(404).json({ error: 'Node not found in diagram.' });
    return;
  }

  const incoming = diagram.edges.filter((e) => e.target === node.id);
  const outgoing = diagram.edges.filter((e) => e.source === node.id);
  const symbols = (node.childSymbolIds ?? [])
    .map((sid) => data.analysis.symbols.find((s) => s.id === sid))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  res.json({
    node,
    incoming,
    outgoing,
    symbols,
  });
});

app.post('/api/repositories/:id/chat', async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) return;
  const id = String(req.params.id);
  const { question, context, history } = req.body as {
    question?: string;
    context?: ChatContext;
    history?: { role: 'user' | 'assistant'; content: string }[];
  };

  if (!question || typeof question !== 'string' || !question.trim()) {
    res.status(400).json({ error: 'Question cannot be empty.' });
    return;
  }

  const data = getAnalyzedRepo(id, user.id);
  if (!data) {
    res.status(404).json({ error: 'Repository is not analyzed yet. Wait for analysis to finish before asking questions.' });
    return;
  }

  const apiKeyOverride = req.header('x-gemini-api-key')?.trim() || undefined;
  const modelOverride = req.header('x-gemini-model')?.trim() || undefined;
  if (!reserveServerKeyRequest(user.id, apiKeyOverride)) {
    res.status(429).json({ error: 'The server Gemini daily request limit has been reached. Try again tomorrow or use your own key.' });
    return;
  }

  try {
    const result = await generateGroundedExplanation(
      data,
      question.trim(),
      context ?? {},
      Array.isArray(history) ? history : [],
      { apiKeyOverride, modelOverride }
    );
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate explanation.';
    const status = message.includes('GEMINI_API_KEY') ? 503 : 500;
    res.status(status).json({ error: message });
  }
});

app.post('/api/tts', async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { text } = req.body as { text?: string };
  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'Text is required for speech synthesis.' });
    return;
  }

  const apiKeyOverride = req.header('x-gemini-api-key')?.trim() || undefined;
  if (!reserveServerKeyRequest(user.id, apiKeyOverride)) {
    res.status(429).json({ error: 'The server Gemini daily request limit has been reached. Try again tomorrow or use your own key.' });
    return;
  }
  try {
    const audio = await generateSpeechAudio(text, { apiKeyOverride });
    res.json(audio);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to synthesize speech.';
    const status = message.includes('GEMINI_API_KEY') ? 503 : 500;
    res.status(status).json({ error: message });
  }
});

app.post('/api/cache/clear', (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) return;
  const cleared = clearRepositoryCache(user.id);
  res.json({ cleared });
});

// Ensure unmatched /api routes ALWAYS return JSON (never fall through to SPA HTML)
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

// Express JSON error handler so body-parser or route errors on /api/* never emit HTML
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/') || req.path === '/api') {
    const status = typeof (err as { status?: number })?.status === 'number' ? (err as { status: number }).status : 500;
    const message = err instanceof Error ? err.message : 'Internal server error.';
    res.status(status).json({ error: message });
    return;
  }
  next(err);
});

  return app;
}
