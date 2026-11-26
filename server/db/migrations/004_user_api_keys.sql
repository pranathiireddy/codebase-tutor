CREATE TABLE user_api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('gemini', 'github', 'github_owner')),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  last4 TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE (user_id, provider)
);

CREATE INDEX user_api_keys_user_id_idx ON user_api_keys(user_id);
