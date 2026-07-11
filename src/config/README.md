# config — Configuration

Transport/process configuration, environment-aware. Owns:

- Environment detection (`NODE_ENV`) and `.env` loading for development
- Resolving server (port/host), CORS, and logging settings from environment
  variables with dev-vs-prod-appropriate defaults (`index.ts`)

This is **not** for gameplay tunables — those live in `data/balance.ts`.
