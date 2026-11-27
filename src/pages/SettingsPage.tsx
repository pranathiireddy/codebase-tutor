import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  AlertCircle,
  Eye,
  EyeOff,
  KeyRound,
  GitBranch,
  Loader2,
  ShieldCheck,
  Trash2,
  ArrowRight,
} from 'lucide-react';
import { TopNav } from '../components/TopNav';
import { useApp } from '../context/AppContext';
import type { DiagramType } from '../types/codebase';
import { apiFetch, safeJson } from '../utils/api';

interface ServerKeyStatus {
  hasServerGeminiKey: boolean;
  serverGeminiRejected?: boolean;
  hasServerGithubToken: boolean;
}

interface VerifyResponse {
  valid: boolean;
  model?: string;
  note?: string;
  username?: string;
  remaining?: number;
  limit?: number;
  error?: string;
}

interface SavedApiKey {
  provider: 'gemini' | 'github' | 'github_owner';
  last4: string;
  model: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

interface GitHubSettingsStatus {
  githubOAuthConfigured: boolean;
  githubAppConfigured: boolean;
  passwordSet: boolean;
  githubAccount: { login: string; avatarUrl: string | null } | null;
  installations: Array<{ installationId: string; accountLogin: string }>;
}

const PRESET_MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
] as const;

export function SettingsPage() {
  const [searchParams] = useSearchParams();
  const {
    preferences,
    updatePreferences,
    preferencesError,
    user,
    credentialStatus,
    setCredentialStatus,
  } = useApp();

  const [cacheMessage, setCacheMessage] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [modelPreset, setModelPreset] = useState<string>('gemini-4-hydrogen');
  const [customModel, setCustomModel] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [githubDefaultOwner, setGithubDefaultOwner] = useState('');

  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [savedBanner, setSavedBanner] = useState<string | null>(null);
  const [savedKeys, setSavedKeys] = useState<SavedApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [serverStatus, setServerStatus] = useState<ServerKeyStatus | null>(null);
  const [githubSettings, setGithubSettings] = useState<GitHubSettingsStatus | null>(null);
  const [githubSettingsError, setGithubSettingsError] = useState<string | null>(null);
  const [githubActionError, setGithubActionError] = useState<string | null>(null);
  const [githubActionNotice, setGithubActionNotice] = useState<string | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [privateAccessConsent, setPrivateAccessConsent] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);

  const loadSavedKeys = async () => {
    const res = await apiFetch('/api/settings/keys');
    const data = await safeJson<{ keys?: SavedApiKey[]; error?: string }>(res);
    if (!res.ok) throw new Error(data.error || 'Unable to load saved API keys.');
    setSavedKeys(data.keys ?? []);
    const gemini = data.keys?.find((key) => key.provider === 'gemini');
    if (gemini?.model) syncModelSelection(gemini.model);
  };

  useEffect(() => {
    let cancelled = false;
    void apiFetch('/api/settings/keys')
      .then(async (res) => {
        const data = await safeJson<{ keys?: SavedApiKey[]; error?: string }>(res);
        if (!res.ok) throw new Error(data.error || 'Unable to load saved API keys.');
        if (!cancelled) {
          setSavedKeys(data.keys ?? []);
          const gemini = data.keys?.find((key) => key.provider === 'gemini');
          if (gemini?.model) syncModelSelection(gemini.model);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setVerifyError(
            error instanceof TypeError
              ? 'The server is unavailable. Saved API key settings could not be loaded.'
              : error instanceof Error
                ? error.message
                : 'Unable to load saved API keys.'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setKeysLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadServerStatus() {
      try {
        const res = await apiFetch('/api/settings/status');
        if (res.ok && !cancelled) {
          const data = await safeJson<ServerKeyStatus>(res);
          setServerStatus(data);
        }
      } catch {
        // ignore status check error
      }
    }
    void loadServerStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadGitHubSettings() {
      try {
        const res = await apiFetch('/api/settings/github');
        const data = await safeJson<GitHubSettingsStatus & { error?: string }>(res);
        if (!res.ok) throw new Error(data.error || 'Unable to load GitHub settings.');
        if (!cancelled) setGithubSettings(data);
      } catch (error) {
        if (!cancelled) {
          setGithubSettingsError(error instanceof Error ? error.message : 'Unable to load GitHub settings.');
        }
      }
    }
    void loadGitHubSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (searchParams.get('github') === 'connected') {
      setGithubActionNotice('GitHub sign-in is connected.');
    } else if (searchParams.get('private_access') === 'connected') {
      setGithubActionNotice('Read-only private repository access is connected.');
    }
    const error = searchParams.get('github_error');
    if (error) {
      const messages: Record<string, string> = {
        access_denied: 'GitHub authorization was denied.',
        expired_attempt: 'That GitHub request expired or could not be verified. Please try again.',
        github_account_linked: 'That GitHub account is already connected to another account.',
        github_already_linked: 'A different GitHub account is already connected. Disconnect it first.',
        private_access_denied: 'GitHub App access was not granted.',
        private_install_failed: 'The GitHub App installation could not be verified. Please try again.',
        session_changed: 'Your sign-in session changed. Please sign in again before connecting GitHub.',
      };
      setGithubActionError(messages[error] ?? 'GitHub could not complete the request. Please try again.');
    }
  }, [searchParams]);

  const effectiveModel =
    modelPreset === 'custom'
      ? customModel.trim() || 'gemini-4-hydrogen'
      : modelPreset;

  function syncModelSelection(resolvedModel: string): void {
    if (PRESET_MODELS.includes(resolvedModel as (typeof PRESET_MODELS)[number])) {
      setModelPreset(resolvedModel);
      setCustomModel('');
    } else {
      setModelPreset('custom');
      setCustomModel(resolvedModel);
    }
  }

  const handleSaveAndVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setVerifyError(null);
    setSavedBanner(null);

    const trimmedGemini = geminiApiKey.trim().replace(/^["']|["']$/g, '').trim();
    const trimmedGithub = githubToken.trim().replace(/^["']|["']$/g, '').trim();
    const trimmedOwner = githubDefaultOwner.trim().replace(/^@/, '');
    setVerifying(true);
    try {
      const inputs: Array<{ provider: SavedApiKey['provider']; value: string; model?: string }> = [];
      if (trimmedGemini) inputs.push({ provider: 'gemini', value: trimmedGemini, model: effectiveModel });
      if (trimmedGithub) inputs.push({ provider: 'github', value: trimmedGithub });
      if (trimmedOwner) inputs.push({ provider: 'github_owner', value: trimmedOwner });

      const tested = await Promise.all(
        inputs.map(async (input) => {
          const res = await apiFetch(`/api/settings/keys/${input.provider}/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: input.value, model: input.model }),
          });
          const result = await safeJson<VerifyResponse>(res);
          if (!res.ok) throw new Error(result.error || `Unable to test ${input.provider} credentials.`);
          return { ...input, result };
        })
      );

      const gemini = tested.find((entry) => entry.provider === 'gemini')?.result;
      const github = tested.find((entry) => entry.provider === 'github')?.result;
      setCredentialStatus({
        geminiVerified: gemini ? gemini.valid : null,
        geminiMessage: gemini
          ? gemini.valid
            ? gemini.note
              ? `Verified with ${gemini.model} (${gemini.note})`
              : `Verified (${gemini.model})`
            : gemini.error
          : undefined,
        githubVerified: github ? github.valid : null,
        githubMessage: github
          ? github.valid
            ? `Authenticated as @${github.username} (${github.remaining ?? 0}/${github.limit ?? 5000} API calls left)`
            : github.error
          : undefined,
      });

      if (tested.some((entry) => !entry.result.valid)) {
        setVerifyError('One or more credentials failed verification. Review the status messages below.');
        return;
      }

      for (const entry of tested) {
        const res = await apiFetch(`/api/settings/keys/${entry.provider}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            value: entry.value,
            model: entry.provider === 'gemini' ? entry.result.model || effectiveModel : undefined,
          }),
        });
        const result = await safeJson<{ error?: string }>(res);
        if (!res.ok) throw new Error(result.error || `Unable to save ${entry.provider} credentials.`);
      }

      const existingGemini = savedKeys.find((key) => key.provider === 'gemini');
      if (!trimmedGemini && existingGemini && existingGemini.model !== effectiveModel) {
        const res = await apiFetch('/api/settings/keys/gemini', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: effectiveModel }),
        });
        const result = await safeJson<{ error?: string }>(res);
        if (!res.ok) throw new Error(result.error || 'Unable to update the Gemini model.');
      }
      await loadSavedKeys();
      setGeminiApiKey('');
      setGithubToken('');
      setGithubDefaultOwner('');
      setSavedBanner(
        inputs.length
          ? 'Credentials verified and saved securely for your account.'
          : 'No new credentials entered. Existing saved credentials are unchanged.'
      );
    } catch (err) {
      setVerifyError(
        err instanceof TypeError
          ? 'Unable to reach the server. Check your connection; reload this page to confirm whether any changes were saved.'
          : err instanceof Error
            ? err.message
            : 'Unable to verify and save credentials.'
      );
    } finally {
      setVerifying(false);
    }
  };

  const handleClearKeys = async () => {
    setVerifying(true);
    setVerifyError(null);
    setSavedBanner(null);
    try {
      for (const provider of ['gemini', 'github', 'github_owner'] as const) {
        const res = await apiFetch(`/api/settings/keys/${provider}`, { method: 'DELETE' });
        const result = await safeJson<{ error?: string }>(res);
        if (!res.ok) throw new Error(result.error || `Unable to remove ${provider} credentials.`);
      }
      setSavedKeys([]);
      setCredentialStatus({ geminiVerified: null, githubVerified: null });
      setSavedBanner('Custom API keys and the default GitHub owner were removed.');
    } catch (err) {
      setVerifyError(
        err instanceof TypeError
          ? 'Unable to reach the server. Some credentials may remain; reload to check.'
          : err instanceof Error
            ? err.message
            : 'Unable to remove saved credentials.'
      );
    } finally {
      setVerifying(false);
    }
    setGeminiApiKey('');
    setModelPreset('gemini-4-hydrogen');
    setCustomModel('');
    setGithubToken('');
    setGithubDefaultOwner('');
  };

  const handleClearCache = async () => {
    setClearing(true);
    setCacheMessage(null);
    try {
      const res = await apiFetch('/api/cache/clear', {
        method: 'POST',
      });
      const json = await safeJson<{ cleared?: number }>(res);
      setCacheMessage(`Cleared ${json.cleared ?? 0} cached commit snapshot(s).`);
    } catch {
      setCacheMessage('Failed to clear cache.');
    } finally {
      setClearing(false);
    }
  };

  const handleSavePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setGithubActionError(null);
    setGithubActionNotice(null);
    setPasswordBusy(true);
    try {
      const res = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(githubSettings?.passwordSet ? { currentPassword } : {}),
          newPassword,
        }),
      });
      const data = await safeJson<{ error?: string }>(res);
      if (!res.ok) throw new Error(data.error || 'Unable to save password.');
      setGithubSettings((current) => current ? { ...current, passwordSet: true } : current);
      setCurrentPassword('');
      setNewPassword('');
      setGithubActionNotice('Password saved. Other sessions have been signed out.');
    } catch (error) {
      setGithubActionError(error instanceof Error ? error.message : 'Unable to save password.');
    } finally {
      setPasswordBusy(false);
    }
  };

  const handleDisconnectGitHub = async () => {
    setGithubBusy(true);
    setGithubActionError(null);
    setGithubActionNotice(null);
    try {
      const res = await apiFetch('/api/auth/github/disconnect', { method: 'POST' });
      const data = await safeJson<{ error?: string }>(res);
      if (!res.ok) throw new Error(data.error || 'Unable to disconnect GitHub.');
      setGithubSettings((current) => current ? { ...current, githubAccount: null } : current);
      setGithubActionNotice('GitHub sign-in disconnected.');
    } catch (error) {
      setGithubActionError(error instanceof Error ? error.message : 'Unable to disconnect GitHub.');
    } finally {
      setGithubBusy(false);
    }
  };

  const handleStartGitHubLink = async () => {
    setGithubBusy(true);
    setGithubActionError(null);
    try {
      const res = await apiFetch('/api/auth/github/link/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirectAfter: '/settings' }),
      });
      const data = await safeJson<{ authorizationUrl?: string; error?: string }>(res);
      if (!res.ok || !data.authorizationUrl) {
        throw new Error(data.error || 'Unable to start GitHub account linking.');
      }
      window.location.assign(data.authorizationUrl);
    } catch (error) {
      setGithubActionError(error instanceof Error ? error.message : 'Unable to start GitHub account linking.');
      setGithubBusy(false);
    }
  };

  const handleStartPrivateAccess = async () => {
    setGithubBusy(true);
    setGithubActionError(null);
    try {
      const res = await apiFetch('/api/settings/github-app/install/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          consent: 'read_only_contents',
          redirectAfter: '/settings',
        }),
      });
      const data = await safeJson<{ authorizationUrl?: string; error?: string }>(res);
      if (!res.ok || !data.authorizationUrl) {
        throw new Error(data.error || 'Unable to start GitHub App installation.');
      }
      window.location.assign(data.authorizationUrl);
    } catch (error) {
      setGithubActionError(error instanceof Error ? error.message : 'Unable to start GitHub App installation.');
      setGithubBusy(false);
    }
  };

  const handleRevokePrivateAccess = async (installationId: string) => {
    setGithubBusy(true);
    setGithubActionError(null);
    setGithubActionNotice(null);
    try {
      const res = await apiFetch(
        `/api/settings/github-app/installations/${encodeURIComponent(installationId)}`,
        { method: 'DELETE' }
      );
      const data = await safeJson<{ error?: string }>(res);
      if (!res.ok) throw new Error(data.error || 'Unable to revoke GitHub App access.');
      setGithubSettings((current) => current
        ? {
            ...current,
            installations: current.installations.filter(
              (installation) => installation.installationId !== installationId
            ),
          }
        : current);
      setGithubActionNotice('GitHub App access was revoked.');
    } catch (error) {
      setGithubActionError(error instanceof Error ? error.message : 'Unable to revoke GitHub App access.');
    } finally {
      setGithubBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0D10] text-[#E6E9EF]">
      <TopNav />
      <main className="mx-auto max-w-2xl px-6 py-14 space-y-8">
        <header className="border-b border-[#232832] pb-5">
          <h1 className="text-2xl font-bold text-[#F9FAFB]">Workspace Settings</h1>
          <p className="mt-1 text-xs text-[#9CA3AF]">
            Manage encrypted server-side API keys, code viewer typography, and analysis cache.
          </p>
        </header>

        {user && (
          <section className="rounded-lg border border-[#232832] bg-[#111419] p-4 text-xs space-y-1">
            <div className="font-semibold text-[#F3F4F6]">{user.name}</div>
            <div className="text-[#9CA3AF]">{user.email} · {user.role}</div>
          </section>
        )}

        <section className="space-y-5 rounded-xl border border-[#232832] bg-[#111419] p-6">
          <div className="border-b border-[#232832] pb-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[#F3F4F6]">
              <GitBranch className="h-4 w-4 text-sky-400" />
              GitHub sign-in and private repositories
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-[#9CA3AF]">
              GitHub sign-in reads your name, avatar and primary verified email. Private repository access is separate and limited to read-only Contents.
            </p>
          </div>

          {githubActionNotice && (
            <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-300">
              {githubActionNotice}
            </div>
          )}
          {(githubSettingsError || githubActionError) && (
            <div className="rounded border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
              {githubActionError || githubSettingsError}
            </div>
          )}

          {githubSettings?.githubAccount ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#232832] bg-[#0B0D10] p-3">
              <div className="flex items-center gap-3">
                {githubSettings.githubAccount.avatarUrl && (
                  <img
                    src={githubSettings.githubAccount.avatarUrl}
                    alt=""
                    className="h-8 w-8 rounded-full"
                  />
                )}
                <div>
                  <div className="text-xs font-medium text-[#E6E9EF]">
                    Connected as @{githubSettings.githubAccount.login}
                  </div>
                  <div className="text-[11px] text-[#9CA3AF]">GitHub sign-in</div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleDisconnectGitHub}
                disabled={githubBusy || !githubSettings.passwordSet}
                className="rounded border border-[#3B414D] px-3 py-1.5 text-[11px] text-[#D1D5DB] hover:border-rose-500 hover:text-rose-300 disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          ) : githubSettings?.githubOAuthConfigured ? (
            <button
              type="button"
              onClick={() => void handleStartGitHubLink()}
              disabled={githubBusy}
              className="inline-flex rounded-md border border-[#3B414D] px-3 py-2 text-xs font-medium text-[#E6E9EF] hover:border-sky-500 hover:text-sky-300 disabled:opacity-50"
            >
              Connect GitHub sign-in
            </button>
          ) : null}

          {githubSettings && (
            <form onSubmit={handleSavePassword} className="space-y-3 rounded-lg border border-[#232832] bg-[#0B0D10] p-3">
              <div className="text-xs font-medium text-[#E6E9EF]">
                {githubSettings.passwordSet ? 'Change password' : 'Set a password'}
              </div>
              {githubSettings.passwordSet && (
                <input
                  type="password"
                  autoComplete="current-password"
                  aria-label="Current password"
                  placeholder="Current password"
                  required
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  className="w-full rounded-md border border-[#232832] bg-[#111419] px-3 py-2 text-xs text-[#E6E9EF] focus:border-sky-500 focus:outline-none"
                />
              )}
              <input
                type="password"
                autoComplete="new-password"
                aria-label="New password"
                placeholder="New password (at least 12 characters)"
                minLength={12}
                required
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className="w-full rounded-md border border-[#232832] bg-[#111419] px-3 py-2 text-xs text-[#E6E9EF] focus:border-sky-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={passwordBusy}
                className="rounded-md bg-sky-500 px-3 py-2 text-[11px] font-semibold text-[#0B0D10] hover:bg-sky-400 disabled:opacity-50"
              >
                {passwordBusy ? 'Saving...' : githubSettings.passwordSet ? 'Save new password' : 'Set password'}
              </button>
            </form>
          )}

          {githubSettings?.githubAppConfigured && (
            <div className="space-y-3 rounded-lg border border-[#232832] bg-[#0B0D10] p-3">
              <div>
                <div className="text-xs font-medium text-[#E6E9EF]">Optional private repository access</div>
                <p className="mt-1 text-[11px] leading-relaxed text-[#9CA3AF]">
                  The GitHub App can read repository Contents only. Private code is held in server memory for analysis and is not written to disk or the database. You can revoke access here at any time.
                </p>
              </div>
              {githubSettings.installations.map((installation) => (
                <div
                  key={installation.installationId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#232832] p-2"
                >
                  <span className="text-xs text-[#D1D5DB]">Connected to @{installation.accountLogin}</span>
                  <button
                    type="button"
                    onClick={() => void handleRevokePrivateAccess(installation.installationId)}
                    disabled={githubBusy}
                    className="rounded border border-[#3B414D] px-2.5 py-1 text-[11px] text-[#D1D5DB] hover:border-rose-500 hover:text-rose-300 disabled:opacity-50"
                  >
                    Revoke access
                  </button>
                </div>
              ))}
              <label className="flex items-start gap-2 text-[11px] text-[#D1D5DB]">
                <input
                  type="checkbox"
                  checked={privateAccessConsent}
                  onChange={(event) => setPrivateAccessConsent(event.target.checked)}
                  className="mt-0.5 accent-sky-500"
                />
                <span>
                  I authorize Codebase Tutor to access private repository contents with read-only permission. I understand the code is processed in memory only.
                </span>
              </label>
              <button
                type="button"
                onClick={() => void handleStartPrivateAccess()}
                disabled={!privateAccessConsent || githubBusy}
                className="rounded-md bg-sky-500 px-3 py-2 text-[11px] font-semibold text-[#0B0D10] hover:bg-sky-400 disabled:opacity-50"
              >
                {githubBusy ? 'Connecting...' : 'Authorize read-only access'}
              </button>
            </div>
          )}
        </section>

        {/* Bring Your Own Gemini & GitHub Keys */}
        <section className="space-y-5 rounded-xl border border-[#232832] bg-[#111419] p-6">
          <div className="flex items-start justify-between gap-4 border-b border-[#232832] pb-4">
            <div>
              <h2 className="text-sm font-semibold text-[#F3F4F6] flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-sky-400" />
                <span>API Keys & GitHub Credentials</span>
              </h2>
              <p className="mt-1 text-[11px] leading-relaxed text-[#9CA3AF]">
                Keys are encrypted on the server and never returned to your browser. Leave a field blank to keep its saved value; enter a replacement to update it.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border border-[#232832] bg-[#0B0D10] px-3.5 py-2.5 text-[11px] text-[#9CA3AF]">
            <ShieldCheck className="h-4 w-4 text-sky-400 shrink-0 mt-0.5" />
            <div>
              Saved credentials are encrypted and used only by the server for requests on your behalf.
              {serverStatus && (
                <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-[#6B7280]">
                  <span>
                    Server Gemini fallback:{' '}
                    <span
                      className={
                        serverStatus.hasServerGeminiKey
                          ? 'text-emerald-400'
                          : 'text-amber-400'
                      }
                    >
                      {serverStatus.serverGeminiRejected
                        ? 'Restricted (enter your own key below)'
                        : serverStatus.hasServerGeminiKey
                          ? 'Configured'
                          : 'Not set'}
                    </span>
                  </span>
                  <span>
                    Server GitHub token:{' '}
                    <span className={serverStatus.hasServerGithubToken ? 'text-emerald-400' : 'text-[#9CA3AF]'}>
                      {serverStatus.hasServerGithubToken ? 'Configured' : 'Public only (60 req/hr)'}
                    </span>
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-[#232832] bg-[#0B0D10] p-3 text-[11px] text-[#9CA3AF]">
            <div className="mb-2 font-medium text-[#D1D5DB]">
              {keysLoading ? 'Loading saved credentials...' : 'Saved credentials'}
            </div>
            {!keysLoading && savedKeys.length === 0 && <div>No custom credentials saved.</div>}
            <div className="space-y-1">
              {savedKeys.map((key) => (
                <div key={key.provider} className="flex items-center justify-between gap-3">
                  <span>
                    {key.provider === 'github_owner'
                      ? 'Default GitHub owner'
                      : key.provider === 'github'
                        ? 'GitHub token'
                        : 'Gemini key'}
                  </span>
                  <span className="font-mono text-[#D1D5DB]">
                    ...{key.last4}{key.provider === 'gemini' && key.model ? ` · ${key.model}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <form onSubmit={handleSaveAndVerify} className="space-y-5">
            {/* Gemini Key & Model */}
            <div className="space-y-3">
              <div>
                <label htmlFor="gemini-api-key" className="block text-xs font-semibold text-[#F3F4F6]">
                  Gemini API Key
                </label>
                <p className="text-[11px] text-[#9CA3AF]">
                  Used for Tutor Chat and speech synthesis. Compatible models are auto-detected when tested.
                </p>
              </div>
              <div className="relative">
                <input
                  id="gemini-api-key"
                  type={showGeminiKey ? 'text' : 'password'}
                  value={geminiApiKey}
                  onChange={(e) => {
                    const val = e.target.value;
                    setGeminiApiKey(val);
                  }}
                  placeholder={savedKeys.some((key) => key.provider === 'gemini') ? 'Saved securely; enter a replacement' : 'AIza...'}
                  autoComplete="off"
                  className="w-full rounded-md border border-[#232832] bg-[#0B0D10] py-2 pl-3 pr-10 font-mono text-xs text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowGeminiKey((s) => !s)}
                  aria-label={showGeminiKey ? 'Hide Gemini API key' : 'Show Gemini API key'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6B7280] hover:text-[#E6E9EF] cursor-pointer"
                >
                  {showGeminiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {credentialStatus.geminiVerified !== null && credentialStatus.geminiMessage && (
                <div
                  className={`flex items-center gap-1.5 text-[11px] ${
                    credentialStatus.geminiVerified ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {credentialStatus.geminiVerified ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span>{credentialStatus.geminiMessage}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pt-1">
                <div>
                  <label htmlFor="gemini-model" className="block text-xs font-medium text-[#D1D5DB] mb-1">
                    Gemini Model
                  </label>
                  <select
                    id="gemini-model"
                    value={modelPreset}
                    onChange={(e) => {
                      const next = e.target.value;
                      setModelPreset(next);
                    }}
                    className="w-full rounded border border-[#232832] bg-[#0B0D10] px-3 py-1.5 font-mono text-xs text-[#E6E9EF] focus:border-sky-500 focus:outline-none"
                  >
                    <option value="gemini-4-hydrogen">gemini-4-hydrogen (Default)</option>
                    <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                    <option value="gemini-2.5-flash">gemini-2.5-flash (Public API key)</option>
                    <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite (Public API key)</option>
                    <option value="gemini-2.5-pro">gemini-2.5-pro (Public API key)</option>
                    <option value="custom">Custom model ID...</option>
                  </select>
                </div>
                {modelPreset === 'custom' && (
                  <div>
                    <label htmlFor="custom-gemini-model" className="block text-xs font-medium text-[#D1D5DB] mb-1">
                      Custom Model Name
                    </label>
                    <input
                      id="custom-gemini-model"
                      type="text"
                      value={customModel}
                      onChange={(e) => {
                        const val = e.target.value;
                        setCustomModel(val);
                      }}
                      placeholder="e.g. gemini-2.5-flash"
                      className="w-full rounded border border-[#232832] bg-[#0B0D10] px-3 py-1.5 font-mono text-xs text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* GitHub Token & Default Owner */}
            <div className="space-y-3 border-t border-[#232832] pt-5">
              <div>
                <label htmlFor="github-token" className="text-xs font-semibold text-[#F3F4F6] flex items-center gap-1.5">
                  <GitBranch className="h-3.5 w-3.5 text-sky-400" />
                  <span>GitHub Personal Access Token (PAT)</span>
                </label>
                <p className="text-[11px] text-[#9CA3AF]">
                  Unlocks private repository ingestion (kept memory-only, never cached to disk) and 5,000 req/hr quota.
                </p>
              </div>
              <div className="relative">
                <input
                  id="github-token"
                  type={showGithubToken ? 'text' : 'password'}
                  value={githubToken}
                  onChange={(e) => {
                    const val = e.target.value;
                    setGithubToken(val);
                  }}
                  placeholder={savedKeys.some((key) => key.provider === 'github') ? 'Saved securely; enter a replacement' : 'ghp_... or github_pat_...'}
                  autoComplete="off"
                  className="w-full rounded-md border border-[#232832] bg-[#0B0D10] py-2 pl-3 pr-10 font-mono text-xs text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowGithubToken((s) => !s)}
                  aria-label={showGithubToken ? 'Hide GitHub token' : 'Show GitHub token'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6B7280] hover:text-[#E6E9EF] cursor-pointer"
                >
                  {showGithubToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {credentialStatus.githubVerified !== null && credentialStatus.githubMessage && (
                <div
                  className={`flex items-center gap-1.5 text-[11px] ${
                    credentialStatus.githubVerified ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {credentialStatus.githubVerified ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span>{credentialStatus.githubMessage}</span>
                </div>
              )}

              <div>
                <label htmlFor="github-owner" className="block text-xs font-medium text-[#D1D5DB] mb-1">
                  Default GitHub Username / Organization (Optional)
                </label>
                <input
                  id="github-owner"
                  type="text"
                  value={githubDefaultOwner}
                  onChange={(e) => {
                    const val = e.target.value;
                    setGithubDefaultOwner(val);
                  }}
                  placeholder="e.g. octocat (allows entering bare repo names when importing)"
                  className="w-full rounded border border-[#232832] bg-[#0B0D10] px-3 py-1.5 font-mono text-xs text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500 focus:outline-none"
                />
              </div>
            </div>

            {verifyError && (
              <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{verifyError}</span>
              </div>
            )}

            {savedBanner && !verifyError && (
              <div className="flex items-center justify-between gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
                <span>{savedBanner}</span>
                <Link
                  to="/workspace/dietrichgebert__ponytail"
                  className="inline-flex items-center gap-1 font-medium text-sky-300 hover:text-sky-200 whitespace-nowrap shrink-0"
                >
                  <span>Back to Workspace</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <button
                type="submit"
                disabled={verifying}
                className="inline-flex items-center gap-2 rounded-md bg-sky-500 px-4 py-2 text-xs font-semibold text-[#0B0D10] hover:bg-sky-400 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
              >
                {verifying ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Testing & Saving...</span>
                  </>
                ) : (
                  <span>Test & Save Credentials</span>
                )}
              </button>

              <button
                type="button"
                onClick={handleClearKeys}
                disabled={verifying || keysLoading}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#232832] bg-[#161A21] px-3 py-2 text-xs font-medium text-[#9CA3AF] hover:border-rose-500/50 hover:text-rose-300 cursor-pointer whitespace-nowrap"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Clear Custom Keys</span>
              </button>
            </div>
          </form>
        </section>

        {/* Workspace Display & Cache Settings */}
        <section className="space-y-5 rounded-xl border border-[#232832] bg-[#111419] p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <label htmlFor="font-size" className="text-xs font-semibold text-[#F3F4F6]">
                Code Viewer Font Size
              </label>
              <p className="text-[11px] text-[#9CA3AF]">Adjust monospace font size in the read-only Monaco viewer.</p>
            </div>
            <select
              id="font-size"
              value={preferences.editorFontSize}
              onChange={(e) => updatePreferences({ editorFontSize: Number(e.target.value) })}
              className="rounded border border-[#232832] bg-[#0B0D10] px-3 py-1.5 font-mono text-xs text-[#E6E9EF]"
            >
              <option value={12}>12 px</option>
              <option value={13}>13 px</option>
              <option value={14}>14 px</option>
              <option value={15}>15 px</option>
            </select>
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-[#232832] pt-5">
            <div>
              <label htmlFor="default-diagram" className="text-xs font-semibold text-[#F3F4F6]">
                Default Diagram View
              </label>
              <p className="text-[11px] text-[#9CA3AF]">Select which diagram opens first in the exploration panel.</p>
            </div>
            <select
              id="default-diagram"
              value={preferences.defaultDiagramType}
              onChange={(e) => updatePreferences({ defaultDiagramType: e.target.value as DiagramType })}
              className="rounded border border-[#232832] bg-[#0B0D10] px-3 py-1.5 text-xs text-[#E6E9EF]"
            >
              <option value="system_architecture">System Architecture</option>
              <option value="data_flow">Data Flow</option>
              <option value="sequence">Sequence Diagrams</option>
              <option value="cicd_pipeline">CI/CD Pipeline</option>
              <option value="deployment">Deployment</option>
              <option value="class_diagram">Class Diagrams</option>
            </select>
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-[#232832] pt-5">
            <div>
              <div className="text-xs font-semibold text-[#F3F4F6]">Show Code Minimap</div>
              <p className="text-[11px] text-[#9CA3AF]">Display overview minimap inside the Monaco source viewer.</p>
            </div>
            <button
              type="button"
              onClick={() => updatePreferences({ showMinimap: !preferences.showMinimap })}
              className={`rounded border px-3 py-1.5 text-xs font-medium cursor-pointer ${
                preferences.showMinimap
                  ? 'border-sky-500/60 bg-sky-500/15 text-sky-300'
                  : 'border-[#232832] bg-[#0B0D10] text-[#9CA3AF]'
              }`}
            >
              {preferences.showMinimap ? 'Enabled' : 'Disabled'}
            </button>
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-[#232832] pt-5">
            <div>
              <label htmlFor="chat-retention" className="text-xs font-semibold text-[#F3F4F6]">
                Chat History Retention
              </label>
              <p className="text-[11px] text-[#9CA3AF]">
                Automatically delete your chats after this many days.
              </p>
            </div>
            <select
              id="chat-retention"
              value={preferences.chatRetentionDays}
              onChange={(e) => updatePreferences({ chatRetentionDays: Number(e.target.value) })}
              className="rounded border border-[#232832] bg-[#0B0D10] px-3 py-1.5 text-xs text-[#E6E9EF]"
            >
              <option value={0}>Keep indefinitely</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
              <option value={365}>365 days</option>
              <option value={730}>2 years</option>
              <option value={3650}>10 years</option>
            </select>
          </div>
          {preferencesError && (
            <p role="alert" className="border-t border-[#232832] pt-3 text-[11px] text-rose-300">
              {preferencesError}
            </p>
          )}

          <div className="flex items-center justify-between gap-4 border-t border-[#232832] pt-5">
            <div>
              <div className="text-xs font-semibold text-[#F3F4F6]">Commit-SHA Analysis Cache</div>
              <p className="text-[11px] text-[#9CA3AF]">
                Remove cached repository graphs from disk so the next open runs a fresh fetch and parse.
              </p>
              {cacheMessage && <p className="mt-1 text-[11px] text-sky-400">{cacheMessage}</p>}
            </div>
            <button
              type="button"
              disabled={clearing}
              onClick={() => void handleClearCache()}
              className="rounded border border-[#232832] bg-[#161A21] px-3 py-1.5 text-xs font-medium text-[#E6E9EF] hover:border-sky-500/50 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
            >
              {clearing ? 'Clearing...' : 'Clear Cache'}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
