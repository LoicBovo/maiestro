/// <reference types="electron-vite/node" />
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from './daemon/daemon'
import { listProjectPRs } from './daemon/prs'
import type { SpawnOptions } from './daemon/types'

// electron-vite copies the file into `out/main/` at build time and rewrites
// the import to a path that stays valid inside a packaged .app bundle.
import logoPath from '../src/assets/logo.png?asset'

const LOGO_PATH = logoPath

// In dev the app runs inside the stock Electron.app bundle, whose default
// name and icon are Electron's. Override the app name (drives the default
// application menu) and the macOS Dock icon at runtime; the BrowserWindow
// `icon` option below covers Linux/Windows.
app.setName('Maiestro')

let win: BrowserWindow | null = null
let daemon: Daemon | null = null
// Agent to reveal when the renderer is ready; set by a notification click.
let pendingFocusAgentId: string | null = null
// Guards the async shutdown against the second before-quit app.exit() skips.
let quitting = false

function notify(title: string, body: string, urgent = false, agentId?: string): void {
  if (Notification.isSupported()) {
    const n = new Notification({ title, body })
    n.on('click', () => showWindow(agentId))
    n.show()
  } else {
    console.log('[notify]', title, '—', body)
  }
  // OS notifications can be silently dropped (macOS never asked / Focus): also
  // grab attention through the Dock, which needs no authorization. Critical
  // bounces until the app is activated; informational bounces once.
  if (process.platform === 'darwin' && app.dock && !win?.isFocused()) {
    app.dock.bounce(urgent ? 'critical' : 'informational')
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 840,
    minWidth: 1080,
    minHeight: 600,
    title: 'Maiestro',
    icon: LOGO_PATH,
    backgroundColor: '#0e1014',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
    },
  })
  if (process.env.ELECTRON_VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.ELECTRON_VITE_DEV_SERVER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  // A notification clicked while the window was closed queued an agent to
  // reveal; the renderer can only receive it once its listeners are up.
  win.webContents.on('did-finish-load', () => sendAgentFocus())
  win.on('closed', () => {
    win = null
  })
}

function sendAgentFocus(): void {
  if (pendingFocusAgentId && win && !win.isDestroyed()) {
    win.webContents.send('agent:focus', pendingFocusAgentId)
    pendingFocusAgentId = null
  }
}

function showWindow(agentId?: string): void {
  if (agentId) pendingFocusAgentId = agentId
  if (win) {
    win.show()
    win.focus()
    sendAgentFocus()
  } else {
    createWindow()
  }
}

function registerIpc(d: Daemon): void {
  ipcMain.handle('agents:list', () => d.registry.listAgents())
  ipcMain.handle('agents:spawn', (_e, opts: SpawnOptions) => d.spawnAgent(opts))
  ipcMain.handle('agents:stop', (_e, id: string) => d.stopAgent(id))
  ipcMain.handle(
    'agents:resume',
    (_e, id: string, message?: string, options?: SpawnOptions['options']) =>
      d.resumeAgent(id, message, options),
  )
  ipcMain.handle(
    'agents:permission',
    (_e, agentId: string, toolUseId: string, decision: 'allow' | 'deny', message?: string) =>
      d.decidePermission(agentId, toolUseId, decision, message),
  )
  ipcMain.handle('agents:events', (_e, id: string) => d.getEvents(id))
  ipcMain.handle('agents:remove', (_e, id: string) => d.removeAgent(id))
  ipcMain.handle('agents:rename', (_e, id: string, name: string) => d.renameAgent(id, name))
  ipcMain.handle('terminal:attach', (_e, id: string) => d.attachTerminal(id))
  ipcMain.handle('terminal:write', (_e, id: string, data: string) => d.writeTerminal(id, data))
  ipcMain.handle('terminal:resize', (_e, id: string, cols: number, rows: number) =>
    d.resizeTerminal(id, cols, rows),
  )
  ipcMain.handle('projects:list', () => d.listProjects())
  ipcMain.handle(
    'projects:create',
    (_e, name: string, dirs: string[], preferredTool: string | null) => d.createProject(name, dirs, preferredTool),
  )
  ipcMain.handle(
    'projects:update',
    (_e, id: string, dirs: string[], preferredTool: string | null) =>
      d.updateProject(id, dirs, preferredTool),
  )
  ipcMain.handle('projects:delete', (_e, id: string) => d.deleteProject(id))
  ipcMain.handle('projects:open-prs', async (_e, id: string) => {
    const project = d.registry.getProject(id)
    if (!project) throw new Error('project not found')
    return listProjectPRs(project)
  })
  ipcMain.handle('shell:open-external', (_e, url: string) => {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(url)
  })
  ipcMain.handle('dialog:pick-directory', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(LOGO_PATH)
  }
  daemon = new Daemon({
    dataDir: process.env.MAIESTRO_HOME ?? join(homedir(), '.maiestro'),
    notify,
    onAgentsChanged: (agents) => win?.webContents.send('agents:changed', agents),
    onAgentEvent: (ev) => win?.webContents.send('agent:event', ev),
    onProjectsChanged: (projects) => win?.webContents.send('projects:changed', projects),
    onTerminalData: (agentId, data, seq) => win?.webContents.send('terminal:data', agentId, data, seq),
  })
  await daemon.start()
  registerIpc(daemon)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// The daemon (and the agents it supervises) outlives the window: closing the
// window just hides it; quitting the app stops the agents.
app.on('window-all-closed', () => {
  // keep running
})

app.on('before-quit', (e) => {
  // stopAll persists where the shell panes were left, which takes a moment
  // (lsof + git per pane). Hold the quit open until it is done — quitting
  // right away would race the persistence and lose the recorded cwds.
  if (quitting) return
  e.preventDefault()
  quitting = true
  const stopped = daemon ? daemon.stopAll() : Promise.resolve()
  void stopped
    .catch(() => {
      // persistence failures must not block quitting
    })
    .then(() => app.exit(0))
})
