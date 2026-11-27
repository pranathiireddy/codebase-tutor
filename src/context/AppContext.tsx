import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { DiagramType, UserProfile } from '../types/codebase';
import { apiFetch, safeJson } from '../utils/api';

export interface WorkspacePreferences {
  editorFontSize: number;
  defaultDiagramType: DiagramType;
  showMinimap: boolean;
  chatRetentionDays: number;
}

export interface CredentialStatus {
  geminiVerified: boolean | null;
  geminiMessage?: string;
  githubVerified: boolean | null;
  githubMessage?: string;
}

interface AppContextValue {
  user: UserProfile | null;
  authLoading: boolean;
  setSession: (user: UserProfile | null) => void;
  logout: () => Promise<void>;
  preferences: WorkspacePreferences;
  updatePreferences: (partial: Partial<WorkspacePreferences>) => void;
  preferencesError: string | null;
  credentialStatus: CredentialStatus;
  setCredentialStatus: (status: CredentialStatus) => void;
}

const SESSION_CREDS_KEY = 'codebase_tutor_session_creds_v1';

const DEFAULT_PREFERENCES: WorkspacePreferences = {
  editorFontSize: 13,
  defaultDiagramType: 'system_architecture',
  showMinimap: true,
  chatRetentionDays: 0,
};

const AppContext = createContext<AppContextValue | undefined>(undefined);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [preferences, setPreferences] = useState<WorkspacePreferences>(DEFAULT_PREFERENCES);
  const [preferencesOwner, setPreferencesOwner] = useState<string | null>(null);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus>({
    geminiVerified: null,
    githubVerified: null,
  });

  useEffect(() => {
    try {
      window.sessionStorage.removeItem(SESSION_CREDS_KEY);
    } catch {
      // Storage may be unavailable in restricted browser contexts.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void apiFetch('/api/auth/me')
      .then(async (res) => {
        if (res.status === 401) {
          if (!cancelled) {
            setUser(null);
            setCredentialStatus({ geminiVerified: null, githubVerified: null });
          }
          return { user: undefined };
        }
        return safeJson<{ user?: UserProfile }>(res);
      })
      .then((response) => {
        if (!cancelled && response.user) {
          setUser(response.user);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setAuthLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPreferencesOwner(null);
    if (!user) {
      setPreferences(DEFAULT_PREFERENCES);
      setPreferencesError(null);
      return;
    }

    void apiFetch('/api/preferences')
      .then(async (res) => {
        const payload = await safeJson<{ preferences?: WorkspacePreferences; error?: string }>(res);
        if (!res.ok || !payload.preferences) {
          throw new Error(payload.error || 'Unable to load your preferences.');
        }
        if (!cancelled) {
          setPreferences(payload.preferences);
          setPreferencesOwner(user.id);
          setPreferencesError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPreferencesError(error instanceof Error ? error.message : 'Unable to load your preferences.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user || preferencesOwner !== user.id) return;
    const timer = setTimeout(() => {
      void apiFetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preferences),
      })
        .then(async (res) => {
          const payload = await safeJson<{ error?: string }>(res);
          if (!res.ok) throw new Error(payload.error || 'Unable to save your preferences.');
          setPreferencesError(null);
        })
        .catch((error: unknown) => {
          setPreferencesError(error instanceof Error ? error.message : 'Unable to save your preferences.');
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [preferences, preferencesOwner, user]);

  const setSession = useCallback((nextUser: UserProfile | null) => {
    setUser(nextUser);
    setAuthLoading(false);
    setCredentialStatus({ geminiVerified: null, githubVerified: null });
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Local state is cleared even if the server is unreachable.
    }
    setUser(null);
    setCredentialStatus({ geminiVerified: null, githubVerified: null });
  }, []);

  const updatePreferences = useCallback((partial: Partial<WorkspacePreferences>) => {
    setPreferences((prev) => ({ ...prev, ...partial }));
  }, []);

  return (
    <AppContext.Provider
      value={{
        user,
        authLoading,
        setSession,
        logout,
        preferences,
        updatePreferences,
        preferencesError,
        credentialStatus,
        setCredentialStatus,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return ctx;
}
