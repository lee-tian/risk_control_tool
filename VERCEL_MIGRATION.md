# Vercel Migration Notes

This project now supports a storage adapter so Docker and Vercel can use different persistence backends without forking the API logic.

## Current behavior

- Docker / local API:
  - `APP_STORAGE_DRIVER=sqlite` by default
  - Persists local state to `data/risk-tool.sqlite`
- Vercel deployment:
  - `APP_STORAGE_DRIVER=blob-json`
  - Persists the same JSON payloads to Vercel Blob
  - Current implementation uses public blob access because the server-side SDK path in this project writes through `put()`

## Required Vercel environment variables

- `APP_STORAGE_DRIVER=blob-json`
- `BLOB_READ_WRITE_TOKEN`
- `APP_STATE_BLOB_PATH` (optional, defaults to `risk-tool/app-state.json`)
- `VIX_CACHE_BLOB_PATH` (optional, defaults to `risk-tool/vix-cache.json`)
- `GEMINI_API_KEY`
- `TWELVE_DATA_API_KEY`
- `MARKETDATA_TOKEN`

## Migration path

1. Keep Docker deployment on sqlite.
2. HTTP route logic is shared by both:
   - the existing Node server (`api/server.mjs`)
   - the Vercel Function wrapper (`vercel/api.mjs`)
3. Vercel routes `/api/*` traffic to the function wrapper and serves the Vite SPA from `dist`.
4. GitHub Actions can call the deployed cron endpoint every 10 minutes for background refresh.

## Important note

The storage selector lazy-loads the selected adapter. This keeps the Docker/local SQLite adapter available without requiring Vercel's serverless runtime to load `node:sqlite` when `APP_STORAGE_DRIVER=blob-json`.
