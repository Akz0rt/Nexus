# BirthdayBot Panel (desktop)

Electron + React app for moderators. It talks to the bot only through `/api/v2` on the App Service; it is not deployed with the bot.

## Install (moderators)

1. Open the repository's **Releases** page and download `BirthdayBot-Panel-Setup-<version>.exe` from the latest release.
2. Run it. The installer isn't code-signed, so Windows may show "Windows protected your PC" → **More info** → **Run anyway**.
3. Click **Войти через Discord**. Access is granted by Discord permissions on the server: Administrator, Manage Roles or Kick Members.

The installed app checks for updates on start and every 6 hours, downloads them in the background and offers **Перезапустить и обновить**.

## Release a new version

Push a tag — GitHub Actions (`.github/workflows/desktop-release.yml`) builds the installer and publishes the release:

```bash
git tag desktop-v0.3.0
git push origin desktop-v0.3.0
```

The version in `package.json` is taken from the tag at build time.

## Develop

```bash
cd desktop
npm install
npm run dev      # Vite dev server + Electron with hot reload
npm start        # production build of the UI, then Electron
npm run dist     # local installer in release/ (not published)
```

By default the app uses the production server. For a local bot set `PANEL_API_URL`, e.g. `PANEL_API_URL=http://localhost:3000 npm run dev`. `npm run icon` regenerates the icon.

## Login

1. **Войти через Discord** opens the system browser on `<server>/api/v2/auth/login`.
2. After Discord login the page hands a one-time code back to the app through the `birthdaybot-panel://` link (registered by the installer, or on first start in dev).
3. The app exchanges the code (PKCE-protected) for a session token, stored encrypted with Electron `safeStorage`. Sessions last 30 days.

## Structure

- `electron/main.js` — window, tray, deep links, notifications, auto-update, IPC
- `electron/api.js` — HTTP + SSE client (runs in the main process; the token never reaches the UI)
- `electron/preload.js` — the `window.panel` bridge, the UI's only access to the outside
- `electron/settings.js` — local preferences (notifications, close to tray)
- `renderer/` — React UI: queue of passes, journal, member drawer, search
