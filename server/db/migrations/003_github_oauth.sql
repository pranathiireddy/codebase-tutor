ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE oauth_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'github'),
  provider_user_id TEXT NOT NULL,
  provider_login TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  UNIQUE (provider, provider_user_id),
  UNIQUE (user_id, provider)
);
CREATE INDEX oauth_accounts_user_id_idx ON oauth_accounts(user_id);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  code_verifier_enc TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'link', 'private_install')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  redirect_after TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX oauth_states_expires_at_idx ON oauth_states(expires_at);

CREATE TABLE github_app_installations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  account_login TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (user_id, installation_id)
);
CREATE INDEX github_app_installations_user_id_idx ON github_app_installations(user_id);
