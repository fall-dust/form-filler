/**
 * 任务存储（M6 核心）。
 *
 * 布局：
 *   <root>/tasks/index.json              任务列表索引（轻量元数据）
 *   <root>/tasks/<id>/config.json        当前配置（原子写）
 *   <root>/tasks/<id>/pages/<页id>.html  多页问卷的每一页 HTML（页存档）
 *   <root>/tasks/<id>/source.html        旧布局的单页 HTML（仅作读透兼容，首写后清理）
 *   <root>/tasks/<id>/snapshots/*.json   历史版本（默认最多 20 份，连每页 HTML 一起存）
 *   <root>/tasks/settings.json           回收站保留期等设置
 *   <root>/trash/<id>/                   软删除的任务（整目录 move 进来）
 *   <root>/migration.json                旧 projects/ 迁移记录
 *
 * 设计要点：
 * - 全部同步 fs：同步写天然串行，不存在并发写乱序；before-quit 的 flush 也能可靠完成。
 * - 写盘防抖在**主进程**：渲染层改动立即发送，主进程合并后统一落盘，退出时 flush 不丢最后一段输入。
 * - 索引只是缓存：缺失/损坏可从各任务的 config.json 重建，绝不因此丢数据。
 * - 删除 = move 到 trash/（同卷原子），可撤销；「彻底删除」才真正 rm。
 * - **「当前页」是唯一的内容主人**：config.questions/answers/指纹 都只是 activePage 的镜像，
 *   写入时落回该页、读取时由该页填出 —— 引擎、快照、导出这些老代码因此不必知道「页」的存在。
 *
 * 详细设计见 任务配置方案.md。
 */
import { createHash, randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  ensureDir,
  listDirs,
  listFiles,
  moveDir,
  moveFile,
  mtimeIso,
  readJson,
  readText,
  recoverFromTmp,
  removeDir,
  removeFile,
  writeJsonAtomic,
  writeTextAtomic
} from './fsx'
import { asBool, asString, sanitizeAnswers, sanitizePages, sanitizeQuestions } from './sanitize'
import {
  DEFAULT_SETTINGS,
  type ExportFile,
  type ExportedPage,
  type ExportedTask,
  type ImportOutcome,
  type MigrationReport,
  type PageInput,
  type PagePatch,
  type SaveStateEvent,
  type SnapshotFile,
  type SnapshotLabel,
  type SnapshotMeta,
  type TaskConfig,
  type TaskIndex,
  type TaskIndexItem,
  type TaskPage,
  type TaskPatch,
  type TaskStoreSettings,
  type TrashItem,
  type TrashMeta
} from './types'

export interface TaskStoreOptions {
  /** 写盘防抖（ms）；0 = 立即写（测试用） */
  debounceMs?: number
  now?: () => Date
  onSaveState?: (e: SaveStateEvent) => void
  onChanged?: () => void
}

export interface TaskStore {
  readonly root: string
  list(): TaskIndexItem[]
  get(id: string): TaskConfig | null
  create(name?: string): TaskIndexItem
  patch(id: string, patch: TaskPatch): TaskIndexItem | null
  /** autoName=true 表示「程序/AI 自动命名」（可被后续 AI 命名覆盖）；缺省视为用户手动改名 */
  rename(id: string, name: string, autoName?: boolean): TaskIndexItem | null
  duplicate(id: string, withHtml?: boolean): TaskIndexItem | null
  reorder(ids: string[]): TaskIndexItem[]
  reset(id: string): TaskConfig | null
  remove(id: string): boolean
  /** 当前页的 HTML（多页问卷里就是「当前这一页」） */
  getHtml(id: string): string | null
  /** 写入当前页的 HTML；没有页时自动建第一页 */
  setHtml(id: string, html: string): boolean

  // ---- 多页问卷的页存档 ----
  /** 新建一页（HTML 已在界面抓好）并设为当前页 */
  pageCreate(id: string, input: PageInput): TaskConfig | null
  /** 切换当前页（顶层 questions/answers/指纹 随之换成该页的） */
  pageSelect(id: string, pageId: string): TaskConfig | null
  /** 改页名 / 补指纹 / 直接改该页题目与答案 */
  pagePatch(id: string, pageId: string, patch: PagePatch): TaskConfig | null
  /** 读取某页的 HTML */
  pageHtml(id: string, pageId: string): string | null
  /** 覆盖某页的 HTML（同一页重新抓取时用） */
  pageSetHtml(id: string, pageId: string, html: string): boolean
  /** 删掉一页（含它的 HTML 文件）；删的是当前页时自动回落到相邻页 */
  pageDelete(id: string, pageId: string): TaskConfig | null

  snapshots(id: string): SnapshotMeta[]
  /**
   * 建快照。`withHtml` 把 HTML 源码一并存档（回滚时连页面一起还原）；
   * `skipIfEmpty` 在「既没有 HTML 也没有题目」时直接跳过（避免留下无意义的历史版本）。
   */
  createSnapshot(
    id: string,
    label: SnapshotLabel,
    opts?: { withHtml?: boolean; skipIfEmpty?: boolean }
  ): SnapshotMeta | null
  readSnapshot(id: string, ts: string): TaskConfig | null
  /** 回滚默认只还原「配置内容」；快照带 HTML 时连同页面一起还原 */
  rollback(id: string, ts: string): TaskConfig | null
  trash(id: string): boolean
  listTrash(): TrashItem[]
  restore(id: string): TaskIndexItem | null
  purge(id: string): boolean
  emptyTrash(): number
  cleanExpiredTrash(): number
  settings(): TaskStoreSettings
  saveSettings(patch: Partial<TaskStoreSettings>): TaskStoreSettings
  exportTasks(ids: string[] | 'all', includeHtml: boolean): ExportFile
  importTasks(file: ExportFile): ImportOutcome
  migrateFromProjects(): MigrationReport | null
  /** 立刻把待落盘内容写盘（before-quit / 重试按钮） */
  flush(): void
}

const INDEX_VERSION = 1
const EXPORT_FORMAT = 'form-filler-task'
const EXPORT_VERSION = 2

export function createTaskStore(root: string, options: TaskStoreOptions = {}): TaskStore {
  const debounceMs = options.debounceMs ?? 500
  const now = options.now ?? ((): Date => new Date())
  const emit = options.onSaveState ?? ((): void => {})
  const changed = options.onChanged ?? ((): void => {})

  const tasksDir = join(root, 'tasks')
  const trashDir = join(root, 'trash')
  const indexFile = join(tasksDir, 'index.json')
  const settingsFile = join(tasksDir, 'settings.json')
  const migrationFile = join(root, 'migration.json')
  const projectsDir = join(root, 'projects')

  const taskDir = (id: string): string => join(tasksDir, id)
  const configFile = (id: string): string => join(taskDir(id), 'config.json')
  /** 旧布局的单页 HTML：只作读透兼容（第一页没有自己的文件时读它），首写后清理 */
  const htmlFile = (id: string): string => join(taskDir(id), 'source.html')
  const pagesDir = (id: string): string => join(taskDir(id), 'pages')
  const pageFile = (id: string, pageId: string): string => join(pagesDir(id), `${pageId}.html`)
  const snapshotsDir = (id: string): string => join(taskDir(id), 'snapshots')
  const trashItemDir = (id: string): string => join(trashDir, id)

  const iso = (): string => now().toISOString()
  const pad = (n: number): string => String(n).padStart(2, '0')

  /** 本地时间戳 YYYYMMDD-HHmmss（文件名可读性优先，故不用 ISO） */
  function stamp(d: Date = now()): string {
    return (
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    )
  }

  function genId(): string {
    for (let i = 0; i < 50; i++) {
      const id = `t-${randomBytes(4).toString('hex')}`
      if (!existsSync(taskDir(id)) && !existsSync(trashItemDir(id))) return id
    }
    return `t-${Date.now().toString(36)}`
  }

  function countAnswerMap(map: Record<string, string> | undefined): number {
    return Object.values(map ?? {}).filter(
      (v) => typeof v === 'string' && v.trim().length > 0
    ).length
  }

  function countAnswers(cfg: TaskConfig): number {
    return countAnswerMap(cfg.answers)
  }

  // ---------- 页存档的读写基础 ----------

  function pagesOf(cfg: TaskConfig): TaskPage[] {
    return cfg.pages && cfg.pages.length > 0 ? cfg.pages : []
  }

  /**
   * 把「页数组 + 当前页」同步成顶层的镜像字段。
   *
   * 顶层 questions/answers/指纹 是引擎、快照、导出读的那一份，必须是当前页的忠实镜像；
   * 该页没有的字段要**删掉键**（留着会把「没有指纹」误判成「指纹对不上」）。
   */
  function withMirror(cfg: TaskConfig, pages: TaskPage[], activePageId: string): TaskConfig {
    // 兜底：正常情况下至少有页（create 会建首页，normalizeConfig 会补首页）。
    // 万一拿到空数组，绝不能顺手把顶层内容清掉 —— 留着，下次读盘时会被合成第 1 页。
    if (pages.length === 0) return { ...cfg, pages: [], activePageId: '' }
    const active = pages.find((p) => p.id === activePageId) ?? pages[0]
    const next: TaskConfig = { ...cfg, pages, activePageId: active?.id ?? '' }
    next.questions = active?.questions ?? []
    next.answers = active?.answers ?? {}
    if (active?.questionsFor) next.questionsFor = active.questionsFor
    else delete next.questionsFor
    if (active?.answersFor) next.answersFor = active.answersFor
    else delete next.answersFor
    return next
  }

  /** 单一页面（单页任务 / 老数据）的等价配置：用于「页上还没有内容」时的兜底读取 */
  function firstPageId(cfg: TaskConfig): string {
    return pagesOf(cfg)[0]?.id ?? ''
  }

  /** 全部页的题目总数 —— 任务列表显示的是「这个任务一共多少题」，不是单页的 */
  function totalQuestions(cfg: TaskConfig): number {
    const pages = pagesOf(cfg)
    if (pages.length === 0) return cfg.questions?.length ?? 0
    return pages.reduce((n, p) => n + (p.questions?.length ?? 0), 0)
  }

  function totalAnswers(cfg: TaskConfig): number {
    const pages = pagesOf(cfg)
    if (pages.length === 0) return countAnswers(cfg)
    return pages.reduce((n, p) => n + countAnswerMap(p.answers), 0)
  }

  /** 任一页（或旧布局的 source.html）有 HTML 就算有 */
  function hasAnyHtml(id: string, cfg?: TaskConfig | null): boolean {
    if (existsSync(htmlFile(id))) return true
    const pages = cfg ? pagesOf(cfg) : []
    for (const p of pages) {
      if (existsSync(pageFile(id, p.id))) return true
    }
    if (pages.length === 0 && existsSync(pagesDir(id))) return listFiles(pagesDir(id)).length > 0
    return false
  }

  // ---------- 索引 ----------

  let index: TaskIndexItem[] = []
  let loaded = false
  const cache = new Map<string, TaskConfig>()

  function normalizeIndexItem(raw: unknown): TaskIndexItem | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id) return null
    const createdAt = asString(o.createdAt, iso())
    return {
      id: o.id,
      name: asString(o.name, o.id),
      createdAt,
      updatedAt: asString(o.updatedAt, createdAt),
      questionCount: typeof o.questionCount === 'number' ? o.questionCount : 0,
      answerCount: typeof o.answerCount === 'number' ? o.answerCount : 0,
      hasHtml: !!o.hasHtml,
      order: typeof o.order === 'number' ? o.order : 0
    }
  }

  function sortAndWriteIndex(): void {
    const sorted = [...index].sort(
      (a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt)
    )
    sorted.forEach((it, i) => {
      it.order = i
    })
    index = sorted
    ensureDir(tasksDir)
    writeJsonAtomic(indexFile, { version: INDEX_VERSION, tasks: index } satisfies TaskIndex)
  }

  /** 索引项的增改（不落盘，由调用方的 flush/patch 统一落盘） */
  function upsertIndexItem(cfg: TaskConfig): TaskIndexItem {
    loadIndex()
    const at = iso()
    let it = index.find((i) => i.id === cfg.id)
    if (!it) {
      it = {
        id: cfg.id,
        name: cfg.name,
        createdAt: at,
        updatedAt: at,
        questionCount: 0,
        answerCount: 0,
        hasHtml: false,
        order: index.length
      }
      index.push(it)
    }
    it.name = cfg.name
    it.updatedAt = at
    // 计数按「全部页之和」：任务列表与抽屉说的是「这个任务一共多少题 / 答了多少」
    it.questionCount = totalQuestions(cfg)
    it.answerCount = totalAnswers(cfg)
    it.hasHtml = hasAnyHtml(cfg.id, cfg)
    return it
  }

  /**
   * 索引与磁盘对齐：清理崩溃残留的 .tmp、补上索引里缺失的任务目录、剔除已不存在的条目。
   * 索引整体缺失/损坏时（rebuilt = true）按创建时间重排，否则保留用户拖拽的顺序。
   */
  function reconcile(rebuilt: boolean): void {
    const dirs = listDirs(tasksDir)
    const dirSet = new Set(dirs)
    let dirty = false

    for (const id of dirs) {
      recoverFromTmp(taskDir(id), 'config.json')
      const known = index.find((i) => i.id === id)
      if (known) {
        const hasHtml = hasAnyHtml(id, getCfg(id))
        if (known.hasHtml !== hasHtml) {
          known.hasHtml = hasHtml
          dirty = true
        }
        continue
      }
      const r = readJson<TaskConfig>(configFile(id))
      if (!r.ok) continue
      const cfg = normalizeConfig(r.data, id)
      cache.set(id, cfg)
      const it = upsertIndexItem(cfg)
      const mt = mtimeIso(configFile(id))
      it.createdAt = mt
      it.updatedAt = mt
      it.hasHtml = hasAnyHtml(id, cfg)
      dirty = true
    }

    if (index.some((i) => !dirSet.has(i.id))) {
      index = index.filter((i) => dirSet.has(i.id))
      dirty = true
    }

    if (rebuilt) {
      index.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      dirty = true
    }
    if (dirty) sortAndWriteIndex()
  }

  function loadIndex(): TaskIndexItem[] {
    if (loaded) return index
    loaded = true
    const r = readJson<TaskIndex>(indexFile)
    let rebuilt = false
    if (r.ok && Array.isArray(r.data?.tasks)) {
      index = r.data.tasks.map(normalizeIndexItem).filter((x): x is TaskIndexItem => !!x)
    } else {
      if (r.ok === false && r.reason === 'corrupt') {
        // 保留损坏现场以便排查，再从磁盘重建
        try {
          removeFile(indexFile)
        } catch {
          /* 忽略 */
        }
      }
      index = []
      rebuilt = true
    }
    reconcile(rebuilt)
    return index
  }

  // ---------- 配置读写 ----------

  /** 可选字符串：空串一律归一为「没有」（指纹字段缺省 = 判不了，按有效处理） */
  function optStr(v: unknown): string | undefined {
    return typeof v === 'string' && v ? v : undefined
  }

  function normalizeConfig(raw: unknown, id: string): TaskConfig {
    const o = (raw ?? {}) as Record<string, unknown>
    const name = asString(o.name, id) || id
    const base: TaskConfig = {
      id,
      name,
      // 旧数据没有这个标记：默认名「任务 N」视为程序自动命名，其余视为用户自己起的
      nameAuto: typeof o.nameAuto === 'boolean' ? o.nameAuto : /^任务 \d+$/.test(name),
      link: asString(o.link),
      autoSubmit: asBool(o.autoSubmit),
      channel: asString(o.channel),
      questions: sanitizeQuestions(o.questions),
      answers: sanitizeAnswers(o.answers),
      // 旧数据没有指纹：留空，由界面载入时按「当前 HTML / 当前题目就是它的来源」回填一次
      questionsFor: optStr(o.questionsFor),
      answersFor: optStr(o.answersFor)
    }

    let pages = sanitizePages(o.pages)
    if (pages.length === 0) {
      // 老数据（以及刚建好还没抓过页面的新任务）：顶层那一份内容就是唯一的一页。
      // 迁移到 pages 之后，删掉旧字段依赖 —— 以后一切都以「页」为准，顶层只是镜像。
      pages = [
        {
          id: 'p1',
          name: '第 1 页',
          nameAuto: true,
          questions: base.questions,
          answers: base.answers,
          ...(base.questionsFor ? { questionsFor: base.questionsFor } : {}),
          ...(base.answersFor ? { answersFor: base.answersFor } : {})
        }
      ]
    }
    const wantActive = optStr(o.activePageId)
    const activePageId = wantActive && pages.some((p) => p.id === wantActive) ? wantActive : pages[0].id
    return withMirror(base, pages, activePageId)
  }

  function readConfig(id: string): TaskConfig | null {
    if (!existsSync(taskDir(id))) return null
    recoverFromTmp(taskDir(id), 'config.json')
    const r = readJson<TaskConfig>(configFile(id))
    if (r.ok) return normalizeConfig(r.data, id)
    if (r.reason === 'missing') return null

    // 损坏：改名留证 + 从最近快照自动恢复
    try {
      moveFile(configFile(id), join(taskDir(id), `config.corrupt-${stamp()}.json`))
    } catch {
      /* 忽略 */
    }
    for (const s of readSnapshotMetas(id)) {
      const cfg = readSnapshot(id, s.ts)
      if (cfg) {
        writeJsonAtomic(configFile(id), cfg)
        return cfg
      }
    }
    return null
  }

  function getCfg(id: string): TaskConfig | null {
    const hit = cache.get(id)
    if (hit) return hit
    const cfg = readConfig(id)
    if (cfg) cache.set(id, cfg)
    return cfg
  }

  // ---------- 落盘（防抖 + 同步原子写） ----------

  const pending = new Map<string, TaskConfig>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastError = ''

  function flush(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.size === 0) return
    try {
      for (const [id, cfg] of [...pending]) {
        writeJsonAtomic(configFile(id), cfg)
        pending.delete(id)
      }
      sortAndWriteIndex()
      lastError = ''
      emit({ state: 'saved', at: now().getTime() })
      changed()
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      emit({ state: 'error', at: now().getTime(), message: lastError })
    }
  }

  function scheduleWrite(): void {
    if (debounceMs <= 0) {
      flush()
      return
    }
    emit({ state: 'saving', at: now().getTime() })
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
  }

  // ---------- 快照 ----------

  const lastAutoAt = new Map<string, number>()

  function readSnapshotMetas(id: string): SnapshotMeta[] {
    const dir = snapshotsDir(id)
    return listFiles(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const r = readJson<SnapshotFile>(join(dir, f))
        if (r.ok && r.data?.meta) return r.data.meta
        return null
      })
      .filter((m): m is SnapshotMeta => !!m)
      // 同一秒内可能产生多份（内容不同 → hash 不同），故以 createdAt(ms) 为主序，ts 仅作兜底
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.ts.localeCompare(a.ts))
  }

  function pruneSnapshots(id: string): void {
    const limit = Math.max(1, settings().snapshotLimit)
    const desc = readSnapshotMetas(id)
    if (desc.length <= limit) return
    // 从最旧的开始删，只删 auto（manual / pre-rollback 优先保留）
    const asc = [...desc].reverse()
    let count = desc.length
    for (const s of asc) {
      if (count <= limit) break
      if (s.label !== 'auto') continue
      removeFile(join(snapshotsDir(id), `${s.ts}.json`))
      if (s.hasHtml && existsSync(snapshotHtmlFile(id, s.ts))) {
        removeFile(snapshotHtmlFile(id, s.ts))
      }
      if (existsSync(snapshotPagesDir(id, s.ts))) removeDir(snapshotPagesDir(id, s.ts))
      count -= 1
    }
  }

  /** 快照的 HTML 旁挂文件（快照 JSON 里只记 hasHtml，正文放这里） */
  function snapshotHtmlFile(id: string, ts: string): string {
    return join(snapshotsDir(id), `${ts}.html`)
  }

  /** 快照里每一页的 HTML 目录（多页任务回滚要连每一页一起还原） */
  function snapshotPagesDir(id: string, ts: string): string {
    return join(snapshotsDir(id), `${ts}.pages`)
  }

  /** 快照连 HTML 一起存档：当前页写进 .html（兼容老读取路径），每一页写进 .pages/ */
  function writeSnapshotHtml(id: string, ts: string, cfg: TaskConfig): number {
    let n = 0
    const activeHtml = getHtml(id)
    if (activeHtml) {
      writeTextAtomic(snapshotHtmlFile(id, ts), activeHtml)
      n++
    }
    const dir = snapshotPagesDir(id, ts)
    for (const pg of pagesOf(cfg)) {
      const html = readPageHtml(id, pg.id)
      if (!html) continue
      ensureDir(dir)
      writeTextAtomic(join(dir, `${pg.id}.html`), html)
      n++
    }
    return n
  }

  /**
   * 回滚时把页面文件还原回来。
   *
   * 原则：只还原快照里存过的页 —— 现在多出来的页保持原样，绝不因为回滚就把用户的页删掉
   * （回滚的语义是「回到那时的内容」，而不是「把后来的一切抹掉」）。
   * 老快照没存过任何 HTML 时（n = 0）保持当前页面不动。
   */
  function restoreSnapshotHtml(id: string, ts: string, cfg: TaskConfig): void {
    const dir = snapshotPagesDir(id, ts)
    if (existsSync(dir)) {
      for (const f of listFiles(dir)) {
        if (!f.endsWith('.html')) continue
        const html = readText(join(dir, f))
        if (html === null) continue
        ensureDir(pagesDir(id))
        writeTextAtomic(pageFile(id, f.slice(0, -'.html'.length)), html)
      }
    }
    const activeHtml = readSnapshotHtml(id, ts)
    if (activeHtml !== null) {
      const pageId = cfg.activePageId || firstPageId(cfg)
      if (pageId) {
        ensureDir(pagesDir(id))
        writeTextAtomic(pageFile(id, pageId), activeHtml)
      }
    }
  }

  function createSnapshot(
    id: string,
    label: SnapshotLabel,
    opts?: { withHtml?: boolean; skipIfEmpty?: boolean }
  ): SnapshotMeta | null {
    const cfg = getCfg(id)
    if (!cfg) return null

    // 要连 HTML 一起存档时，先把 HTML 读出来 —— 「抓取新页面前存档」靠它保住上一页的记录
    const withHtml = opts?.withHtml === true
    const html = withHtml ? getHtml(id) : null
    const anyHtml = withHtml ? html !== null || pagesOf(cfg).some((p) => !!readPageHtml(id, p.id)) : false
    // 既没有 HTML 也没有题目 → 没什么可存的，不留空档
    if (opts?.skipIfEmpty && !anyHtml && totalQuestions(cfg) === 0) return null

    const dir = snapshotsDir(id)
    ensureDir(dir)
    const body = JSON.stringify(cfg)
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 8)

    // 自动快照去重：与最新一份内容完全相同则跳过（手动/关键动作/回滚前一律留档）
    if (label === 'auto') {
      const newest = readSnapshotMetas(id)[0]
      if (newest && newest.hash === hash) return null
    }

    // 同一秒内的多次快照要各自留档，故文件名冲突时追加序号
    const base = `${stamp()}-${hash}`
    let ts = base
    for (let n = 2; existsSync(join(dir, `${ts}.json`)); n++) ts = `${base}-${n}`

    const meta: SnapshotMeta = {
      ts,
      createdAt: iso(),
      // 计数按全部页之和（与任务列表口径一致）
      questionCount: totalQuestions(cfg),
      answerCount: totalAnswers(cfg),
      size: Buffer.byteLength(body, 'utf-8'),
      label,
      ...(withHtml ? { hasHtml: anyHtml } : {}),
      hash
    }
    writeJsonAtomic(
      join(dir, `${ts}.json`),
      { version: 1, meta, config: cfg } satisfies SnapshotFile
    )
    if (withHtml) writeSnapshotHtml(id, ts, cfg)
    pruneSnapshots(id)
    return meta
  }

  function readSnapshot(id: string, ts: string): TaskConfig | null {
    const file = join(snapshotsDir(id), `${ts}.json`)
    const r = readJson<SnapshotFile>(file)
    if (!r.ok || !r.data?.config) return null
    return normalizeConfig(r.data.config, id)
  }

  /** 该快照存档的 HTML（没存过返回 null） */
  function readSnapshotHtml(id: string, ts: string): string | null {
    return readText(snapshotHtmlFile(id, ts))
  }

  function maybeAutoSnapshot(id: string): void {
    const bucketMinutes = Math.max(1, settings().autoSnapshotMinutes)
    const bucket = bucketMinutes * 60_000
    let last = lastAutoAt.get(id)
    if (last === undefined) {
      const newest = readSnapshotMetas(id)[0]
      last = newest ? Date.parse(newest.createdAt) : 0
      if (Number.isNaN(last)) last = 0
      lastAutoAt.set(id, last)
    }
    const t = now().getTime()
    if (t - last < bucket) return
    lastAutoAt.set(id, t)
    createSnapshot(id, 'auto')
  }

  // ---------- 设置 ----------

  function settings(): TaskStoreSettings {
    const r = readJson<Partial<TaskStoreSettings>>(settingsFile)
    const raw = r.ok ? r.data : {}
    return {
      trashRetentionDays:
        typeof raw.trashRetentionDays === 'number' && raw.trashRetentionDays >= 0
          ? raw.trashRetentionDays
          : DEFAULT_SETTINGS.trashRetentionDays,
      autoSnapshotMinutes:
        typeof raw.autoSnapshotMinutes === 'number' && raw.autoSnapshotMinutes >= 1
          ? raw.autoSnapshotMinutes
          : DEFAULT_SETTINGS.autoSnapshotMinutes,
      snapshotLimit:
        typeof raw.snapshotLimit === 'number' && raw.snapshotLimit >= 1
          ? raw.snapshotLimit
          : DEFAULT_SETTINGS.snapshotLimit
    }
  }

  // ---------- 命名 ----------

  function uniqueName(name: string): string {
    loadIndex()
    const base = name.trim() || '未命名任务'
    if (!index.some((i) => i.name === base)) return base
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base} (${n})`
      if (!index.some((i) => i.name === candidate)) return candidate
    }
    return `${base} (${Date.now().toString(36)})`
  }

  function nextAutoName(): string {
    loadIndex()
    let max = 0
    for (const it of index) {
      const m = /^任务 (\d+)$/.exec(it.name)
      if (m) max = Math.max(max, Number(m[1]))
    }
    return `任务 ${max + 1}`
  }

  // ---------- 公开 API ----------

  function list(): TaskIndexItem[] {
    return [...loadIndex()]
  }

  function create(name?: string): TaskIndexItem {
    loadIndex()
    const id = genId()
    const explicit = !!(name && name.trim())
    // 任务永远至少有一页：建任务时就落一个空的第 1 页，界面（页面条）才有落点，
    // 也让「第一次抓取填进这一页」成为自然行为（而不是凭空多出一页）。
    const firstPage: TaskPage = {
      id: 'p1',
      name: '第 1 页',
      nameAuto: true,
      questions: [],
      answers: {}
    }
    const cfg: TaskConfig = {
      id,
      name: explicit ? uniqueName(name as string) : nextAutoName(),
      // 系统默认名可以被 AI 命名覆盖；显式指定的名字视为用户自己的
      nameAuto: !explicit,
      link: '',
      autoSubmit: false,
      channel: '',
      pages: [firstPage],
      activePageId: firstPage.id,
      questions: [],
      answers: {}
    }
    writeJsonAtomic(configFile(id), cfg)
    cache.set(id, cfg)
    const it = upsertIndexItem(cfg)
    it.createdAt = iso()
    it.updatedAt = it.createdAt
    it.hasHtml = false
    sortAndWriteIndex()
    changed()
    return it
  }

  function patch(id: string, p: TaskPatch): TaskIndexItem | null {
    const cfg = getCfg(id)
    if (!cfg) return null
    let merged: TaskConfig = { ...cfg, ...p, id }
    // 名字允许随时改，但不允许被清空（界面输入框删空时保留原名）
    if (p.name !== undefined) {
      merged.name = p.name.trim() || cfg.name
      // 用户在框里亲手改过 → 此后不再被 AI 命名覆盖
      merged.nameAuto = false
    }
    // 内容字段一律落到**当前页**：顶层只是镜像，否则「改当前页的答案」会把其它页覆盖掉
    if ('questions' in p || 'answers' in p || 'questionsFor' in p || 'answersFor' in p) {
      const pages = pagesOf(merged).map((pg) => {
        if (pg.id !== merged.activePageId) return pg
        const next: TaskPage = { ...pg }
        if ('questions' in p) next.questions = merged.questions ?? []
        if ('answers' in p) next.answers = merged.answers ?? {}
        // 指纹走「显式判定」：传空串/undefined = 清空（沿用旧值会让对钩假装还有效）
        if ('questionsFor' in p) {
          const v = optStr(p.questionsFor)
          if (v) next.questionsFor = v
          else delete next.questionsFor
        }
        if ('answersFor' in p) {
          const v = optStr(p.answersFor)
          if (v) next.answersFor = v
          else delete next.answersFor
        }
        return next
      })
      merged = withMirror(merged, pages, merged.activePageId ?? '')
    }
    cache.set(id, merged)
    const it = upsertIndexItem(merged)
    pending.set(id, merged)
    scheduleWrite()
    maybeAutoSnapshot(id)
    return it
  }

  function rename(id: string, name: string, autoName = false): TaskIndexItem | null {
    const cfg = getCfg(id)
    if (!cfg) return null
    const trimmed = name.trim()
    // 名字为空视为误操作：原样返回，不改名也不改标记
    const next: TaskConfig = trimmed ? { ...cfg, name: trimmed, nameAuto: autoName } : cfg
    cache.set(id, next)
    writeJsonAtomic(configFile(id), next)
    const it = upsertIndexItem(next)
    sortAndWriteIndex()
    changed()
    return it
  }

  function duplicate(id: string, withHtml = true): TaskIndexItem | null {
    const src = getCfg(id)
    if (!src) return null
    loadIndex()
    const newId = genId()
    // 复制体继承「名字是不是自动起的」状态（副本名是在原名上加序号得来的）
    const cfg: TaskConfig = {
      ...src,
      id: newId,
      name: uniqueName(src.name),
      nameAuto: src.nameAuto,
      // 页数组是深结构：复制一份，免得副本与原件共享同一个数组
      pages: pagesOf(src).map((p) => ({
        ...p,
        questions: p.questions.map((q) => ({ ...q })),
        answers: { ...p.answers }
      }))
    }
    const copiedHtml = withHtml ? getHtml(id) : null
    // 指纹是「对着某份 HTML」的：没连 HTML 一起复制时它们无意义，清掉免得副本一打开就报「题目过期」
    if (copiedHtml === null) {
      delete cfg.questionsFor
      delete cfg.answersFor
      cfg.pages = (cfg.pages ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.nameAuto === undefined ? {} : { nameAuto: p.nameAuto }),
        ...(p.capturedAt ? { capturedAt: p.capturedAt } : {}),
        ...(p.url ? { url: p.url } : {}),
        questions: p.questions,
        answers: p.answers
      }))
    }
    writeJsonAtomic(configFile(newId), cfg)
    cache.set(newId, cfg)
    if (withHtml) {
      // 每一页的 HTML 都要复制过去（多页任务只复制当前页的话，切过去就是空白）
      for (const pg of pagesOf(src)) {
        const h = readPageHtml(id, pg.id)
        if (h) writePageHtml(newId, pg.id, h)
      }
    }
    const it = upsertIndexItem(cfg)
    it.createdAt = iso()
    it.updatedAt = it.createdAt
    sortAndWriteIndex()
    changed()
    return it
  }

  function reorder(ids: string[]): TaskIndexItem[] {
    loadIndex()
    const map = new Map(index.map((i) => [i.id, i]))
    const next: TaskIndexItem[] = []
    for (const id of ids) {
      const it = map.get(id)
      if (it) {
        next.push(it)
        map.delete(id)
      }
    }
    for (const it of map.values()) next.push(it)
    next.forEach((it, i) => {
      it.order = i
    })
    index = next
    sortAndWriteIndex()
    changed()
    return list()
  }

  function reset(id: string): TaskConfig | null {
    const cfg = getCfg(id)
    if (!cfg) return null
    // 清空前先留档（连每页 HTML 一起），后悔了能整页回滚
    createSnapshot(id, 'pre-rollback', { withHtml: true })
    const empty: TaskPage = {
      id: firstPageId(cfg) || 'p1',
      name: '第 1 页',
      nameAuto: true,
      questions: [],
      answers: {}
    }
    const next: TaskConfig = withMirror(
      { ...cfg, link: '', autoSubmit: false, channel: '' },
      [empty],
      empty.id
    )
    writeJsonAtomic(configFile(id), next)
    cache.set(id, next)
    pending.delete(id)
    if (existsSync(htmlFile(id))) removeFile(htmlFile(id))
    if (existsSync(pagesDir(id))) removeDir(pagesDir(id))
    const it = upsertIndexItem(next)
    it.hasHtml = false
    sortAndWriteIndex()
    changed()
    return next
  }

  function remove(id: string): boolean {
    if (!existsSync(taskDir(id))) return false
    removeDir(taskDir(id))
    cache.delete(id)
    pending.delete(id)
    loadIndex()
    index = index.filter((i) => i.id !== id)
    sortAndWriteIndex()
    changed()
    return true
  }

  // ---------- HTML（按页读写；顶层 getHtml/setHtml 指向「当前页」） ----------

  function readPageHtml(id: string, pageId: string): string | null {
    const direct = readText(pageFile(id, pageId))
    if (direct !== null) return direct
    // 旧布局：单页任务的 HTML 还在 source.html 里。这里只做「读透」，
    // 不改文件 —— 下次写到这一页时自然换到 pages/ 下，并把老的删掉。
    const cfg = getCfg(id)
    if (cfg && pageId === firstPageId(cfg)) return readText(htmlFile(id))
    return null
  }

  function writePageHtml(id: string, pageId: string, html: string): void {
    if (html) {
      ensureDir(pagesDir(id))
      writeTextAtomic(pageFile(id, pageId), html)
    } else if (existsSync(pageFile(id, pageId))) {
      removeFile(pageFile(id, pageId))
    }
    // 旧的 source.html 只服务第一页；第一页一旦有了自己的文件（或内容被清掉），
    // 就把它删掉 —— 留着会让「两份 HTML 各说各话」，也让人分不清哪份才算数。
    const cfg = getCfg(id)
    if (cfg && pageId === firstPageId(cfg) && existsSync(htmlFile(id))) removeFile(htmlFile(id))
  }

  function getHtml(id: string): string | null {
    const cfg = getCfg(id)
    const pageId = cfg ? cfg.activePageId || firstPageId(cfg) : ''
    return pageId ? readPageHtml(id, pageId) : null
  }

  function setHtml(id: string, html: string): boolean {
    if (!existsSync(taskDir(id))) return false
    const cfg = getCfg(id)
    const pageId = cfg ? cfg.activePageId || firstPageId(cfg) : ''
    // 一个任务永远至少有一页（normalizeConfig 保证），所以这里拿不到页属于异常
    if (!pageId) return false
    writePageHtml(id, pageId, html)
    loadIndex()
    const it = index.find((i) => i.id === id)
    if (it) {
      it.hasHtml = hasAnyHtml(id, cfg)
      sortAndWriteIndex()
      changed()
    }
    return true
  }

  // ---------- 多页问卷的页存档 ----------

  /** 落盘立即生效的结构性改动（建页/切页/删页）：这类动作不能只靠防抖，否则崩一下页就没了 */
  function saveNow(next: TaskConfig): TaskIndexItem {
    cache.set(next.id, next)
    writeJsonAtomic(configFile(next.id), next)
    pending.delete(next.id)
    const it = upsertIndexItem(next)
    sortAndWriteIndex()
    changed()
    return it
  }

  /** 新页的默认名字：用没被占用的最小序号，删掉中间页之后再建不会重名 */
  function nextPageName(pages: TaskPage[]): string {
    const used = new Set(pages.map((p) => p.name))
    for (let n = pages.length + 1; ; n++) {
      const candidate = `第 ${n} 页`
      if (!used.has(candidate)) return candidate
    }
  }

  function nextPageId(pages: TaskPage[]): string {
    for (let n = pages.length + 1; ; n++) {
      const candidate = `p${n}`
      if (!pages.some((p) => p.id === candidate)) return candidate
    }
  }

  function pageCreate(id: string, input: PageInput): TaskConfig | null {
    const cfg = getCfg(id)
    if (!cfg) return null
    const pages = pagesOf(cfg)
    const pageId = nextPageId(pages)
    const explicit = (input.name ?? '').trim().slice(0, 80)
    const page: TaskPage = {
      id: pageId,
      name: explicit || nextPageName(pages),
      nameAuto: !explicit,
      capturedAt: iso(),
      ...(input.url ? { url: input.url } : {}),
      ...(input.fp ? { fp: input.fp } : {}),
      ...(input.sig ? { sig: input.sig } : {}),
      questions: [],
      answers: {}
    }
    const next = withMirror(cfg, [...pages, page], pageId)
    if (input.html) writePageHtml(id, pageId, input.html)
    saveNow(next)
    return next
  }

  function pageSelect(id: string, pageId: string): TaskConfig | null {
    const cfg = getCfg(id)
    if (!cfg) return null
    const pages = pagesOf(cfg)
    if (!pages.some((p) => p.id === pageId)) return null
    const next = withMirror(cfg, pages, pageId)
    saveNow(next)
    return next
  }

  function pagePatch(id: string, pageId: string, p: PagePatch): TaskConfig | null {
    const cfg = getCfg(id)
    if (!cfg) return null
    let hit = false
    const pages = pagesOf(cfg).map((pg) => {
      if (pg.id !== pageId) return pg
      hit = true
      const next: TaskPage = { ...pg }
      if (typeof p.name === 'string') {
        const trimmed = p.name.trim().slice(0, 80)
        // 空名字视为误操作：不动名字，也不动「是不是自动起的」标记
        if (trimmed) {
          next.name = trimmed
          next.nameAuto = p.nameAuto === true
        }
      } else if (typeof p.nameAuto === 'boolean') {
        next.nameAuto = p.nameAuto
      }
      // 辅助字段统一走「给了就用，空串/undefined = 没有」
      const keep = (v: unknown): string | undefined =>
        typeof v === 'string' && v ? v : undefined
      if ('capturedAt' in p) next.capturedAt = keep(p.capturedAt)
      if ('url' in p) next.url = keep(p.url)
      if ('fp' in p) next.fp = keep(p.fp)
      if ('sig' in p) next.sig = keep(p.sig)
      if ('questions' in p) next.questions = p.questions ?? []
      if ('answers' in p) next.answers = p.answers ?? {}
      if ('questionsFor' in p) next.questionsFor = keep(p.questionsFor)
      if ('answersFor' in p) next.answersFor = keep(p.answersFor)
      return next
    })
    if (!hit) return null
    const next = withMirror(cfg, pages, cfg.activePageId ?? '')
    cache.set(id, next)
    pending.set(id, next)
    scheduleWrite()
    upsertIndexItem(next)
    return next
  }

  function pageHtml(id: string, pageId: string): string | null {
    if (!existsSync(taskDir(id))) return null
    return readPageHtml(id, pageId)
  }

  function pageSetHtml(id: string, pageId: string, html: string): boolean {
    const cfg = getCfg(id)
    if (!cfg || !pagesOf(cfg).some((p) => p.id === pageId)) return false
    writePageHtml(id, pageId, html)
    loadIndex()
    const it = index.find((i) => i.id === id)
    if (it) {
      it.hasHtml = hasAnyHtml(id, cfg)
      sortAndWriteIndex()
      changed()
    }
    return true
  }

  function pageDelete(id: string, pageId: string): TaskConfig | null {
    const cfg = getCfg(id)
    if (!cfg) return null
    const pages = pagesOf(cfg)
    const idx = pages.findIndex((p) => p.id === pageId)
    if (idx < 0) return null

    if (pages.length === 1) {
      // 只剩一页时「删除」= 清空这一页（任务永远至少留一页，界面才有落点）
      const only: TaskPage = {
        id: pages[0].id,
        name: pages[0].name,
        nameAuto: pages[0].nameAuto,
        questions: [],
        answers: {}
      }
      writePageHtml(id, only.id, '')
      const next = withMirror(cfg, [only], only.id)
      saveNow(next)
      return next
    }

    const rest = pages.filter((p) => p.id !== pageId)
    const stillActive = rest.some((p) => p.id === cfg.activePageId)
    // 删掉的是当前页 → 落到它原来位置的邻居上（优先后一页，像关标签页）
    const nextActive = stillActive
      ? (cfg.activePageId as string)
      : (rest[Math.min(idx, rest.length - 1)] ?? rest[0]).id
    writePageHtml(id, pageId, '')
    const next = withMirror(cfg, rest, nextActive)
    saveNow(next)
    return next
  }

  function snapshots(id: string): SnapshotMeta[] {
    return readSnapshotMetas(id)
  }

  function rollback(id: string, ts: string): TaskConfig | null {
    const snap = readSnapshot(id, ts)
    if (!snap) return null
    const cur = getCfg(id)
    if (!cur) return null
    // 当前状态先留档（连 HTML 一起，免得回滚把当前这一页弄丢了）
    createSnapshot(id, 'pre-rollback', { withHtml: true })
    // 只回滚「内容」，不回滚名字 —— 改名是用户对身份的调整，不该被回滚带走
    const next: TaskConfig = { ...snap, id: cur.id, name: cur.name, nameAuto: cur.nameAuto }
    writeJsonAtomic(configFile(id), next)
    cache.set(id, next)
    pending.delete(id)
    // 该快照存过 HTML 就连页面一起还原（老快照没存过 → 保持当前 HTML 不动）
    restoreSnapshotHtml(id, ts, next)
    const it = upsertIndexItem(next)
    it.hasHtml = hasAnyHtml(id, next)
    sortAndWriteIndex()
    changed()
    return next
  }

  function trash(id: string): boolean {
    const cfg = getCfg(id)
    if (!cfg) return false
    flush() // 保证最新内容先落盘，回收站里的即是删除那一刻的状态
    const from = taskDir(id)
    if (!existsSync(from)) return false
    const to = trashItemDir(id)
    if (existsSync(to)) removeDir(to)
    moveDir(from, to)
    const it = index.find((i) => i.id === id)
    const meta: TrashMeta = {
      deletedAt: iso(),
      name: cfg.name,
      questionCount: totalQuestions(cfg),
      createdAt: it?.createdAt ?? iso()
    }
    writeJsonAtomic(join(to, 'meta.json'), meta)
    cache.delete(id)
    pending.delete(id)
    lastAutoAt.delete(id)
    loadIndex()
    index = index.filter((i) => i.id !== id)
    sortAndWriteIndex()
    changed()
    return true
  }

  function listTrash(): TrashItem[] {
    const days = settings().trashRetentionDays
    return listDirs(trashDir)
      .map((id) => {
        const meta = readJson<TrashMeta>(join(trashItemDir(id), 'meta.json'))
        const dir = trashItemDir(id)
        const cfgRead = readJson<TaskConfig>(join(dir, 'config.json'))
        const m = meta.ok ? meta.data : null
        const deletedAt = m?.deletedAt ?? mtimeIso(dir)
        const name = m?.name ?? (cfgRead.ok ? asString(cfgRead.data?.name, id) : id)
        const questionCount =
          m?.questionCount ??
          (cfgRead.ok && Array.isArray(cfgRead.data?.questions) ? cfgRead.data.questions.length : 0)
        return {
          id,
          name,
          deletedAt,
          questionCount,
          expiresAt: days > 0 ? new Date(Date.parse(deletedAt) + days * 86_400_000).toISOString() : null
        } satisfies TrashItem
      })
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  }

  function restore(id: string): TaskIndexItem | null {
    const from = trashItemDir(id)
    if (!existsSync(from)) return null
    const r = readJson<TaskConfig>(join(from, 'config.json'))
    if (!r.ok) return null // 配置读不出来就拒绝恢复，留在回收站里
    const meta = readJson<TrashMeta>(join(from, 'meta.json'))
    loadIndex()

    let targetId = id
    if (existsSync(taskDir(id))) targetId = genId()
    const cfg = normalizeConfig(r.data, targetId)
    cfg.name = uniqueName(meta.ok ? meta.data.name : cfg.name)
    moveDir(from, taskDir(targetId))
    if (existsSync(join(taskDir(targetId), 'meta.json'))) {
      removeFile(join(taskDir(targetId), 'meta.json'))
    }
    writeJsonAtomic(configFile(targetId), cfg)
    cache.set(targetId, cfg)
    const it = upsertIndexItem(cfg)
    it.createdAt = meta.ok && meta.data.createdAt ? meta.data.createdAt : iso()
    it.updatedAt = iso()
    it.hasHtml = hasAnyHtml(targetId, cfg)
    sortAndWriteIndex()
    changed()
    return it
  }

  function purge(id: string): boolean {
    const dir = trashItemDir(id)
    if (!existsSync(dir)) return false
    removeDir(dir)
    return true
  }

  function emptyTrash(): number {
    const ids = listDirs(trashDir)
    for (const id of ids) removeDir(trashItemDir(id))
    return ids.length
  }

  function cleanExpiredTrash(): number {
    const days = settings().trashRetentionDays
    if (days <= 0) return 0
    const nowMs = now().getTime()
    let removed = 0
    for (const item of listTrash()) {
      if (!item.expiresAt) continue
      if (Date.parse(item.expiresAt) <= nowMs) {
        removeDir(trashItemDir(item.id))
        removed += 1
      }
    }
    return removed
  }

  function saveSettings(p: Partial<TaskStoreSettings>): TaskStoreSettings {
    const next: TaskStoreSettings = { ...settings(), ...p }
    ensureDir(tasksDir)
    writeJsonAtomic(settingsFile, next)
    return next
  }

  function exportTasks(ids: string[] | 'all', includeHtml: boolean): ExportFile {
    const targets = ids === 'all' ? list().map((i) => i.id) : ids
    const tasks: ExportedTask[] = []
    for (const id of targets) {
      const cfg = getCfg(id)
      if (!cfg) continue
      const t: ExportedTask = {
        name: cfg.name,
        nameAuto: cfg.nameAuto === true,
        link: cfg.link,
        autoSubmit: cfg.autoSubmit,
        channel: cfg.channel,
        questions: cfg.questions,
        answers: cfg.answers
      }
      // 页存档：多页任务全靠它，否则换台机器就只剩当前这一页
      const pages = pagesOf(cfg)
      if (pages.length > 0) {
        t.pages = pages.map((pg): ExportedPage => {
          const html = includeHtml ? readPageHtml(id, pg.id) : null
          return { ...pg, ...(html ? { html } : {}) }
        })
        t.activePageId = cfg.activePageId || pages[0].id
      }
      if (includeHtml) {
        const h = getHtml(id)
        if (h) {
          t.sourceHtml = h
          // 指纹是「这份 HTML 的」—— 只有连着 HTML 一起导出才有意义，否则到对面永远对不上号
          if (cfg.questionsFor) t.questionsFor = cfg.questionsFor
          if (cfg.answersFor) t.answersFor = cfg.answersFor
        }
      }
      tasks.push(t)
    }
    return {
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_VERSION,
      exportedAt: iso(),
      tasks
    }
  }

  function importTasks(file: ExportFile): ImportOutcome {
    if (!file || file.format !== EXPORT_FORMAT) {
      throw new Error('文件格式不匹配（期望「表单填写器」导出的配置文件）')
    }
    if (typeof file.formatVersion !== 'number' || file.formatVersion > EXPORT_VERSION) {
      throw new Error(`配置版本不支持：${String(file.formatVersion)}（本版本最高支持 ${EXPORT_VERSION}）`)
    }
    if (!Array.isArray(file.tasks)) throw new Error('文件内容缺少 tasks 数组')

    const imported: TaskIndexItem[] = []
    const failed: { name: string; reason: string }[] = []

    // 文件来自外部，tasks 里可能是任意东西，一律按 unknown 校验
    for (const raw of file.tasks as unknown[]) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        failed.push({ name: '（无法识别的条目）', reason: '条目不是对象' })
        continue
      }
      const o = raw as Record<string, unknown>
      const label = asString(o.name, '未命名任务') || '未命名任务'
      try {
        const questions = sanitizeQuestions(o.questions)
        const answers = sanitizeAnswers(o.answers)
        const it = create(label)
        const common = {
          id: it.id,
          name: it.name,
          // 旧导出文件无此字段：按名字是否形如「任务 N」推断
          nameAuto: typeof o.nameAuto === 'boolean' ? o.nameAuto : /^任务 \d+$/.test(it.name),
          link: asString(o.link),
          autoSubmit: asBool(o.autoSubmit),
          channel: asString(o.channel)
        }
        // 指纹只在连 HTML 一起导入时才带上（没有 HTML 就对不上号，留空由界面载入时回填）
        const srcHtml = typeof o.sourceHtml === 'string' ? o.sourceHtml : ''
        const pages = sanitizePages(o.pages)
        let cfg: TaskConfig
        if (pages.length > 0) {
          const want = typeof o.activePageId === 'string' ? o.activePageId : ''
          const activePageId = pages.some((p) => p.id === want) ? want : pages[0].id
          cfg = withMirror({ ...common, questions: [], answers: {} }, pages, activePageId)
          // 文件里的 pages 与清洗后的页一一对应（sanitizePages 只丢弃非对象项，故先过滤再配对）
          const raws = (Array.isArray(o.pages) ? o.pages : []).filter(
            (x) => !!x && typeof x === 'object' && !Array.isArray(x)
          ) as Record<string, unknown>[]
          pages.forEach((pg, i) => {
            const html = typeof raws[i]?.html === 'string' ? (raws[i].html as string) : ''
            if (html) writePageHtml(it.id, pg.id, html)
          })
        } else {
          // 老版本导出文件：只有顶层一份内容 → 合成单页
          cfg = { ...common, questions, answers }
          if (srcHtml) {
            if (typeof o.questionsFor === 'string' && o.questionsFor) cfg.questionsFor = o.questionsFor
            if (typeof o.answersFor === 'string' && o.answersFor) cfg.answersFor = o.answersFor
          }
          cfg = normalizeConfig(cfg, it.id)
          if (srcHtml) writePageHtml(it.id, firstPageId(cfg), srcHtml)
        }
        writeJsonAtomic(configFile(it.id), cfg)
        cache.set(it.id, cfg)
        const updated = upsertIndexItem(cfg)
        imported.push(updated)
      } catch (e) {
        failed.push({ name: label, reason: e instanceof Error ? e.message : String(e) })
      }
    }

    sortAndWriteIndex()
    changed()
    return { imported, failed, canceled: false }
  }

  function migrateFromProjects(): MigrationReport | null {
    if (existsSync(migrationFile)) return null
    if (!existsSync(projectsDir)) return null

    const names = listDirs(projectsDir)
    const skipped: string[] = []
    let count = 0
    const migrated: { it: TaskIndexItem; mtime: string }[] = []

    for (const name of names) {
      const file = join(projectsDir, name, 'project.json')
      const r = readJson<Record<string, unknown>>(file)
      if (!r.ok) {
        skipped.push(name)
        continue
      }
      const d = r.data ?? {}
      const id = genId()
      const cfg: TaskConfig = {
        id,
        name,
        link: asString(d.link),
        autoSubmit: asBool(d.autoSubmit),
        channel: asString(d.channel),
        questions: sanitizeQuestions(d.questions),
        answers: sanitizeAnswers(d.answers)
      }
      writeJsonAtomic(configFile(id), cfg)
      cache.set(id, cfg)
      const it = upsertIndexItem(cfg)
      const mt = mtimeIso(file)
      it.createdAt = mt
      it.updatedAt = mt
      migrated.push({ it, mtime: mt })
      count += 1
    }

    if (count === 0) return null // 没有可迁移内容：原目录保持不动，下次启动再试

    migrated.sort((a, b) => a.mtime.localeCompare(b.mtime))
    migrated.forEach((m, i) => {
      m.it.order = i
    })
    // 迁移进来的排在已有任务之前（迁移只会发生在首次启动，实际上这里是全量）
    sortAndWriteIndex()

    const backupDir = `projects.migrated-${stamp()}`
    try {
      moveDir(projectsDir, join(root, backupDir))
    } catch {
      // 备份改名失败不算致命：数据已迁到 tasks/，原目录留着也只是占空间
      writeJsonAtomic(migrationFile, { from: 'projects', at: iso(), count, skipped, backupDir: null })
      changed()
      return { count, skipped, backupDir: '' }
    }
    writeJsonAtomic(migrationFile, { from: 'projects', at: iso(), count, skipped, backupDir })
    changed()
    return { count, skipped, backupDir }
  }

  // 构造即加载：崩溃残留清理、索引重建、磁盘与索引对齐都发生在启动那一刻，
  // 而不是拖到第一次 list() —— 否则残留在下次真正读盘前一直留着。
  loadIndex()

  return {
    root,
    list,
    get: getCfg,
    create,
    patch,
    rename,
    duplicate,
    reorder,
    reset,
    remove,
    getHtml,
    setHtml,
    pageCreate,
    pageSelect,
    pagePatch,
    pageHtml,
    pageSetHtml,
    pageDelete,
    snapshots,
    createSnapshot,
    readSnapshot,
    rollback,
    trash,
    listTrash,
    restore,
    purge,
    emptyTrash,
    cleanExpiredTrash,
    settings,
    saveSettings,
    exportTasks,
    importTasks,
    migrateFromProjects,
    flush
  }
}
