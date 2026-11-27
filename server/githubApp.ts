import crypto from 'node:crypto';
import { config } from './config.ts';
import {
  getGithubAppInstallation,
  revokeGithubAppInstallation as revokeStoredInstallation,
  saveGithubAppInstallation,
  updateGithubAppInstallationToken,
} from './db/index.ts';
import { encryptSecret, decryptSecret } from './secretCrypto.ts';

interface GitHubInstallationResponse {
  id?: number;
  account?: { login?: string };
  permissions?: { contents?: string };
}

interface GitHubInstallationTokenResponse {
  token?: string;
  expires_at?: string;
  permissions?: { contents?: string };
}

export class GitHubAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAppError';
  }
}

async function fetchGitHubApp(
  input: string,
  init: RequestInit,
  failureMessage: string
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new GitHubAppError(failureMessage);
  }
}

export function getGitHubAppInstallUrl(state: string): string {
  if (!config.githubAppConfigured || !config.githubAppSlug) {
    throw new GitHubAppError('Private repository access is not configured.');
  }
  const url = new URL(
    `https://github.com/apps/${encodeURIComponent(config.githubAppSlug)}/installations/new`
  );
  url.searchParams.set('state', state);
  return url.toString();
}

function createAppJwt(): string {
  if (!config.githubAppConfigured || !config.githubAppId || !config.githubAppPrivateKey) {
    throw new GitHubAppError('Private repository access is not configured.');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + 8 * 60,
    iss: config.githubAppId,
  })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), config.githubAppPrivateKey);
  return `${unsigned}.${signature.toString('base64url')}`;
}

async function fetchInstallation(installationId: string): Promise<GitHubInstallationResponse> {
  const response = await fetchGitHubApp(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${createAppJwt()}`,
        'User-Agent': 'Codebase-Tutor/1.0',
      },
      signal: AbortSignal.timeout(config.githubAuthTimeoutMs),
    },
    'Unable to verify the GitHub App installation.'
  );
  if (!response.ok) {
    throw new GitHubAppError('Unable to verify the GitHub App installation.');
  }
  return await response.json() as GitHubInstallationResponse;
}

async function createInstallationToken(installationId: string): Promise<{
  token: string;
  expiresAt: number;
}> {
  const response = await fetchGitHubApp(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${createAppJwt()}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Codebase-Tutor/1.0',
      },
      body: JSON.stringify({ permissions: { contents: 'read' } }),
      signal: AbortSignal.timeout(config.githubAuthTimeoutMs),
    },
    'Unable to create a read-only GitHub App access token.'
  );
  if (!response.ok) {
    throw new GitHubAppError('Unable to create a read-only GitHub App access token.');
  }
  const payload = await response.json() as GitHubInstallationTokenResponse;
  const expiresAt = payload.expires_at ? Date.parse(payload.expires_at) : Number.NaN;
  if (
    typeof payload.token !== 'string' ||
    !payload.token ||
    !Number.isFinite(expiresAt) ||
    payload.permissions?.contents !== 'read'
  ) {
    throw new GitHubAppError('GitHub did not issue a read-only Contents token.');
  }
  return { token: payload.token, expiresAt };
}

export async function storeGitHubAppInstallation(
  userId: string,
  installationId: string
): Promise<{ installationId: string; accountLogin: string }> {
  if (!config.githubAppConfigured) throw new GitHubAppError('Private repository access is not configured.');
  const installation = await fetchInstallation(installationId);
  const accountLogin = installation.account?.login;
  if (
    String(installation.id) !== installationId ||
    !accountLogin ||
    installation.permissions?.contents !== 'read'
  ) {
    throw new GitHubAppError('Install the Plupus GitHub App with read-only Contents permission.');
  }
  const accessToken = await createInstallationToken(installationId);
  const now = Date.now();
  saveGithubAppInstallation({
    userId,
    installationId,
    accountLogin,
    accessTokenEnc: encryptSecret(accessToken.token),
    tokenExpiresAt: accessToken.expiresAt,
    createdAt: now,
    lastUsedAt: now,
    revokedAt: null,
  });
  return { installationId, accountLogin };
}

export async function getGitHubAppTokenForRepository(
  userId: string,
  owner: string,
  repository: string
): Promise<string | undefined> {
  if (!config.githubAppConfigured) return undefined;
  const response = await fetchGitHubApp(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/installation`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${createAppJwt()}`,
        'User-Agent': 'Codebase-Tutor/1.0',
      },
      signal: AbortSignal.timeout(config.githubApiTimeoutMs),
    },
    'Unable to check GitHub App access for this repository.'
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new GitHubAppError('Unable to check GitHub App access for this repository.');
  const installation = await response.json() as GitHubInstallationResponse;
  if (!installation.id) return undefined;

  const installationId = String(installation.id);
  const stored = getGithubAppInstallation(userId, installationId);
  if (!stored) return undefined;
  const now = Date.now();
  if (stored.tokenExpiresAt > now + 60_000) {
    return decryptSecret(stored.accessTokenEnc);
  }

  const refreshed = await createInstallationToken(installationId);
  if (!updateGithubAppInstallationToken(
    userId,
    installationId,
    encryptSecret(refreshed.token),
    refreshed.expiresAt,
    now
  )) {
    throw new GitHubAppError('GitHub App access was revoked while refreshing its token.');
  }
  return refreshed.token;
}

export async function removeGitHubAppInstallation(
  userId: string,
  installationId: string
): Promise<void> {
  if (!config.githubAppConfigured) throw new GitHubAppError('Private repository access is not configured.');
  const stored = getGithubAppInstallation(userId, installationId);
  if (!stored) throw new GitHubAppError('GitHub App installation not found.');

  const response = await fetchGitHubApp(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
    {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${createAppJwt()}`,
        'User-Agent': 'Codebase-Tutor/1.0',
      },
      signal: AbortSignal.timeout(config.githubAuthTimeoutMs),
    },
    'GitHub could not revoke the App installation.'
  );
  if (!response.ok && response.status !== 404) {
    throw new GitHubAppError('GitHub could not revoke the App installation.');
  }
  if (!revokeStoredInstallation(userId, installationId, Date.now())) {
    throw new GitHubAppError('GitHub App installation was already revoked.');
  }
}
