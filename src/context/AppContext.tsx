import React, { createContext, useContext, useState, useCallback } from 'react';
import type { DiagramType, UserProfile } from '../types/codebase';

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
  authToken: string | null;
  setSession: (user: UserProfile | null, token: string | null) => void;
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
  const [authToken, setAuthToken] = useState<string | null>(null);
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

  const setSession = useCallback((nextUser: UserProfile | null, nextToken: string | null) => {
    setUser(nextUser);
    setAuthToken(nextToken);
  }, []);

  const logout = useCallback(async () => {
    if (authToken) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
        });
      } catch {
        // ignore network error on logout
      }
    }
    setUser(null);
    setAuthToken(null);
  }, [authToken]);

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
        authToken,
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
