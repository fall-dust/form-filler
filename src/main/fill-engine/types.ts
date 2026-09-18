/** 题目题型 */
export type QuestionType =
  | 'text'
  | 'textarea'
  | 'radio'
  | 'judge'
  | 'checkbox'
  | 'select'
  | 'date'
  | 'file'
  | 'matrix'

/** 单条定位策略（回退链中的一项） */
export interface SelectorStrategy {
  css?: string
  xpath?: string
  text?: string
}

/** 一道题（AI 导入 / 配置产物） */
export interface ParsedQuestion {
  id: string
  question: string
  type: QuestionType
  options: string[]
  optionValues: string[]
  matrixRows?: string[]
  selectors: SelectorStrategy[]
  hint?: string
}

export type AnswerValue = string | string[]

export interface FillConfig {
  link: string
  hasLogin?: boolean
  headless?: boolean
  /** 单字段定位等待上限(ms) */
  waitTimeout?: number
  /** 页面加载后额外等待(ms) */
  waitAfterLoad?: number
  /** 每步操作间隔(ms) */
  slowMo?: number
  screenshotOnFail?: boolean
  /** 报告/截图输出目录 */
  outputDir: string
  /** 断点续填状态文件路径 */
  statePath?: string
  /** 登录态持久化目录（Playwright user_data_dir） */
  userDataDir?: string
  /** chromium 可执行文件路径（打包后指向随包分发的浏览器；dev 留空用默认） */
  executablePath?: string
  /** 复用系统浏览器（免打包内核，瘦身用）；设置后忽略 executablePath */
  channel?: 'chrome' | 'msedge'
}

export interface FillRequest {
  config: FillConfig
  questions: ParsedQuestion[]
  answers: Record<string, AnswerValue>
  onlyMissing?: boolean
  dryRun?: boolean
}

export type FieldStatus = 'filled' | 'missing' | 'failed'

export interface FieldResult {
  id: string
  status: FieldStatus
  strategy?: string
  answer?: string
  error?: string
}

export interface FillReport {
  runTime: string
  siteLink: string
  dryRun: boolean
  fields: FieldResult[]
  summary: { total: number; filled: number; missing: number; failed: number }
  screenshots?: string[]
}

export interface FillProgress {
  id: string
  index: number
  total: number
  status: FieldStatus
  answer?: string
  message?: string
}
