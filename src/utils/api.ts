export interface ApiCredentialHeaders {
  geminiApiKey?: string;
  geminiModel?: string;
  githubToken?: string;
}

export class ApiHtmlFallbackError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiHtmlFallbackError';
    this.status = status;
  }
}

export function buildApiHeaders(
  creds?: ApiCredentialHeaders,
  extra?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (creds?.geminiApiKey?.trim()) {
    headers['x-gemini-api-key'] = creds.geminiApiKey.trim();
  }
  if (creds?.geminiModel?.trim()) {
    headers['x-gemini-model'] = creds.geminiModel.trim();
  }
  if (creds?.githubToken?.trim()) {
    headers['x-github-token'] = creds.githubToken.trim();
  }
  return headers;
}

export async function safeJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    throw new Error(`Server returned an empty response (status ${res.status}).`);
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    throw new ApiHtmlFallbackError(
      res.status,
      `API endpoint returned HTML instead of JSON (status ${res.status}). Please ensure the backend server is running and retry.`
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON response from server (status ${res.status}).`);
  }
}
