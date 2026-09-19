import { app, BrowserWindow, ipcMain, clipboard } from 'electron'
import { isAbsolute, join } from 'path'
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
  appendFileSync
} from 'fs'
import { runFill, type FillRequest } from './fill-engine'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    show: false,
    autoHideMenuBar: true,
    title: '表单填写器',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // dev 下由 electron-vite 注入渲染进程 dev server 地址
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- IPC（renderer 通过 preload 暴露的 window.api 调用） ----

// 每次运行独立状态（支持多任务并发）
const runs = new Map<string, boolean>()
const loginResolvers = new Map<string, (url: string | null) => void>()

ipcMain.handle('fill:run', async (event, req: FillRequest, runId: string) => {
  const sender = event.sender
  runs.set(runId, false)
  // 输出目录归一化为绝对路径（相对 userData）
  const normalized: FillRequest = {
    ...req,
    config: {
      ...req.config,
      outputDir: isAbsolute(req.config.outputDir)
        ? req.config.outputDir
        : join(app.getPath('userData'), req.config.outputDir)
    }
  }

  // 浏览器解析：优先随包 chromium；若缺失（如 portable 单文件解压到临时目录时 extraResources 未解出）则回退系统 Edge
  if (app.isPackaged && !normalized.config.channel) {
    const bundled = join(process.resourcesPath, 'browsers', 'chromium', 'chrome-win64', 'chrome.exe')
    if (existsSync(bundled)) {
      normalized.config.executablePath = bundled
    } else {
      normalized.config.channel = 'msedge'
    }
  }
  try {
    const { report } = await runFill(normalized, {
      onProgress: (p) => sender.send('fill:progress', { runId, ...p }),
      isCancelled: () => runs.get(runId) === true,
      onNeedLogin: (currentUrl) =>
        new Promise<string | null>((resolve) => {
          loginResolvers.set(runId, resolve)
          sender.send('fill:need-login', runId, currentUrl)
        })
    })
    return report
  } catch (e) {
    // 打包后看不到控制台，落盘错误日志便于排查
    try {
      const dir = join(app.getPath('userData'), 'output')
      mkdirSync(dir, { recursive: true })
      appendFileSync(
        join(dir, 'error.log'),
        `[${new Date().toISOString()}] run=${runId}\n${e instanceof Error ? (e.stack || e.message) : String(e)}\n\n`,
        'utf-8'
      )
    } catch {
      /* 忽略日志写入失败 */
    }
    throw e
  } finally {
    runs.delete(runId)
    loginResolvers.delete(runId)
  }
})

ipcMain.handle('fill:stop', (_event, runId: string) => {
  runs.set(runId, true)
  return true
})

ipcMain.handle('fill:login-link', (_event, runId: string, url: string | null) => {
  const resolve = loginResolvers.get(runId)
  if (resolve) {
    loginResolvers.delete(runId)
    resolve(url)
  }
  return true
})

ipcMain.handle('clipboard:write', (_event, text: string) => {
  clipboard.writeText(text)
  return true
})

// ---- 截图读取（内嵌预览） ----
ipcMain.handle('screenshot:read', (_event, path: string) => {
  if (!path || !existsSync(path)) return null
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`
})

// ---- 项目持久化（多套配置） ----
function sanitizeProjectName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 64)
}

function projectDir(name: string): string {
  return join(app.getPath('userData'), 'projects', sanitizeProjectName(name))
}

ipcMain.handle('projects:list', () => {
  const dir = join(app.getPath('userData'), 'projects')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
})

ipcMain.handle('projects:save', (_event, name: string, data: unknown) => {
  const dir = projectDir(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'project.json'), JSON.stringify(data, null, 2), 'utf-8')
  return true
})

ipcMain.handle('projects:load', (_event, name: string) => {
  const p = join(projectDir(name), 'project.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf-8'))
})

ipcMain.handle('projects:delete', (_event, name: string) => {
  rmSync(projectDir(name), { recursive: true, force: true })
  return true
})

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
