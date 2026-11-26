import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { DiagramType, UserProfile } from '../types/codebase';
import { apiFetch, safeJson } from '../utils/api';

export interface WorkspacePreferences {
  editorFontSize: number;
  defaultDiagramType: DiagramType;
  showMinimap: boolean;
}

export interface UserApiCredentials {
  geminiApiKey: string;
  geminiModel: string;
  githubToken: string;
  githubDefaultOwner: string;
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
  credentials: UserApiCredentials;
  updateCredentials: (partial: Partial<UserApiCredentials>) => void;
  clearCredentials: () => void;
  credentialStatus: CredentialStatus;
  setCredentialStatus: (status: CredentialStatus) => void;
}

const SESSION_CREDS_KEY = 'codebase_tutor_session_creds_v1';

const DEFAULT_CREDENTIALS: UserApiCredentials = {
  geminiApiKey: '',
  geminiModel: 'gemini-4-hydrogen',
  githubToken: '',
  githubDefaultOwner: '',
};

function loadInitialCredentials(): UserApiCredentials {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return DEFAULT_CREDENTIALS;
    const raw = window.sessionStorage.getItem(SESSION_CREDS_KEY);
    if (!raw) return DEFAULT_CREDENTIALS;
    const parsed = JSON.parse(raw) as Partial<UserApiCredentials>;
    return {
      geminiApiKey: typeof parsed.geminiApiKey === 'string' ? parsed.geminiApiKey : '',
      geminiModel:
        typeof parsed.geminiModel === 'string' && parsed.geminiModel.trim()
          ? parsed.geminiModel
          : DEFAULT_CREDENTIALS.geminiModel,
      githubToken: typeof parsed.githubToken === 'string' ? parsed.githubToken : '',
      githubDefaultOwner: typeof parsed.githubDefaultOwner === 'string' ? parsed.githubDefaultOwner : '',
    };
  } catch {
    return DEFAULT_CREDENTIALS;
  }
}

function saveSessionCredentials(creds: UserApiCredentials): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    if (!creds.geminiApiKey && !creds.githubToken && !creds.githubDefaultOwner && creds.geminiModel === DEFAULT_CREDENTIALS.geminiModel) {
      window.sessionStorage.removeItem(SESSION_CREDS_KEY);
    } else {
      window.sessionStorage.setItem(SESSION_CREDS_KEY, JSON.stringify(creds));
    }
  } catch {
    // ignore storage quota / privacy mode errors
  }
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [preferences, setPreferences] = useState<WorkspacePreferences>({
    editorFontSize: 13,
    defaultDiagramType: 'system_architecture',
    showMinimap: true,
  });
  const [credentials, setCredentials] = useState<UserApiCredentials>(loadInitialCredentials);
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus>({
    geminiVerified: null,
    githubVerified: null,
  });

  useEffect(() => {
    let cancelled = false;
    void apiFetch('/api/auth/me')
      .then(async (res) => {
        if (res.status === 401) {
          if (!cancelled) {
            setUser(null);
            setCredentials(DEFAULT_CREDENTIALS);
            saveSessionCredentials(DEFAULT_CREDENTIALS);
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

  const setSession = useCallback((nextUser: UserProfile | null) => {
    setUser(nextUser);
    setAuthLoading(false);
    setCredentials(DEFAULT_CREDENTIALS);
    saveSessionCredentials(DEFAULT_CREDENTIALS);
    setCredentialStatus({ geminiVerified: null, githubVerified: null });
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Local state is cleared even if the server is unreachable.
    }
    setUser(null);
    setCredentials(DEFAULT_CREDENTIALS);
    saveSessionCredentials(DEFAULT_CREDENTIALS);
    setCredentialStatus({ geminiVerified: null, githubVerified: null });
  }, []);

  const updatePreferences = useCallback((partial: Partial<WorkspacePreferences>) => {
    setPreferences((prev) => ({ ...prev, ...partial }));
  }, []);

  const updateCredentials = useCallback((partial: Partial<UserApiCredentials>) => {
    setCredentials((prev) => {
      const next = { ...prev, ...partial };
      saveSessionCredentials(next);
      return next;
    });
  }, []);

  const clearCredentials = useCallback(() => {
    setCredentials(DEFAULT_CREDENTIALS);
    saveSessionCredentials(DEFAULT_CREDENTIALS);
    setCredentialStatus({ geminiVerified: null, githubVerified: null });
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
        credentials,
        updateCredentials,
        clearCredentials,
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
