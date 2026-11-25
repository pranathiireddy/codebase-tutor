import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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
import { GoogleGenAI } from '@google/genai';
import { TopNav } from '../components/TopNav';
import { useApp } from '../context/AppContext';
import type { DiagramType } from '../types/codebase';
import { ApiHtmlFallbackError, safeJson } from '../utils/api';

interface ServerKeyStatus {
  hasServerGeminiKey: boolean;
  serverGeminiRejected?: boolean;
  hasServerGithubToken: boolean;
}

interface VerifyResponse {
  gemini?: {
    valid: boolean;
    model: string;
    availableModels?: string[];
    note?: string;
    error?: string;
  };
  github?: {
    valid: boolean;
    username?: string;
    remaining?: number;
    limit?: number;
    error?: string;
  };
}

const PRESET_MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
] as const;

export function SettingsPage() {
  const {
    preferences,
    updatePreferences,
    user,
    credentials,
    updateCredentials,
    clearCredentials,
    credentialStatus,
    setCredentialStatus,
  } = useApp();

  const [cacheMessage, setCacheMessage] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const [geminiApiKey, setGeminiApiKey] = useState(credentials.geminiApiKey);
  const initialIsPreset = PRESET_MODELS.includes(
    credentials.geminiModel as (typeof PRESET_MODELS)[number]
  );
  const [modelPreset, setModelPreset] = useState<string>(
    initialIsPreset ? credentials.geminiModel : 'custom'
  );
  const [customModel, setCustomModel] = useState<string>(
    initialIsPreset ? '' : credentials.geminiModel
  );
  const [githubToken, setGithubToken] = useState(credentials.githubToken);
  const [githubDefaultOwner, setGithubDefaultOwner] = useState(credentials.githubDefaultOwner);

  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [savedBanner, setSavedBanner] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerKeyStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadServerStatus() {
      try {
        const res = await fetch('/api/settings/status');
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

  const effectiveModel =
    modelPreset === 'custom'
      ? customModel.trim() || 'gemini-4-hydrogen'
      : modelPreset;

  const syncModelSelection = (resolvedModel: string) => {
    if (PRESET_MODELS.includes(resolvedModel as (typeof PRESET_MODELS)[number])) {
      setModelPreset(resolvedModel);
      setCustomModel('');
    } else {
      setModelPreset('custom');
      setCustomModel(resolvedModel);
    }
  };

  const verifyDirectlyInBrowser = async (
    trimmedGemini: string,
    model: string,
    trimmedGithub: string
  ): Promise<VerifyResponse> => {
    const out: VerifyResponse = {};
    if (trimmedGemini) {
      const ai = new GoogleGenAI({ apiKey: trimmedGemini });
      const candidates = [model, 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'].filter(
        (v, i, arr) => arr.indexOf(v) === i
      );
      let okModel: string | null = null;
      let lastErr = 'Unable to verify Gemini API key.';
      for (const candidate of candidates) {
        try {
          await ai.models.generateContent({ model: candidate, contents: 'Reply with OK.' });
          okModel = candidate;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          if (lastErr.includes('API_KEY_INVALID') || lastErr.includes('API key not valid') || lastErr.includes('leaked')) {
            break;
          }
        }
      }
      out.gemini = okModel
        ? {
            valid: true,
            model: okModel,
            note: okModel !== model ? `Switched model from ${model} to ${okModel} for compatibility.` : undefined,
          }
        : { valid: false, model, error: lastErr.slice(0, 200) };
    }
    if (trimmedGithub) {
      try {
        const ghHeaders = {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${trimmedGithub}`,
        };
        let ghRes = await fetch('https://api.github.com/user', { headers: ghHeaders });
        if (ghRes.status === 403) {
          ghRes = await fetch('https://api.github.com/rate_limit', { headers: ghHeaders });
        }
        const rem = Number(ghRes.headers.get('x-ratelimit-remaining') ?? '0');
        const lim = Number(ghRes.headers.get('x-ratelimit-limit') ?? '0');
        if (ghRes.ok) {
          const data = (await ghRes.json()) as { login?: string };
          out.github = { valid: true, username: data.login ?? 'token', remaining: rem, limit: lim };
        } else {
          out.github = { valid: false, error: `GitHub verification returned status ${ghRes.status}.` };
        }
      } catch (err) {
        out.github = { valid: false, error: err instanceof Error ? err.message : 'GitHub request failed.' };
      }
    }
    return out;
  };

  const handleSaveAndVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setVerifyError(null);
    setSavedBanner(null);

    const trimmedGemini = geminiApiKey.trim().replace(/^["']|["']$/g, '').trim();
    const trimmedGithub = githubToken.trim().replace(/^["']|["']$/g, '').trim();
    const trimmedOwner = githubDefaultOwner.trim().replace(/^@/, '');

    setGeminiApiKey(trimmedGemini);
    setGithubToken(trimmedGithub);

    updateCredentials({
      geminiApiKey: trimmedGemini,
      geminiModel: effectiveModel,
      githubToken: trimmedGithub,
      githubDefaultOwner: trimmedOwner,
    });

    if (!trimmedGemini && !trimmedGithub) {
      setCredentialStatus({ geminiVerified: null, githubVerified: null });
      setSavedBanner('Workspace defaults applied for this browser session.');
      return;
    }

    setVerifying(true);
    try {
      let json: VerifyResponse & { error?: string };
      try {
        const res = await fetch('/api/settings/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            geminiApiKey: trimmedGemini || undefined,
            geminiModel: effectiveModel,
            githubToken: trimmedGithub || undefined,
          }),
        });
        json = await safeJson<VerifyResponse & { error?: string }>(res);
        if (!res.ok) {
          throw new Error(json.error || 'Failed to verify credentials.');
        }
      } catch (err) {
        if (err instanceof ApiHtmlFallbackError) {
          json = await verifyDirectlyInBrowser(trimmedGemini, effectiveModel, trimmedGithub);
        } else {
          throw err;
        }
      }

      if (json.gemini?.valid && json.gemini.model && json.gemini.model !== effectiveModel) {
        updateCredentials({ geminiModel: json.gemini.model });
        syncModelSelection(json.gemini.model);
      }

      setCredentialStatus({
        geminiVerified: json.gemini ? json.gemini.valid : null,
        geminiMessage: json.gemini
          ? json.gemini.valid
            ? json.gemini.note
              ? `Verified with ${json.gemini.model} (${json.gemini.note})`
              : `Verified (${json.gemini.model})`
            : json.gemini.error
          : undefined,
        githubVerified: json.github ? json.github.valid : null,
        githubMessage: json.github
          ? json.github.valid
            ? `Authenticated as @${json.github.username} (${json.github.remaining ?? 0}/${json.github.limit ?? 5000} API calls left)`
            : json.github.error
          : undefined,
      });

      if ((json.gemini && !json.gemini.valid) || (json.github && !json.github.valid)) {
        setVerifyError('One or more credentials failed verification. Review the status messages below.');
      } else {
        setSavedBanner('Credentials verified and active for Tutor Chat and GitHub repository analysis.');
      }
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Unable to verify credentials.');
    } finally {
      setVerifying(false);
    }
  };

  const handleClearKeys = () => {
    clearCredentials();
    setGeminiApiKey('');
    setModelPreset('gemini-4-hydrogen');
    setCustomModel('');
    setGithubToken('');
    setGithubDefaultOwner('');
    setVerifyError(null);
    setSavedBanner('Cleared custom API keys. Using server defaults if configured.');
  };

  const handleClearCache = async () => {
    setClearing(true);
    setCacheMessage(null);
    try {
      const res = await fetch('/api/cache/clear', { method: 'POST' });
      const json = await safeJson<{ cleared?: number }>(res);
      setCacheMessage(`Cleared ${json.cleared ?? 0} cached commit snapshot(s).`);
    } catch {
      setCacheMessage('Failed to clear cache.');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0D10] text-[#E6E9EF]">
      <TopNav />
      <main className="mx-auto max-w-2xl px-6 py-14 space-y-8">
        <header className="border-b border-[#232832] pb-5">
          <h1 className="text-2xl font-bold text-[#F9FAFB]">Workspace Settings</h1>
          <p className="mt-1 text-xs text-[#9CA3AF]">
            Configure your own Gemini API key, GitHub credentials, code viewer typography, and analysis cache.
          </p>
        </header>

        {user && (
          <section className="rounded-lg border border-[#232832] bg-[#111419] p-4 text-xs space-y-1">
            <div className="font-semibold text-[#F3F4F6]">{user.name}</div>
            <div className="text-[#9CA3AF]">{user.email} · {user.role}</div>
          </section>
        )}

        {/* Bring Your Own Gemini & GitHub Keys */}
        <section className="space-y-5 rounded-xl border border-[#232832] bg-[#111419] p-6">
          <div className="flex items-start justify-between gap-4 border-b border-[#232832] pb-4">
            <div>
              <h2 className="text-sm font-semibold text-[#F3F4F6] flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-sky-400" />
                <span>API Keys & GitHub Credentials</span>
              </h2>
              <p className="mt-1 text-[11px] leading-relaxed text-[#9CA3AF]">
                Bring your own Gemini API key for Codebase Tutor chat and your GitHub Personal Access Token for private repositories and higher API rate limits.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border border-[#232832] bg-[#0B0D10] px-3.5 py-2.5 text-[11px] text-[#9CA3AF]">
            <ShieldCheck className="h-4 w-4 text-sky-400 shrink-0 mt-0.5" />
            <div>
              Keys apply immediately for your active browser tab session (cleared when the tab closes) and are proxied via backend headers to <span className="font-mono text-[#D1D5DB]">/api/*</span>.
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

          <form onSubmit={handleSaveAndVerify} className="space-y-5">
            {/* Gemini Key & Model */}
            <div className="space-y-3">
              <div>
                <label htmlFor="gemini-api-key" className="block text-xs font-semibold text-[#F3F4F6]">
                  Gemini API Key
                </label>
                <p className="text-[11px] text-[#9CA3AF]">
                  Overrides the server Gemini key for Tutor Chat explanations. Compatible models are auto-detected on verification.
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
                    updateCredentials({ geminiApiKey: val.trim() });
                  }}
                  placeholder="AIza..."
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
                      if (next !== 'custom') {
                        updateCredentials({ geminiModel: next });
                      }
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
                        if (val.trim()) {
                          updateCredentials({ geminiModel: val.trim() });
                        }
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
                    updateCredentials({ githubToken: val.trim() });
                  }}
                  placeholder="ghp_... or github_pat_..."
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
                    updateCredentials({ githubDefaultOwner: val.trim().replace(/^@/, '') });
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
                    <span>Verifying & Applying...</span>
                  </>
                ) : (
                  <span>Verify & Apply Keys</span>
                )}
              </button>

              <button
                type="button"
                onClick={handleClearKeys}
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
