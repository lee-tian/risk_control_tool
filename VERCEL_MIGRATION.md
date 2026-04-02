# Vercel Migration Notes

This project now supports a storage adapter so Docker and Vercel can use different persistence backends without forking the API logic.

## Current behavior

- Docker / local API:
  - `APP_STORAGE_DRIVER=file`
  - Persists to `data/app-state.json` and `data/vix-cache.json`
- Future Vercel deployment:
  - `APP_STORAGE_DRIVER=kv`
  - Persists to KV via REST

## Required Vercel environment variables

- `APP_STORAGE_DRIVER=kv`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `APP_STATE_KV_KEY` (optional, defaults to `risk-tool:app-state`)
- `VIX_CACHE_KV_KEY` (optional, defaults to `risk-tool:vix-cache`)
- `GEMINI_API_KEY`
- `TWELVE_DATA_API_KEY`
- `MARKETDATA_TOKEN`

## Migration path

1. Keep Docker deployment unchanged.
2. Move HTTP route logic into shared handlers that can be used by both:
   - the existing Node server
   - Vercel Functions
3. Add Vercel function entrypoints that call the shared handlers.
4. Point the frontend `/api/*` traffic to the Vercel Functions in the Vercel deployment.

## Important note

The storage layer is now Vercel-ready, but the current `api/server.mjs` is still a long-running Node server entrypoint for Docker. The next migration step is to add Vercel function wrappers around the same business logic.
