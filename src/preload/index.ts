import { contextBridge, ipcRenderer } from 'electron'

const api = {
  readScreenshot: (path: string) => ipcRenderer.invoke('screenshot:read', path),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  startupNotice: () => ipcRenderer.invoke('app:startupNotice'),

  // ---- 任务（自动持久化；任务 = 标签 = 落盘实体） ----
  tasksList: () => ipcRenderer.invoke('tasks:list'),
  tasksGet: (id: string) => ipcRenderer.invoke('tasks:get', id),
  tasksCreate: (name?: string) => ipcRenderer.invoke('tasks:create', name),
  tasksPatch: (id: string, patch: unknown) => ipcRenderer.invoke('tasks:patch', id, patch),
  tasksRename: (id: string, name: string, autoName?: boolean) =>
    ipcRenderer.invoke('tasks:rename', id, name, autoName),
  tasksDuplicate: (id: string, withHtml?: boolean) =>
    ipcRenderer.invoke('tasks:duplicate', id, withHtml),
  tasksReorder: (ids: string[]) => ipcRenderer.invoke('tasks:reorder', ids),
  tasksReset: (id: string) => ipcRenderer.invoke('tasks:reset', id),
  /** 立刻把待落盘内容写盘（保存失败后的重试） */
  tasksFlush: () => ipcRenderer.invoke('tasks:flush'),
  tasksGetHtml: (id: string) => ipcRenderer.invoke('tasks:getHtml', id),
  tasksSetHtml: (id: string, html: string) => ipcRenderer.invoke('tasks:setHtml', id, html),

  // ---- 多页问卷的页存档（每一页各自留着自己的 HTML / 题目 / 答案） ----
  /** 新建一页（HTML 已在界面抓好）并切到它 */
  tasksPageCreate: (id: string, input: unknown) => ipcRenderer.invoke('tasks:pageCreate', id, input),
  /** 切换当前页（顶层题目/答案随之换成该页的；对钩按该页自己的指纹判定） */
  tasksPageSelect: (id: string, pageId: string) => ipcRenderer.invoke('tasks:pageSelect', id, pageId),
  /** 改页名 / 补指纹 / 改该页题目与答案 */
  tasksPagePatch: (id: string, pageId: string, patch: unknown) =>
    ipcRenderer.invoke('tasks:pagePatch', id, pageId, patch),
  tasksPageHtml: (id: string, pageId: string) => ipcRenderer.invoke('tasks:pageHtml', id, pageId),
  tasksPageSetHtml: (id: string, pageId: string, html: string) =>
    ipcRenderer.invoke('tasks:pageSetHtml', id, pageId, html),
  /** 删掉一页（最后一页时等价于清空该页） */
  tasksPageDelete: (id: string, pageId: string) => ipcRenderer.invoke('tasks:pageDelete', id, pageId),

  // ---- 快照（历史版本） ----
  tasksSnapshots: (id: string) => ipcRenderer.invoke('tasks:snapshots', id),
  tasksSnapshotCreate: (id: string, label?: string) =>
    ipcRenderer.invoke('tasks:snapshotCreate', id, label),
  tasksSnapshotRead: (id: string, ts: string) => ipcRenderer.invoke('tasks:snapshotRead', id, ts),
  tasksRollback: (id: string, ts: string) => ipcRenderer.invoke('tasks:rollback', id, ts),

  // ---- 回收站（软删除，可撤销） ----
  tasksTrash: (id: string) => ipcRenderer.invoke('tasks:trash', id),
  trashList: () => ipcRenderer.invoke('trash:list'),
  trashRestore: (id: string) => ipcRenderer.invoke('trash:restore', id),
  trashPurge: (id: string) => ipcRenderer.invoke('trash:purge', id),
  trashEmpty: () => ipcRenderer.invoke('trash:empty'),

  // ---- 存储设置与导入导出 ----
  tasksSettingsGet: () => ipcRenderer.invoke('tasks:settings:get'),
  tasksSettingsSave: (patch: unknown) => ipcRenderer.invoke('tasks:settings:save', patch),
  tasksExport: (ids: string[] | 'all', includeHtml: boolean) =>
    ipcRenderer.invoke('tasks:export', ids, includeHtml),
  tasksImport: () => ipcRenderer.invoke('tasks:import'),

  /** 保存态：saving / saved / error（顶栏指示灯） */
  onTasksState: (cb: (p: unknown) => void) => {
    const listener = (_e: unknown, p: unknown): void => cb(p)
    ipcRenderer.on('tasks:state', listener)
    return () => {
      ipcRenderer.removeListener('tasks:state', listener)
    }
  },
  /** 任务索引变更（新建/删除/导入等，用于刷新列表） */
  onTasksChanged: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('tasks:changed', listener)
    return () => {
      ipcRenderer.removeListener('tasks:changed', listener)
    }
  },

  // ---- 填写运行 ----
  fillRun: (req: unknown, runId: string) => ipcRenderer.invoke('fill:run', req, runId),
  fillStop: (runId: string) => ipcRenderer.invoke('fill:stop', runId),
  onFillProgress: (cb: (p: unknown) => void) => {
    const listener = (_e: unknown, p: unknown): void => cb(p)
    ipcRenderer.on('fill:progress', listener)
    return () => {
      ipcRenderer.removeListener('fill:progress', listener)
    }
  },

  // ---- 浏览器会话（多页问卷「接着填」：复用同一窗口，在其当前页继续填） ----
  fillSessionStatus: (taskId: string) => ipcRenderer.invoke('fill:session:status', taskId),
  /**
   * 启动浏览器（**只打开，不抓取**）。
   * 题目/答案还没生成时也能先把页面开起来：提前登录、提前翻页、提前看清结构。
   */
  fillSessionOpen: (taskId: string, opts?: { link?: string; channel?: string }) =>
    ipcRenderer.invoke('fill:session:open', taskId, opts),
  fillSessionClose: (taskId: string) => ipcRenderer.invoke('fill:session:close', taskId),
  /**
   * 清除该任务的登录态（关窗口 + 删 profile 目录）。
   * 登录态默认长期保留，只有换账号或登录态坏了才需要清。
   */
  fillSessionResetProfile: (taskId: string) =>
    ipcRenderer.invoke('fill:session:reset-profile', taskId),
  /**
   * 抓取浏览器当前页面的 HTML（主 frame + 含表单控件的子 frame）。
   * 只在**已有浏览器窗口**时可用（没有会提示先「启动浏览器」，不会自行开）；
   * 抓之前会等页面真正加载好，且覆盖前自动把上一份 HTML 与当时题目存为历史版本。
   */
  fillSessionGrab: (taskId: string, opts?: { link?: string; waitMs?: number }) =>
    ipcRenderer.invoke('fill:session:grab', taskId, opts),
  /**
   * 识别存活页面里的「下一页」按钮（只读，不点任何东西）。
   * 抓取时也会顺带识别一次，这里用于「刚打开浏览器」「用户自己翻完页」之后刷新候选。
   */
  fillSessionNext: (taskId: string) => ipcRenderer.invoke('fill:session:next', taskId),
  /**
   * 在浏览器里点某个识别到的按钮，然后等新页面长好。
   * **只在用户明确点界面上那个 chip 时**才调用 —— 程序不会自己翻页。
   */
  fillSessionClickNext: (
    taskId: string,
    target: { selector?: string; text?: string; frameUrl?: string }
  ) => ipcRenderer.invoke('fill:session:click-next', taskId, target),
  onFillSession: (cb: (p: { taskId: string; open: boolean; url?: string }) => void) => {
    const listener = (_e: unknown, p: { taskId: string; open: boolean; url?: string }): void => cb(p)
    ipcRenderer.on('fill:session', listener)
    return () => {
      ipcRenderer.removeListener('fill:session', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
