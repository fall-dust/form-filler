/**
 * 题型 / 定位策略 / 题目结构 —— **唯一定义在 `src/shared/contracts/question.ts`**。
 *
 * 这里只做转出：引擎内部大量文件从 `./types` 取这几个名字，保留这个入口可以让
 * 「单一知识源」落地时不必把改名扩散到整个引擎。原先那份手写枚举已删除。
 */
import type { Question } from '../../shared/contracts/question'

export type { QuestionType, SelectorStrategy } from '../../shared/contracts/question'

/**
 * 一道题（导入 / 配置产物）。
 * 与渲染层的 `Question` 是**同一个类型**（两侧曾各写一遍，字段完全一致），此处保留旧名。
 */
export type ParsedQuestion = Question

export type AnswerValue = string | string[]

export interface FillConfig {
  link: string
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
  /** 登录态持久化目录（Playwright user_data_dir）：cookie 落盘，关掉浏览器重开仍在 */
  userDataDir?: string
  /** chromium 可执行文件路径（打包后指向随包分发的浏览器；dev 留空用默认） */
  executablePath?: string
  /** 复用系统浏览器（免打包内核，瘦身用）；设置后忽略 executablePath */
  channel?: 'chrome' | 'msedge'
  /**
   * 全部填写成功后自动点击提交按钮。
   * 默认 false（人工核对后手动提交，见需求文档 §6 硬约束）。
   * 存在未填写/失败题目时不会提交。
   */
  autoSubmit?: boolean
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
  /** 填写后回读校验是否通过（soft 校验题型不匹配时仍为 filled 但 verified=false） */
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
  /** 未提交的原因（未开启/有未完成项/未找到提交按钮/点击失败） */
  submitError?: string
  /**
   * 已点击提交且观测到页面响应（submit 事件 / 网络请求 / 页面跳转 / 按钮变禁用 / URL 变化）。
   * 只有 submitted 为真时才有值；false 表示「点下去了但无法确认是否提交成功」。
   * 独立成字段（而不只是写在 submitNote 文案里），便于后续接提交状态机或按结果分支。
   */
  submitConfirmed?: boolean
  /** 已点击提交但未检测到页面响应时的提示（请人工确认） */
  submitNote?: string
  /**
   * 多页问卷「接着填」：本次运行复用了已打开的浏览器窗口、在其当前页面接着填，
   * 而非重新打开并导航到目标链接。仅复用时出现。
   */
  reusedSession?: boolean
}

export interface FillProgress {
  id: string
  index: number
  total: number
  /**
   * 'filling' = 这道题**刚开始填**（用于界面实时反馈：状态栏立刻从
   * 「正在启动浏览器」变成「正在填写 x/y」、该题亮起「填写中…」），
   * 不计入结果，也不会出现在报告里 —— 每题的最终结果仍由后续事件给出。
   */
  status: FieldStatus | 'filling'
  answer?: string
  message?: string
}
