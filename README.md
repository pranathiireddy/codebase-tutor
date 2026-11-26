# Codebase Tutor

Codebase Tutor analyzes public GitHub repositories into source indexes, a knowledge graph, and diagrams. Authenticated users can import repositories and ask grounded questions in tutor chat.

## Requirements

- Node.js 24
- npm

## Setup

```sh
npm ci
```

Copy `.env.example` to `.env` and set any optional credentials you need. `GEMINI_API_KEY` is used only when `ALLOW_SERVER_KEY=true`; otherwise users provide their own key in Settings.

## Run

```sh
npm run dev
```

The Express server listens on port 3000 and serves the Vite app through middleware. The featured repository is prepared in the background when the server starts.

Guests can browse the featured demo read-only. Sign in to analyze personal repositories, use tutor chat, or manage API keys. Gemini and GitHub requests are made by the server; browser-side provider fallbacks are disabled. User accounts and sessions are stored in SQLite. Sessions use an HttpOnly, SameSite=Lax cookie, expire after 30 minutes idle or 7 days, and are protected by CSRF tokens. Custom provider credentials remain in the active browser tab session.

Chats and messages are stored per user and repository in SQLite; the server loads a bounded recent history for each question. Preferences, explored-file checkmarks, and walkthrough progress are also saved per user. Chat history is kept indefinitely by default; users can choose a retention period in Settings.

## Test and lint

```sh
npm test
npm run lint
```

`npm test` runs the Vitest suite. `npm run lint` runs the TypeScript no-emit check.

## Environment

See `.env.example` for every environment variable and its purpose, including chat-history limits. In production, set `APP_ENCRYPTION_KEY` to a 32-byte hexadecimal value and provide `ALLOWED_ORIGINS`. If enabling the server Gemini key, set both `ALLOW_SERVER_KEY=true` and `GEMINI_API_KEY`.

The SQLite database defaults to `.codebase-tutor-cache/codebase-tutor.sqlite`; repository cache files are stored under `.codebase-tutor-cache/` as well. Both are excluded from Git.
