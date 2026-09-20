/**
 * 题型 / 定位策略 / 题目结构 —— **唯一定义在 `src/shared/contracts/question.ts`**。
 *
 * 原先渲染层与主进程各写了一份完全相同的定义（题型枚举算上提示词与清洗白名单共四份）。
 * 这里只做转出，既有 `from './types'` 的引用一律不用改。
 */
import type { Question } from '../../shared/contracts/question'

export type { Question, QuestionType, SelectorStrategy } from '../../shared/contracts/question'

export type FieldStatus = 'filled' | 'missing' | 'failed'

export interface FieldResult {
  id: string
  status: FieldStatus
  strategy?: string
  answer?: string
  error?: string
  /** 填写后回读校验未通过（宽松题型仍标记 filled） */
  verified?: boolean
}

export interface FillReport {
  runTime: string
  siteLink: string
  dryRun: boolean
  fields: FieldResult[]
  summary: { total: number; filled: number; missing: number; failed: number }
  screenshots?: string[]
  /** autoSubmit 开启且成功点击了提交按钮 */
  submitted?: boolean
  /** 未提交的原因 */
  submitError?: string
  /** 已点击提交且观测到页面响应（submit 事件/请求/跳转/按钮禁用/URL 变化）；仅 submitted 为真时有值 */
  submitConfirmed?: boolean
  /** 已点击提交但未检测到页面响应时的提示（请人工确认） */
  submitNote?: string
  /** 多页问卷「接着填」：本次复用了已打开的浏览器窗口、在其当前页继续填（而非重开） */
  reusedSession?: boolean
}

export interface FillProgress {
  id: string
  index: number
  total: number
  /** 'filling' = 这题刚开始填（仅界面反馈，不计入结果/报告） */
  status: FieldStatus | 'filling'
  answer?: string
  message?: string
}

// ---- 任务（自动持久化；任务 = 标签 = 落盘实体） ----

/**
 * 多页问卷的**一页存档**：HTML 存在 `tasks/<id>/pages/<pageId>.html`，题目与答案跟着这一页走。
 *
 * 「多页不必反复重来」靠它实现：每页各自留着自己的题目与答案，翻回旧页直接沿用。
 */
export interface TaskPage {
  id: string
  name: string
  /** 名字是否程序自动起的（页面标题 / 「第 N 页」）；用户改过之后置 false */
  nameAuto?: boolean
  capturedAt?: string
  url?: string
  /** 这一页 HTML 的精确指纹（freshness.fingerprint） */
  fp?: string
  /** 这一页 HTML 的结构签名（只看文字与标签结构，忽略属性与长数字）—— 判断「还是同一页」 */
  sig?: string
  questions: Question[]
  answers: Record<string, string>
  questionsFor?: string
  answersFor?: string
}

/** 识别到的候选「下一页」按钮（主进程 next-button.ts 的返回形状） */
export interface NextButton {
  text: string
  selector: string
  tag: string
  score: number
  /** 当前是否禁用 —— 禁用的按钮点了也没用，界面要照实说 */
  disabled: boolean
  /** 所在 frame 的 URL（'' = 主 frame） */
  frameUrl: string
}

export interface TaskConfig {
  id: string
  name: string
  /** 名字是否由程序自动生成（默认名或按页面标题起的名） */
  nameAuto?: boolean
  link: string
  /** 全部填写成功后自动提交（默认 false，人工核对后手动提交） */
  autoSubmit: boolean
  channel: string
  /** 页面存档（至少一页；老数据载入时迁移成单页） */
  pages?: TaskPage[]
  /** 当前正在编辑 / 填写的页 */
  activePageId?: string
  /** 当前页的镜像：引擎、快照、导出读的都是这一份 */
  questions: Question[]
  answers: Record<string, string>
  /**
   * 生成题目时所依据的 HTML 指纹（见 freshness.ts）。
   * 与当前 HTML 不符 = 题目是上一版页面生成的 —— 界面据此收回步骤 2 的对钩。
   */
  questionsFor?: string
  /** 生成答案时所依据的题目集指纹；与当前题目不符 = 答案过时，收回步骤 3/4 的对钩 */
  answersFor?: string
}

/** 列表元数据（标签栏 / 任务面板只依赖它） */
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

export type SnapshotLabel = 'auto' | 'manual' | 'key-action' | 'pre-rollback' | 'pre-grab'

export interface SnapshotMeta {
  ts: string
  createdAt: string
  questionCount: number
  answerCount: number
  size: number
  label: SnapshotLabel
  /** 该快照是否连 HTML 源码一起存档（抓取新页面前的自动存档会带上，回滚可连页面一起还原） */
  hasHtml?: boolean
  hash: string
}

export interface TrashItem {
  id: string
  name: string
  deletedAt: string
  questionCount: number
  /** null = 永久保留 */
  expiresAt: string | null
}

export interface TaskStoreSettings {
  trashRetentionDays: number
  autoSnapshotMinutes: number
  snapshotLimit: number
}

export interface SaveStateEvent {
  state: 'saving' | 'saved' | 'error'
  at: number
  message?: string
}

export interface ImportOutcome {
  imported: TaskIndexItem[]
  failed: { name: string; reason: string }[]
  canceled: boolean
}

export interface ExportOutcome {
  canceled: boolean
  path?: string
  message?: string
}

export interface StartupNotice {
  migrated: { count: number; skipped: string[]; backupDir: string } | null
  trashCleaned: number
}
