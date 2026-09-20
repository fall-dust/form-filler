import { app, BrowserWindow, ipcMain, clipboard } from 'electron'
import { isAbsolute, join } from 'path'
import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync } from 'fs'
import {
  runFill,
  getLiveSession,
  setSession,
  closeSession,
  ensureSession,
  grabCurrentHtml,
  waitForGrabReady,
  readyHint,
  detectNextButtons,
  clickNextButton,
  type FillRequest,
  type LaunchConfig,
  type NextButton
} from './fill-engine'
import { createTaskStore, registerTaskHandlers, type MigrationReport, type TaskStore } from './tasks'

let mainWindow: BrowserWindow | null = null
let store: TaskStore | null = null

/** 启动期一次性提示（旧数据迁移、回收站清理），由渲染进程在挂载时拉取 */
let startupNotice: { migrated: MigrationReport | null; trashCleaned: number } | null = null

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
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
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

// 每次运行独立状态（支持多任务并发）。
// cancel() 用于「停止」随时打断启动/导航这类没有中间检查点的长等待；
// flag 供引擎在题目之间、题目内部的各步之间轮询。
interface RunState {
  flag: boolean
  cancel: () => void
}
const runs = new Map<string, RunState>()

/**
 * 每个任务一个固定的浏览器 profile 目录 —— **登录态就存在这里**。
 *
 * 用持久化 profile 而不是「暂停等你粘贴登录链接」：登录一次长期有效，
 * 窗口关掉、点过结束会话、改过目标链接，都还会带着 cookie 重开。
 * 放在 userData 下（不随导出外传，profile 里有敏感 cookie）。
 */
function profileDir(taskId: string): string {
  return join(app.getPath('userData'), 'profile', taskId)
}

/** 会话状态变化推送给界面（打开/结束），界面据此显示「浏览器会话」区 */
function notifySession(taskId: string, open: boolean, url?: string): void {
  mainWindow?.webContents.send('fill:session', { taskId, open, ...(url ? { url } : {}) })
}

function pageUrl(page: { url(): string }): string {
  try {
    return page.url()
  } catch {
    return ''
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 打包后浏览器解析：优先随包 chromium；若缺失（如 portable 单文件解压到临时目录时
 * extraResources 未解出）则回退系统 Edge。就地改写传入的 config。
 */
function resolveBundledBrowser(cfg: { channel?: string; executablePath?: string }): void {
  if (!app.isPackaged || cfg.channel || cfg.executablePath) return
  const bundled = join(process.resourcesPath, 'browsers', 'chromium', 'chrome-win64', 'chrome.exe')
  if (existsSync(bundled)) cfg.executablePath = bundled
  else cfg.channel = 'msedge'
}

/** 打包后看不到控制台，把异常落盘便于排查 */
function logRunError(runId: string, e: unknown): void {
  try {
    const dir = join(app.getPath('userData'), 'output')
    mkdirSync(dir, { recursive: true })
    appendFileSync(
      join(dir, 'error.log'),
      `[${new Date().toISOString()}] run=${runId}\n${e instanceof Error ? e.stack || e.message : String(e)}\n\n`,
      'utf-8'
    )
  } catch {
    /* 忽略日志写入失败 */
  }
}

ipcMain.handle('fill:run', async (event, req: FillRequest, runId: string) => {
  const sender = event.sender
  if (runs.has(runId)) {
    throw new Error('该任务正在填写中（同一个浏览器会话不能并发跑两次）。请先「停止」或等它结束。')
  }
  let cancelRun: () => void = () => {}
  const cancelled = new Promise<void>((resolve) => {
    cancelRun = resolve
  })
  runs.set(runId, { flag: false, cancel: cancelRun })
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

  // 断点续填状态文件同样归一化（界面传相对路径，落在 userData 下）
  if (normalized.config.statePath && !isAbsolute(normalized.config.statePath)) {
    normalized.config.statePath = join(app.getPath('userData'), normalized.config.statePath)
  }

  // 登录态：固定用该任务的 profile 目录（cookie 落盘，重开浏览器仍在）
  normalized.config.userDataDir = profileDir(runId)

  resolveBundledBrowser(normalized.config)
  try {
    const { report } = await runFill(normalized, {
      onProgress: (p) => sender.send('fill:progress', { runId, ...p }),
      isCancelled: () => runs.get(runId)?.flag === true,
      cancelled,
      // 多页问卷「接着填」：有存活会话就复用（不重开、不重新导航）；目标链接变了则作废旧会话
      getSession: () => {
        const s = getLiveSession(runId)
        if (!s) return null
        if (s.link !== normalized.config.link) {
          void closeSession(runId)
          notifySession(runId, false)
          return null
        }
        return s
      },
      onSessionReady: (s) => {
        setSession(runId, { ...s, link: normalized.config.link }, () => notifySession(runId, false))
        notifySession(runId, true, pageUrl(s.page))
      }
    })
    return report
  } catch (e) {
    logRunError(runId, e)
    throw e
  } finally {
    runs.delete(runId)
  }
})

ipcMain.handle('fill:stop', (_event, runId: string) => {
  const r = runs.get(runId)
  if (r) {
    r.flag = true
    // 立刻打断启动/导航赛跑；引擎在题目内部的各步之间也会看到 flag
    r.cancel()
  }
  return true
})

// ---- 浏览器会话（多页问卷「接着填」） ----

ipcMain.handle('fill:session:status', (_event, taskId: string) => {
  const s = getLiveSession(taskId)
  if (!s) return { open: false }
  return { open: true, url: pageUrl(s.page) }
})

ipcMain.handle('fill:session:close', async (_event, taskId: string) => {
  const ok = await closeSession(taskId)
  notifySession(taskId, false)
  return ok
})

/**
 * 清除登录态：关掉窗口后删掉该任务的 profile 目录。
 *
 * 换账号、或登录态坏了（比如站点改了认证方式）时才需要 —— 否则「登录一次长期有效」。
 * 必须先关会话：Chromium 持有 profile 目录锁，开着窗口删不掉。
 */
ipcMain.handle('fill:session:reset-profile', async (_event, taskId: string) => {
  if (!taskId) return { ok: false, error: '缺少任务' }
  const dir = profileDir(taskId)
  try {
    await closeSession(taskId)
    notifySession(taskId, false)
    rmSync(dir, { recursive: true, force: true })
    return { ok: true, removed: dir }
  } catch (e) {
    return { ok: false, error: `清除登录态失败（窗口可能仍占用该目录）：${errText(e)}` }
  }
})

/**
 * 启动浏览器（**只打开，不抓取**）。
 *
 * 用于「题目/答案还没生成，但想先把浏览器开起来」：可提前登录、提前翻页、提前看清页面。
 * 已有存活会话且链接未变则直接复用并把窗口置前；链接改过则关掉旧窗口按新链接重开。
 */
ipcMain.handle(
  'fill:session:open',
  async (_event, taskId: string, opts?: { link?: string; channel?: string }) => {
    const link = (opts?.link ?? '').trim()
    if (!link) return { ok: false, error: '请先在左栏填写「目标链接」' }
    // 始终有头启动：多页问卷要人自己点「下一页」、要看得到登录与填写过程
    // 登录态用该任务的持久化 profile：在这里登录过一次，之后重开浏览器不用再登
    const launch: LaunchConfig = {
      headless: false,
      userDataDir: profileDir(taskId),
      ...(opts?.channel ? { channel: opts.channel as 'chrome' | 'msedge' } : {})
    }
    resolveBundledBrowser(launch)
    try {
      const { session: s, opened } = await ensureSession(taskId, link, launch, 800, () =>
        notifySession(taskId, false)
      )
      // 复用时把已有窗口置前，让人一眼看到「就是它」
      try {
        await s.page.bringToFront()
      } catch {
        /* 置前失败无妨 */
      }
      notifySession(taskId, true, pageUrl(s.page))
      return { ok: true, opened, url: pageUrl(s.page) }
    } catch (e) {
      notifySession(taskId, false)
      return { ok: false, error: `打开目标链接失败：${errText(e)}` }
    }
  }
)

/**
 * 抓取浏览器当前页 HTML → 界面写进步骤 1（多页问卷翻页后的取页入口）。
 *
 * **只在用户明确点「抓取」时执行**，绝不在打开浏览器时顺带抓 —— 问卷多是前端渲染，
 * 刚打开就抓只会抓到空壳（用户反馈过「还没加载好就抓」）。因此这里：
 * 1. 必须有存活会话：没有就提示先点「启动浏览器」，**不自行开浏览器**；
 * 2. 抓之前先等页面真正长好（`waitForGrabReady`），没长好就如实报错而不是抓回空壳；
 * 3. 覆盖前把旧 HTML + 当时的题目自动存为历史版本（`pre-grab`），第一次的记录不会丢。
 * 纯读取：不点按钮、不提交、不导航；需要登录时窗口就在那里，人工登录后再抓一次。
 */
ipcMain.handle(
  'fill:session:grab',
  async (_event, taskId: string, opts?: { link?: string; waitMs?: number }) => {
    const link = (opts?.link ?? '').trim()
    const s = getLiveSession(taskId)
    if (!s) {
      return {
        ok: false,
        error:
          '浏览器还没打开：先点「启动浏览器」打开目标页面（需要登录就先登录），看到要采集的页面后再抓取'
      }
    }
    // 目标链接改过 → 旧窗口作废（与运行路径一致，避免在错误页面上采集）
    if (link !== '' && s.link !== link) {
      await closeSession(taskId)
      notifySession(taskId, false)
      return { ok: false, error: '目标链接已改，旧窗口已关闭：请点「启动浏览器」打开新链接后再抓取' }
    }

    const ready = await waitForGrabReady(s.page, opts?.waitMs ?? 15000)
    if (!ready.ok) {
      if (ready.closed) notifySession(taskId, false)
      return { ok: false, error: readyHint(ready) }
    }

    try {
      const r = await grabCurrentHtml(s.page)
      // 覆盖前存档：旧 HTML 连同当时的题目进历史版本（无可存内容时自动跳过）
      const archived = store?.createSnapshot(taskId, 'pre-grab', {
        withHtml: true,
        skipIfEmpty: true
      })
      // 顺手识别「下一页」按钮：抓完这一页，界面上就能直接点它翻页（失败不影响抓取结果）
      const next = await detectNextButtons(s.page).catch((): NextButton[] => [])
      notifySession(taskId, true, r.url)
      return { ok: true, html: r.html, url: r.url, frames: r.frames, archived: !!archived, next }
    } catch (e) {
      return { ok: false, error: errText(e) }
    }
  }
)

/**
 * 识别存活页面里的「下一页」按钮（只读，不点任何东西）。
 *
 * 供界面在「刚打开浏览器」「用户自己翻页之后」刷新候选列表；抓取时也会顺带识别一次，
 * 那条路径不必再调这里。
 */
ipcMain.handle('fill:session:next', async (_event, taskId: string) => {
  const s = getLiveSession(taskId)
  if (!s) return { ok: false, error: '浏览器还没打开：先点「启动浏览器」', next: [] as NextButton[] }
  try {
    const next = await detectNextButtons(s.page)
    return { ok: true, next }
  } catch (e) {
    return { ok: false, error: errText(e), next: [] as NextButton[] }
  }
})

/**
 * 在浏览器里点某个「下一页」按钮，然后等新页面长好。
 *
 * 点击**只在用户明确点界面上的 chip 时**发生；识别阶段已把「提交/完成/返回/上一步」
 * 这类文字排除在外，这里不再做第二次判断（用户点的是哪一个就点哪一个）。
 * 点完不在这里抓取 —— 抓取走原来的 fill:session:grab（存档、识别、通知都在那条路上）。
 */
ipcMain.handle(
  'fill:session:click-next',
  async (_event, taskId: string, target: { selector?: string; text?: string; frameUrl?: string }) => {
    const s = getLiveSession(taskId)
    if (!s) return { ok: false, error: '浏览器还没打开：先点「启动浏览器」' }
    const r = await clickNextButton(s.page, target ?? {})
    if (!r.ok) return { ok: false, error: r.error }
    // 翻页后新页要重新渲染，等它长好再说 —— 否则紧接着的抓取会抓到空壳
    const ready = await waitForGrabReady(s.page, 15000)
    notifySession(taskId, true, pageUrl(s.page))
    return {
      ok: true,
      strategy: r.strategy,
      url: r.url,
      ready: ready.ok,
      readyHint: ready.ok ? undefined : readyHint(ready)
    }
  }
)

ipcMain.handle('clipboard:write', (_event, text: string) => {
  clipboard.writeText(text)
  return true
})

// ---- 截图读取（内嵌预览） ----
ipcMain.handle('screenshot:read', (_event, path: string) => {
  if (!path || !existsSync(path)) return null
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`
})

// ---- 启动期提示（迁移 / 回收站清理） ----
ipcMain.handle('app:startupNotice', () => startupNotice)

// ---- 单实例锁：两个实例共用同一份 userData 会互踩任务配置（实测把目标链接写脏过）----
// 第二次启动直接退出，并把已有窗口拉到前台
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(() => {
  // 任务存储：构造即完成崩溃残留清理与索引重建
  store = createTaskStore(app.getPath('userData'), {
    onSaveState: (e) => mainWindow?.webContents.send('tasks:state', e),
    onChanged: () => mainWindow?.webContents.send('tasks:changed')
  })
  registerTaskHandlers({
    store,
    getWindow: () => mainWindow,
    broadcast: (channel, payload) => {
      mainWindow?.webContents.send(channel, payload)
    }
  })

  // 旧 projects/ 迁移（只跑一次）与回收站过期清理
  const migrated = store.migrateFromProjects()
  const trashCleaned = store.cleanExpiredTrash()
  if (migrated || trashCleaned > 0) startupNotice = { migrated, trashCleaned }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 退出前把防抖中未落盘的改动同步写完，避免丢最后一段输入
app.on('before-quit', () => {
  try {
    store?.flush()
  } catch {
    /* 退出流程不阻塞 */
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
