# BirthdayBot Panel (desktop)

Electron + React app for moderators. It talks to the bot only through `/api/v2` on the App Service; it is not deployed with the bot.

## Run

```bash
cd desktop
npm install
npm run dev      # Vite dev server + Electron with hot reload
npm start        # production build of the UI, then Electron
```

By default the app uses the production server. For a local bot set `PANEL_API_URL`, e.g. `PANEL_API_URL=http://localhost:3000 npm run dev`.

## Login

1. **Войти через Discord** opens the system browser on `<server>/api/v2/auth/login`.
2. After Discord login the page hands a one-time code back to the app through the `birthdaybot-panel://` link (the app registers this protocol on first start).
3. The app exchanges the code (PKCE-protected) for a session token, stored encrypted with Electron `safeStorage`. Sessions last 30 days.

## Structure

- `electron/main.js` — window, deep-link handling, IPC
- `electron/api.js` — HTTP + SSE client (runs in the main process; the token never reaches the UI)
- `electron/preload.js` — the `window.panel` bridge, the UI's only access to the outside
- `renderer/` — React UI (stage 2a skeleton: queue and journal)

Installer builds (electron-builder) and auto-update are planned for stage 2b.
