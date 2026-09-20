/**
 * 任务存储的类型定义（M6）。
 * 「任务」= 标签 = 落盘实体，取代旧的「项目」概念。
 * 详见 任务配置方案.md。
 */
import type { ParsedQuestion } from '../fill-engine/types'

/** 题目结构直接复用填写引擎的定义，避免两套类型漂移 */
export type { ParsedQuestion }

/**
 * 多页问卷的**一页存档**：HTML 存在 `tasks/<id>/pages/<pageId>.html`，题目与答案跟着这一页走。
 *
 * 这是「多页不用重复花 AI 额度」的关键：每一页各自留着自己的题目与答案，
 * 翻回旧页时直接沿用，不需要重新生成（判据见 renderer/src/pages.ts 的 routeGrab）。
 */
export interface TaskPage {
  /** 稳定身份（= HTML 文件名），创建后不变；改名只改 name */
  id: string
  /** 显示名：抓取时取页面标题，取不到就是「第 N 页」；可随时改 */
  name: string
  /** 名字是否程序自动起的（页面标题 / 「第 N 页」）；用户改过之后置 false */
  nameAuto?: boolean
  /** 抓取这一页的时间（ISO）；手工粘贴或自旧数据迁移来的没有 */
  capturedAt?: string
  /** 抓取时的页面 URL，便于事后核对「这是哪一页」 */
  url?: string
  /** 这一页 HTML 的**精确指纹**（renderer freshness.fingerprint） */
  fp?: string
  /**
   * 这一页 HTML 的**结构签名**：只看可见文字、忽略标签属性与长数字（时间戳/随机序号）。
   * 用来判断「抓回来的是不是同一页」—— 同一页重新渲染后 fp 会变，签名不会。
   */
  sig?: string
  questions: ParsedQuestion[]
  answers: Record<string, string>
  /** 这一页的题目是对着哪份 HTML 生成的（步骤 2 对钩的有效性判据） */
  questionsFor?: string
  /** 这一页的答案是对着哪版题目生成的（步骤 3/4 对钩的有效性判据） */
  answersFor?: string
}

/**
 * 任务完整配置，落盘为 tasks/<id>/config.json
 *
 * 登录态**不落配置、也没有开关**：每个任务固定用 `<userData>/profile/<id>` 作浏览器
 * profile 目录，登录一次长期有效（cookie 就存在那个目录里），重开浏览器也不用重新登录。
 * 它与多页「接着填」的会话复用互补 —— 复用管「窗口还活着」，profile 管「窗口关掉之后」。
 * 换账号 / 登录态坏了：界面点「清除登录态」把该目录删掉。
 */
export interface TaskConfig {
  /** 稳定身份（= 目录名），创建后不变；重命名只改 name */
  id: string
  /** 显示名，可随时改，允许与其它任务重名 */
  name: string
  /**
   * 名字是否「程序自动起的」（默认名「任务 N」，或抓取后由 AI 自动命名）。
   * 只有它为 true 时才允许被 AI 命名覆盖 —— 用户手动改过的名字绝不动。
   * 旧数据无此字段：按「是否形如 任务 N」推断，见 store.normalizeConfig。
   */
  nameAuto?: boolean
  link: string
  /** 全部填写成功后自动提交（默认 false，人工核对后手动提交） */
  autoSubmit: boolean
  channel: string
  /**
   * 页面存档。**至少一页**：老数据（没有这个字段）在载入时迁移成单页，
   * 所以读到的 config 永远是 `pages.length >= 1`。
   */
  pages?: TaskPage[]
  /** 当前正在编辑 / 填写的页（= pages 里某一页的 id） */
  activePageId?: string
  /**
   * 下面是**当前页的镜像**，不是独立数据：载入时由 activePage 填出，写入时落回该页。
   * 这样填写引擎、快照、导出这些「只认一份内容」的老代码不必知道「页」的存在。
   */
  questions: ParsedQuestion[]
  answers: Record<string, string>
  /**
   * 生成题目时所依据的 HTML 指纹（见 src/renderer/src/freshness.ts）。
   * 与当前 HTML 不符 = 题目是上一版页面生成的，界面上步骤 2 的对钩要收回。
   * 旧数据无此字段：载入时按「当前 HTML 就是它的来源」回填一次。
   */
  questionsFor?: string
  /** 生成答案时所依据的题目集指纹；与当前题目不符 = 答案过时，步骤 3/4 的对钩要收回 */
  answersFor?: string
}

/** 增量更新负载（id 不可改） */
export type TaskPatch = Partial<Omit<TaskConfig, 'id'>>

/** 新建一页的入参（HTML 由界面抓好后传进来，主进程只负责落盘与记账） */
export interface PageInput {
  /** 显示名；不传则按「第 N 页」自动起 */
  name?: string
  html?: string
  url?: string
  fp?: string
  sig?: string
}

/** 页面存档的增量更新（id 不可改） */
export type PagePatch = Partial<Omit<TaskPage, 'id'>>

/** 列表元数据：标签栏与任务面板只读它，不读全量 config */
export interface TaskIndexItem {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  questionCount: number
  answerCount: number
  hasHtml: boolean
  order: number
}

export interface TaskIndex {
  version: number
  tasks: TaskIndexItem[]
}

/** 快照来源标签 */
export type SnapshotLabel = 'auto' | 'manual' | 'key-action' | 'pre-rollback' | 'pre-grab'

export interface SnapshotMeta {
  /** 主键（= 文件名主干，如 20260919-131500-a1b2；同一秒内多次快照会追加序号） */
  ts: string
  createdAt: string
  questionCount: number
  answerCount: number
  /** 字节数 */
  size: number
  label: SnapshotLabel
  /**
   * 是否连同 HTML 源码一起存档（抓取新页面前的自动存档会带上，回滚可连页面一起还原）。
   * HTML 存在与快照同名的 `快照.ts.html` 旁挂文件里 —— 不塞进 JSON，
   * 这样列历史版本时只读小 JSON，不必把大 HTML 全解析一遍。
   */
  hasHtml?: boolean
  /** 配置内容 hash（去重用：与最新一份相同则跳过自动快照） */
  hash: string
}

/** 快照文件内容：元信息 + 配置拷贝（HTML 若有则存在同名的 .html 旁挂文件里） */
export interface SnapshotFile {
  version: number
  meta: SnapshotMeta
  config: TaskConfig
}

export interface TrashMeta {
  deletedAt: string
  name: string
  questionCount: number
  /** 原始创建时间，恢复时保留身份与排序 */
  createdAt: string
}

export interface TrashItem {
  id: string
  name: string
  deletedAt: string
  questionCount: number
  /** null = 永久保留（保留期设为 0） */
  expiresAt: string | null
}

/** 导出文件里的一页：页面存档 + 可选 HTML 正文（不连 HTML 导出时只带题目与答案） */
export type ExportedPage = TaskPage & { html?: string }

/** 导出文件格式（**刻意不含登录态**：profile 目录里有 cookie，不随文件外传） */
export interface ExportedTask {
  name: string
  /** 旧版本导出文件无此字段（缺省按「是否形如 任务 N」推断） */
  nameAuto?: boolean
  link: string
  /** 旧版本导出文件无此字段（缺省 false） */
  autoSubmit?: boolean
  channel: string
  /** 多页存档；旧版本导出文件没有这个字段，导入时按顶层字段合成单页 */
  pages?: ExportedPage[]
  /** 当前页 id（缺省取第一页） */
  activePageId?: string
  /** 顶层字段 = 当前页镜像（老版本导出文件只有这一份，故继续导出，保持可读） */
  questions: ParsedQuestion[]
  answers: Record<string, string>
  sourceHtml?: string
  /** 步骤对钩用的指纹（仅连 HTML 一起导出时才有意义，缺省读回后由界面回填） */
  questionsFor?: string
  answersFor?: string
}

export interface ExportFile {
  format: 'form-filler-task'
  formatVersion: number
  exportedAt: string
  tasks: ExportedTask[]
}

export interface ImportOutcome {
  imported: TaskIndexItem[]
  failed: { name: string; reason: string }[]
  canceled: boolean
}

/** 存储层设置 */
export interface TaskStoreSettings {
  /** 回收站保留天数；0 = 永久保留 */
  trashRetentionDays: number
  /** 自动快照时间桶（分钟） */
  autoSnapshotMinutes: number
  /** 每任务快照份数上限 */
  snapshotLimit: number
}

export const DEFAULT_SETTINGS: TaskStoreSettings = {
  trashRetentionDays: 30,
  autoSnapshotMinutes: 5,
  snapshotLimit: 20
}

/** 主进程 → 渲染进程的保存态事件 */
export interface SaveStateEvent {
  state: 'saving' | 'saved' | 'error'
  at: number
  message?: string
}

export interface MigrationReport {
  count: number
  skipped: string[]
  backupDir: string
}
