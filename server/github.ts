import zlib from 'node:zlib';

export interface ParsedGitHubRepo {
  owner: string;
  name: string;
  fullName: string;
  canonicalUrl: string;
}

export interface GitHubRepoMetadata {
  owner: string;
  name: string;
  fullName: string;
  url: string;
  description: string;
  defaultBranch: string;
  commitSha: string;
  stars: number;
  isPrivate: boolean;
  sizeKb: number;
}

export interface IngestedFile {
  path: string;
  content: string;
  size: number;
  isBinary: boolean;
}

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024; // 25 MB archive limit
const MAX_FILES = 2500;
const MAX_TEXT_FILE_BYTES = 350 * 1024; // 350 KB per source file

const IGNORED_DIR_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'out',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  'target',
  'coverage',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  'vendor',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi',
  '.pyc', '.pyo', '.class', '.jar', '.o', '.a',
  '.sqlite', '.db',
]);

const SAFE_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

export function parseGitHubUrl(rawInput: string): ParsedGitHubRepo {
  const trimmed = rawInput.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('Please enter a GitHub repository URL.');
  }

  let owner = '';
  let name = '';

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    const parts = trimmed.split('/');
    owner = parts[0];
    name = parts[1];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error('Invalid URL format. Example: https://github.com/owner/repository');
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only HTTPS GitHub URLs are supported.');
    }
    if (parsed.hostname.toLowerCase() !== 'github.com' && parsed.hostname.toLowerCase() !== 'www.github.com') {
      throw new Error('Only public github.com repository URLs are supported.');
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) {
      throw new Error('GitHub URL must include both owner and repository name (e.g. https://github.com/owner/repo).');
    }
    owner = segments[0];
    name = segments[1];
  }

  if (!SAFE_SEGMENT_RE.test(owner) || !SAFE_SEGMENT_RE.test(name) || owner === '.' || owner === '..' || name === '.' || name === '..') {
    throw new Error('Invalid GitHub owner or repository name.');
  }

  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    canonicalUrl: `https://github.com/${owner}/${name}`,
  };
}

function cleanTokenValue(raw?: string): string {
  return (raw ?? '').trim().replace(/^["']|["']$/g, '').trim();
}

function resolveGithubToken(tokenOverride?: string): string {
  return cleanTokenValue(tokenOverride) || cleanTokenValue(process.env.GITHUB_TOKEN);
}

function githubHeaders(tokenOverride?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Codebase-Tutor-Analyzer/1.0',
  };
  const token = resolveGithubToken(tokenOverride);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function verifyGitHubToken(token: string): Promise<{ valid: boolean; username?: string; remaining?: number; limit?: number; error?: string }> {
  const clean = cleanTokenValue(token);
  if (!clean) return { valid: false, error: 'GitHub token is empty.' };

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Codebase-Tutor-Analyzer/1.0',
    Authorization: `Bearer ${clean}`,
  };

  const res = await fetch('https://api.github.com/user', {
    headers,
    signal: AbortSignal.timeout(10000),
  });

  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? '0');
  const limit = Number(res.headers.get('x-ratelimit-limit') ?? '0');

  if (res.status === 401) {
    return { valid: false, error: 'Invalid or expired GitHub token (401 Unauthorized).' };
  }

  // Fine-grained PATs scoped only to repos return 403 on /user; verify via /rate_limit
  if (res.status === 403) {
    const rateRes = await fetch('https://api.github.com/rate_limit', {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (rateRes.ok) {
      const rateRem = Number(rateRes.headers.get('x-ratelimit-remaining') ?? remaining);
      const rateLim = Number(rateRes.headers.get('x-ratelimit-limit') ?? limit);
      return { valid: true, username: 'fine-grained token', remaining: rateRem, limit: rateLim };
    }
    return { valid: false, error: `GitHub rejected token with status 403.` };
  }

  if (!res.ok) {
    return { valid: false, error: `GitHub verification returned status ${res.status}.` };
  }
  const data = (await res.json()) as { login?: string };
  return { valid: true, username: data.login, remaining, limit };
}

export async function fetchGitHubRepoMetadata(
  repo: ParsedGitHubRepo,
  tokenOverride?: string
): Promise<GitHubRepoMetadata> {
  const cleanToken = resolveGithubToken(tokenOverride);
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const res = await fetch(apiUrl, {
    headers: githubHeaders(cleanToken),
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 404) {
    throw new Error(
      cleanToken
        ? `Repository "${repo.fullName}" was not found or your GitHub token lacks access.`
        : `Repository "${repo.fullName}" was not found on GitHub or is private. Add a GitHub token in Settings if it is private.`
    );
  }
  if (res.status === 401) {
    throw new Error('Your GitHub token was rejected (401 Unauthorized). Please check it in Settings.');
  }
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      throw new Error('GitHub API rate limit reached. Please add your GitHub Personal Access Token in Settings.');
    }
    throw new Error(`Access denied while fetching "${repo.fullName}". Private repositories require a GitHub token with repo access.`);
  }
  if (!res.ok) {
    throw new Error(`GitHub returned status ${res.status} for "${repo.fullName}".`);
  }

  const data = (await res.json()) as {
    description?: string | null;
    default_branch?: string;
    stargazers_count?: number;
    private?: boolean;
    size?: number;
  };

  if (data.private && !tokenOverride?.trim()) {
    throw new Error(`"${repo.fullName}" is a private repository. Add your GitHub Personal Access Token in Settings to explore it.`);
  }
  if ((data.size ?? 0) > 150_000) {
    throw new Error(`Repository "${repo.fullName}" exceeds the 150 MB analysis limit.`);
  }

  const defaultBranch = data.default_branch || 'main';
  const commitUrl = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits/${encodeURIComponent(defaultBranch)}`;
  const commitRes = await fetch(commitUrl, {
    headers: githubHeaders(cleanToken),
    signal: AbortSignal.timeout(15000),
  });

  let commitSha = defaultBranch;
  if (commitRes.ok) {
    const commitData = (await commitRes.json()) as { sha?: string };
    if (commitData.sha) {
      commitSha = commitData.sha;
    }
  }

  return {
    owner: repo.owner,
    name: repo.name,
    fullName: repo.fullName,
    url: repo.canonicalUrl,
    description: (data.description ?? '').trim(),
    defaultBranch,
    commitSha,
    stars: data.stargazers_count ?? 0,
    isPrivate: Boolean(data.private),
    sizeKb: data.size ?? 0,
  };
}

function shouldIgnorePath(relPath: string): boolean {
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (IGNORED_DIR_SEGMENTS.has(parts[i])) {
      return true;
    }
  }
  const fileName = parts[parts.length - 1] ?? '';
  if (fileName === 'package-lock.json' || fileName === 'yarn.lock' || fileName === 'pnpm-lock.yaml' || fileName === 'bun.lockb') {
    return true;
  }
  return false;
}

function isBinaryExtension(relPath: string): boolean {
  const dotIdx = relPath.lastIndexOf('.');
  if (dotIdx === -1) return false;
  const ext = relPath.slice(dotIdx).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function redactEnvSecrets(filePath: string, content: string): string {
  const baseName = filePath.split('/').pop() ?? '';
  const isEnvFile = baseName === '.env' || (baseName.startsWith('.env.') && !baseName.endsWith('.example') && !baseName.endsWith('.sample') && !baseName.endsWith('.template'));
  if (!isEnvFile) return content;

  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return line;
      const key = line.slice(0, eqIdx);
      return `${key}=[REDACTED_FOR_SECURITY]`;
    })
    .join('\n');
}

function readTarString(buf: Buffer, start: number, length: number): string {
  let end = start;
  const max = Math.min(buf.length, start + length);
  while (end < max && buf[end] !== 0) {
    end++;
  }
  return buf.subarray(start, end).toString('utf8');
}

function parseTarBuffer(tarBuf: Buffer): { files: IngestedFile[]; skippedBinaryCount: number; truncatedByLimit: boolean } {
  const files: IngestedFile[] = [];
  let skippedBinaryCount = 0;
  let truncatedByLimit = false;
  let offset = 0;
  let paxPath: string | null = null;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark end of archive
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const rawName = readTarString(header, 0, 100);
    const sizeOctal = readTarString(header, 124, 12).trim();
    const size = parseInt(sizeOctal || '0', 8) || 0;
    const typeFlag = String.fromCharCode(header[156] || 48);
    const prefix = readTarString(header, 345, 155);

    offset += 512;
    const dataEnd = offset + size;
    const paddedEnd = offset + Math.ceil(size / 512) * 512;

    if (typeFlag === 'x' || typeFlag === 'g') {
      // PAX extended header
      const paxData = tarBuf.subarray(offset, Math.min(dataEnd, tarBuf.length)).toString('utf8');
      const pathMatch = paxData.match(/\d+ path=(.+)\n/);
      if (pathMatch && typeFlag === 'x') {
        paxPath = pathMatch[1];
      }
      offset = paddedEnd;
      continue;
    }

    const fullTarPath = paxPath ?? (prefix ? `${prefix}/${rawName}` : rawName);
    paxPath = null;

    if ((typeFlag === '0' || typeFlag === '\0') && fullTarPath) {
      // Strip top-level GitHub archive wrapper directory (owner-repo-sha/)
      const slashIdx = fullTarPath.indexOf('/');
      const relPath = slashIdx >= 0 ? fullTarPath.slice(slashIdx + 1) : fullTarPath;

      if (relPath && !shouldIgnorePath(relPath)) {
        if (files.length >= MAX_FILES) {
          truncatedByLimit = true;
        } else if (isBinaryExtension(relPath)) {
          skippedBinaryCount++;
          files.push({
            path: relPath,
            content: '',
            size,
            isBinary: true,
          });
        } else if (size <= MAX_TEXT_FILE_BYTES && dataEnd <= tarBuf.length) {
          const slice = tarBuf.subarray(offset, dataEnd);
          // Quick binary check: look for null bytes in first 1024 bytes
          const sampleLen = Math.min(slice.length, 1024);
          let hasNull = false;
          for (let i = 0; i < sampleLen; i++) {
            if (slice[i] === 0) {
              hasNull = true;
              break;
            }
          }
          if (hasNull) {
            skippedBinaryCount++;
            files.push({ path: relPath, content: '', size, isBinary: true });
          } else {
            const rawText = slice.toString('utf8');
            files.push({
              path: relPath,
              content: redactEnvSecrets(relPath, rawText),
              size,
              isBinary: false,
            });
          }
        }
      }
    }

    offset = paddedEnd;
  }

  return { files, skippedBinaryCount, truncatedByLimit };
}

export async function downloadAndExtractGitHubRepo(
  meta: GitHubRepoMetadata,
  tokenOverride?: string
): Promise<{ files: IngestedFile[]; skippedBinaryCount: number; truncatedByLimit: boolean }> {
  const token = resolveGithubToken(tokenOverride);
  // Use GitHub API tarball endpoint when accessing private repos or with token; codeload for unauthenticated public repos
  const tarballUrl = meta.isPrivate && token
    ? `https://api.github.com/repos/${encodeURIComponent(meta.owner)}/${encodeURIComponent(meta.name)}/tarball/${encodeURIComponent(meta.commitSha)}`
    : `https://codeload.github.com/${encodeURIComponent(meta.owner)}/${encodeURIComponent(meta.name)}/tar.gz/${encodeURIComponent(meta.commitSha)}`;

  const res = await fetch(tarballUrl, {
    headers: {
      'User-Agent': 'Codebase-Tutor-Analyzer/1.0',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    throw new Error(`Failed to download repository archive (${res.status}).`);
  }

  const contentLength = Number(res.headers.get('content-length') || '0');
  if (contentLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Repository archive exceeds 25 MB limit.');
  }

  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Repository archive exceeds 25 MB limit.');
  }

  const compressed = Buffer.from(arrayBuffer);
  const tarBuffer = zlib.gunzipSync(compressed);
  return parseTarBuffer(tarBuffer);
}
