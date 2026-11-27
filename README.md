# Plupus

Plupus analyzes public GitHub repositories into source indexes, a knowledge graph, and diagrams. Authenticated users can import repositories and ask grounded questions in tutor chat.

## Requirements

- Node.js 24
- npm

## Setup

```sh
npm ci
```

Copy `.env.example` to `.env` and set any optional server credentials you need. `GEMINI_API_KEY` is used only when `ALLOW_SERVER_KEY=true`; users can save their own key in Settings.

## Run

```sh
npm run dev
```

The Express server listens on port 3000 and serves the Vite app through middleware. The featured repository is prepared in the background when the server starts.

Guests can browse the featured demo read-only. Sign in to analyze personal repositories, use tutor chat, or manage API keys. Gemini and GitHub requests are made by the server; browser-side provider fallbacks are disabled. User accounts, sessions, and encrypted provider credentials are stored in SQLite. Sessions use an HttpOnly, SameSite=Lax cookie, expire after 30 minutes idle or 7 days, and are protected by CSRF tokens. Provider keys are encrypted with AES-256-GCM and are never returned to the browser.

Chats and messages are stored per user and repository in SQLite; the server loads a bounded recent history for each question. Preferences, explored-file checkmarks, and walkthrough progress are also saved per user. Chat history is kept indefinitely by default; users can choose a retention period in Settings.

## Test and lint

```sh
npm test
npm run lint
```

`npm test` runs the Vitest suite. `npm run lint` runs the TypeScript no-emit check.

## Environment

See `.env.example` for every environment variable and its purpose, including chat-history limits. In production, set `APP_ENCRYPTION_KEY` to a base64-encoded 32-byte key and provide `ALLOWED_ORIGINS`. Generate a key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. If enabling the server Gemini key, set both `ALLOW_SERVER_KEY=true` and `GEMINI_API_KEY`.

The SQLite database defaults to `.codebase-tutor-cache/codebase-tutor.sqlite`; repository cache files are stored under `.codebase-tutor-cache/` as well. Both are excluded from Git.

To rotate the encryption key, stop the app, set `APP_ENCRYPTION_KEY_NEXT` to a newly generated base64 key, run `npm run keys:rotate`, then promote that value to `APP_ENCRYPTION_KEY`, remove `APP_ENCRYPTION_KEY_NEXT`, and restart the app. Rotation updates user API keys, OAuth state verifiers, and GitHub App installation tokens in a single database transaction. Legacy 32-byte hexadecimal keys remain readable for existing installations.

## GitHub sign-in and private repositories

GitHub sign-in is optional. Create a GitHub OAuth App and set `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `GITHUB_REDIRECT_URI` in `.env`. Configure the OAuth App's callback URL to exactly match `GITHUB_REDIRECT_URI` (for local development, `http://localhost:3000/api/auth/github/callback`). The app requests only `read:user user:email`. Set `APP_ENCRYPTION_KEY` to a random 32-byte key (base64 recommended) to enable the sign-in flow; the login button stays hidden until the required configuration is present.

Private repository access is separate from sign-in and uses a GitHub App. Create an App with **Contents: read-only** repository permission, set its App ID, slug, and private key in `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, and `GITHUB_APP_PRIVATE_KEY`, and set the App's Setup URL to the exact `GITHUB_APP_SETUP_URI` value (for local development, `http://localhost:3000/api/auth/github-app/callback`). The user explicitly authorizes this access in Settings. Installation tokens are encrypted with `APP_ENCRYPTION_KEY`, kept server-side, and revocable from Settings. Private repository analysis remains memory-only and is not written to the cache or database. The OAuth App used for sign-in does not request the `repo` scope.

Do not commit either app's credentials or private keys. `.env.example` lists the provider variables and their purpose.

Users may save a Gemini key, GitHub Personal Access Token, and default GitHub owner in Settings. These values are encrypted at rest, scoped to the signed-in user, and never sent in custom headers or returned by the API. A saved GitHub token takes precedence for that user's repository analysis; GitHub App and server-configured access remain separate fallback options.
