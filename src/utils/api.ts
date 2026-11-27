export class ApiHtmlFallbackError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiHtmlFallbackError';
    this.status = status;
  }
}

const AUTH_EXPIRED_EVENT = 'codebase-tutor:auth-expired';
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let unauthorizedHandler: (() => void) | undefined;

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler;
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const entry = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!entry) return undefined;
  return decodeURIComponent(entry.slice(name.length + 1));
}

async function getCsrfToken(): Promise<string> {
  const cookieToken = readCookie('codebase_tutor_csrf');
  if (cookieToken) return cookieToken;

  const response = await fetch('/api/auth/csrf', {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  const payload = await safeJson<{ csrfToken?: string }>(response);
  if (!response.ok) {
    throw new Error('Unable to initialize request security. Please reload and try again.');
  }
  const token = readCookie('codebase_tutor_csrf') || payload.csrfToken;
  if (!token) throw new Error('CSRF token was not set. Please reload and try again.');
  return token;
}

function getRequestPath(input: RequestInfo | URL): string {
  const rawUrl =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return new URL(rawUrl, typeof window === 'undefined' ? 'http://localhost' : window.location.href).pathname;
}

function handleUnauthorized(path: string): void {
  if (
    path === '/api/auth/login' ||
    path === '/api/auth/signup' ||
    path === '/api/auth/me' ||
    path === '/api/auth/logout'
  ) {
    return;
  }
  if (unauthorizedHandler) {
    unauthorizedHandler();
    return;
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    window.location.assign('/login');
  }
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  headers.set('Accept', 'application/json');

  if (MUTATION_METHODS.has(method)) {
    headers.set('X-CSRF-Token', await getCsrfToken());
  }

  const response = await fetch(input, {
    ...init,
    method,
    credentials: 'include',
    headers,
  });

  if (response.status === 401) handleUnauthorized(getRequestPath(input));

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (response.status !== 204 && !contentType.includes('application/json') && !contentType.includes('+json')) {
    throw new ApiHtmlFallbackError(
      response.status,
      `API endpoint returned HTML instead of JSON (status ${response.status}). Please ensure the backend server is running and retry.`
    );
  }
  return response;
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
