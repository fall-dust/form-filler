/**
 * 任务存储的 IPC 层：把 TaskStore 暴露给渲染进程，并处理需要系统对话框的导入/导出。
 * 约定：所有返回给渲染进程的数据都是纯 JSON，不含内部路径。
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import type {
  ExportFile,
  PageInput,
  PagePatch,
  SnapshotLabel,
  TaskPatch,
  TaskStoreSettings
} from './types'
import type { TaskStore } from './store'

export interface TaskIPCContext {
  store: TaskStore
  getWindow: () => BrowserWindow | null
  broadcast: (channel: string, payload?: unknown) => void
}

const EXPORT_FORMAT = 'form-filler-task'

function safeFileName(s: string): string {
  return (s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'tasks').slice(0, 60)
}

function localStamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

export function registerTaskHandlers(ctx: TaskIPCContext): void {
  const { store, getWindow } = ctx

  // ---- 任务 CRUD ----
  ipcMain.handle('tasks:list', () => store.list())
  ipcMain.handle('tasks:get', (_e, id: string) => store.get(id))
  ipcMain.handle('tasks:create', (_e, name?: string) => store.create(name))
  ipcMain.handle('tasks:patch', (_e, id: string, patch: TaskPatch) => store.patch(id, patch))
  ipcMain.handle('tasks:rename', (_e, id: string, name: string, autoName?: boolean) =>
    store.rename(id, name, autoName === true)
  )
  ipcMain.handle('tasks:duplicate', (_e, id: string, withHtml?: boolean) =>
    store.duplicate(id, withHtml !== false)
  )
  ipcMain.handle('tasks:reorder', (_e, ids: string[]) => store.reorder(ids))
  ipcMain.handle('tasks:reset', (_e, id: string) => store.reset(id))
  ipcMain.handle('tasks:flush', () => {
    store.flush()
    return true
  })

  // ---- HTML 源码（按页存放，不进 config，不参与快照） ----
  // getHtml/setHtml 指的是「当前页」：老调用点（手工粘贴、抓取）不必知道页的存在。
  ipcMain.handle('tasks:getHtml', (_e, id: string) => store.getHtml(id))
  ipcMain.handle('tasks:setHtml', (_e, id: string, html: string) => store.setHtml(id, html))

  // ---- 多页问卷的页存档 ----
  ipcMain.handle('tasks:pageCreate', (_e, id: string, input: PageInput) =>
    store.pageCreate(id, input ?? {})
  )
  ipcMain.handle('tasks:pageSelect', (_e, id: string, pageId: string) => store.pageSelect(id, pageId))
  ipcMain.handle('tasks:pagePatch', (_e, id: string, pageId: string, patch: PagePatch) =>
    store.pagePatch(id, pageId, patch)
  )
  ipcMain.handle('tasks:pageHtml', (_e, id: string, pageId: string) => store.pageHtml(id, pageId))
  ipcMain.handle('tasks:pageSetHtml', (_e, id: string, pageId: string, html: string) =>
    store.pageSetHtml(id, pageId, html)
  )
  ipcMain.handle('tasks:pageDelete', (_e, id: string, pageId: string) => store.pageDelete(id, pageId))

  // ---- 快照 ----
  ipcMain.handle('tasks:snapshots', (_e, id: string) => store.snapshots(id))
  ipcMain.handle('tasks:snapshotCreate', (_e, id: string, label?: SnapshotLabel) =>
    store.createSnapshot(id, label === 'manual' ? 'manual' : 'key-action')
  )
  ipcMain.handle('tasks:snapshotRead', (_e, id: string, ts: string) => store.readSnapshot(id, ts))
  ipcMain.handle('tasks:rollback', (_e, id: string, ts: string) => store.rollback(id, ts))

  // ---- 回收站 ----
  ipcMain.handle('tasks:trash', (_e, id: string) => store.trash(id))
  ipcMain.handle('trash:list', () => store.listTrash())
  ipcMain.handle('trash:restore', (_e, id: string) => store.restore(id))
  ipcMain.handle('trash:purge', (_e, id: string) => store.purge(id))
  ipcMain.handle('trash:empty', () => store.emptyTrash())

  // ---- 设置 ----
  ipcMain.handle('tasks:settings:get', () => store.settings())
  ipcMain.handle(
    'tasks:settings:save',
    (_e, patch: Partial<TaskStoreSettings>) => store.saveSettings(patch)
  )

  // ---- 导出 / 导入（需要系统文件对话框） ----
  ipcMain.handle(
    'tasks:export',
    async (_e, ids: string[] | 'all', includeHtml: boolean) => {
      const file = store.exportTasks(ids, !!includeHtml)
      if (file.tasks.length === 0) {
        return { canceled: false, path: undefined, message: '没有可导出的任务' }
      }
      const suggest =
        ids !== 'all' && file.tasks.length === 1
          ? `${safeFileName(file.tasks[0].name)}-${localStamp()}.json`
          : `表单填写器-任务导出-${localStamp()}.json`
      const win = getWindow()
      const res = win
        ? await dialog.showSaveDialog(win, {
            title: '导出任务配置',
            defaultPath: suggest,
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })
        : { canceled: true, filePath: undefined }
      if (res.canceled || !res.filePath) return { canceled: true, path: undefined }
      writeFileSync(res.filePath, JSON.stringify(file, null, 2), 'utf-8')
      return { canceled: false, path: res.filePath }
    }
  )

  ipcMain.handle('tasks:import', async () => {
    const win = getWindow()
    const res = win
      ? await dialog.showOpenDialog(win, {
          title: '导入任务配置',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
      : { canceled: true, filePaths: [] }
    if (res.canceled || res.filePaths.length === 0) {
      return { imported: [], failed: [], canceled: true }
    }
    const raw = readFileSync(res.filePaths[0], 'utf-8')
    let parsed: ExportFile
    try {
      parsed = JSON.parse(raw) as ExportFile
    } catch {
      throw new Error('文件不是合法 JSON，无法导入')
    }
    if (parsed?.format !== EXPORT_FORMAT) {
      throw new Error('文件格式不匹配（期望「表单填写器」导出的配置文件）')
    }
    const outcome = store.importTasks(parsed)
    ctx.broadcast('tasks:changed')
    return outcome
  })

  // 保存态、索引变更由 store 的回调在 main/index.ts 里广播（见 createTaskStore 的 options）
}
