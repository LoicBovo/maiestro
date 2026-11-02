# Maiestro

GUI to manage multiple coding agents (Claude Code, Mistral Vibe). Built with Electron, electron-vite, and Svelte.

## Requirements

- Node.js (LTS)
- npm

Install dependencies once:

```bash
npm install
```

## Development

Run the app with hot reload (dev server + Electron):

```bash
npm run dev
```

## Build and run without `npm run dev`

The app compiles to plain JavaScript in `out/`:

```bash
npm run build
```

This produces:

- `out/main/index.js` — Electron main process
- `out/preload/index.js` — preload script
- `out/renderer/` — bundled Svelte UI (HTML, CSS, JS)

The compiled app is then started with the Electron binary directly:

```bash
npx electron .
```

Equivalent alternative:

```bash
./node_modules/.bin/electron .
```

`package.json` points `"main": "./out/main/index.js"`, so Electron boots the compiled main process, which loads the UI from `out/renderer/index.html`. No dev server, no Vite, no `npm run` involved at runtime.

Note: `node_modules` must stay installed. Native/runtime dependencies such as `node-pty` are not bundled into `out/` — they are loaded from `node_modules` at runtime.

## Packaging into a standalone app (optional)

`npx electron .` still requires Node's `node_modules` to be present. To get a double-clickable `.app` (macOS) / `.exe` (Windows) that runs with nothing else installed, use a packager such as [electron-builder](https://www.electron.build/). It is not currently set up in this project.

## Other scripts

- `npm run typecheck` — type-check main/preload and renderer
- `npm run daemon` — run the daemon CLI directly
- `npm run smoke` — daemon smoke test
