const SECRET_PATTERNS = [
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgho_[A-Za-z0-9_]{20,}\b/g,
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, '[REDACTED]'), value);
}

export function redactErrorFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactErrorFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      (key === 'error' || key === 'message') && typeof child === 'string'
        ? redactSecrets(child)
        : redactErrorFields(child),
    ])
  );
}
