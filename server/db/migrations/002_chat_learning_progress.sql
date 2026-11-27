CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX chats_user_repository_updated_idx
  ON chats(user_id, repository_id, updated_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  context_label TEXT,
  citations_json TEXT,
  confidence_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_chat_created_idx ON messages(chat_id, created_at DESC, id DESC);

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  editor_font_size INTEGER NOT NULL DEFAULT 13 CHECK (editor_font_size BETWEEN 12 AND 15),
  default_diagram_type TEXT NOT NULL DEFAULT 'system_architecture',
  show_minimap INTEGER NOT NULL DEFAULT 1 CHECK (show_minimap IN (0, 1)),
  chat_retention_days INTEGER NOT NULL DEFAULT 0 CHECK (chat_retention_days BETWEEN 0 AND 3650),
  updated_at INTEGER NOT NULL
);

CREATE TABLE explored_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  visited_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repository_id, node_id)
);
CREATE INDEX explored_items_user_repository_idx ON explored_items(user_id, repository_id);

CREATE TABLE tour_progress (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  tour_id TEXT NOT NULL,
  step_index INTEGER NOT NULL CHECK (step_index >= 0),
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repository_id, tour_id, step_index)
);
CREATE INDEX tour_progress_user_repository_idx ON tour_progress(user_id, repository_id);
