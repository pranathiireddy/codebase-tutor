import { config } from './config.ts';

export type GitHubOAuthErrorCode =
  | 'access_denied'
  | 'provider_error'
  | 'pkce_rejected'
  | 'invalid_code'
  | 'unverified_email'
  | 'invalid_profile';

export class GitHubOAuthError extends Error {
  constructor(
    readonly code: GitHubOAuthErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'GitHubOAuthError';
  }
}

interface GitHubProfileResponse {
  id?: number;
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
}

interface GitHubEmailResponse {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

function providerError(response: GitHubTokenResponse): GitHubOAuthError {
  if (response.error === 'access_denied') {
    return new GitHubOAuthError('access_denied', 'GitHub authorization was denied.');
  }
  const description = typeof response.error_description === 'string'
    ? response.error_description.toLowerCase()
    : '';
  if (description.includes('code_challenge') || description.includes('code verifier')) {
    return new GitHubOAuthError(
      'pkce_rejected',
      'GitHub rejected PKCE for this application. State and browser-cookie validation remain enabled; contact the site administrator.'
    );
  }
  if (
    response.error === 'bad_verification_code' ||
    response.error === 'incorrect_client_credentials' ||
    response.error === 'redirect_uri_mismatch'
  ) {
    return new GitHubOAuthError('invalid_code', 'GitHub could not complete sign-in. Please try again.');
  }

  return new GitHubOAuthError('provider_error', 'GitHub could not complete sign-in. Please try again.');
}

export function getGitHubAuthorizationUrl(state: string, codeChallenge: string): string {
  if (!config.githubOAuthConfigured || !config.githubOAuthClientId || !config.githubRedirectUri) {
    throw new Error('GitHub sign-in is not configured.');
  }
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.githubOAuthClientId);
  url.searchParams.set('redirect_uri', config.githubRedirectUri);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function fetchGitHubIdentity(
  code: string,
  codeVerifier: string
): Promise<{
  providerUserId: string;
  providerLogin: string;
  name: string;
  avatarUrl: string | null;
  verifiedEmail: string;
}> {
  if (
    !config.githubOAuthConfigured ||
    !config.githubOAuthClientId ||
    !config.githubOAuthClientSecret ||
    !config.githubRedirectUri
  ) {
    throw new Error('GitHub sign-in is not configured.');
  }

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Codebase-Tutor/1.0',
    },
    body: JSON.stringify({
      client_id: config.githubOAuthClientId,
      client_secret: config.githubOAuthClientSecret,
      code,
      redirect_uri: config.githubRedirectUri,
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(config.githubAuthTimeoutMs),
  });
  let tokenPayload: GitHubTokenResponse;
  try {
    tokenPayload = await tokenResponse.json() as GitHubTokenResponse;
  } catch {
    throw new GitHubOAuthError('provider_error', 'GitHub returned an invalid sign-in response.');
  }
  if (!tokenResponse.ok || tokenPayload.error || !tokenPayload.access_token) {
    throw providerError(tokenPayload);
  }

  const authorization = `Bearer ${tokenPayload.access_token}`;
  const profileResponse = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: authorization,
      'User-Agent': 'Codebase-Tutor/1.0',
    },
    signal: AbortSignal.timeout(config.githubAuthTimeoutMs),
  });
  if (!profileResponse.ok) {
    throw new GitHubOAuthError('provider_error', 'Unable to retrieve your GitHub profile.');
  }
  const profile = await profileResponse.json() as GitHubProfileResponse;
  if (!Number.isSafeInteger(profile.id) || !profile.login) {
    throw new GitHubOAuthError('invalid_profile', 'GitHub returned an incomplete profile.');
  }

  const emailResponse = await fetch('https://api.github.com/user/emails', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: authorization,
      'User-Agent': 'Codebase-Tutor/1.0',
    },
    signal: AbortSignal.timeout(config.githubAuthTimeoutMs),
  });
  if (!emailResponse.ok) {
    throw new GitHubOAuthError('provider_error', 'Unable to retrieve your verified GitHub email.');
  }
  const emails = await emailResponse.json() as GitHubEmailResponse[];
  const verifiedEmail = emails.find((item) => item.primary && item.verified && item.email)?.email;
  if (!verifiedEmail) {
    throw new GitHubOAuthError(
      'unverified_email',
      'Your GitHub account has no primary verified email. Verify an email with GitHub and try again.'
    );
  }

  return {
    providerUserId: String(profile.id),
    providerLogin: profile.login,
    name: profile.name?.trim() || profile.login,
    avatarUrl: typeof profile.avatar_url === 'string' ? profile.avatar_url : null,
    verifiedEmail: verifiedEmail.trim().toLowerCase(),
  };
}
