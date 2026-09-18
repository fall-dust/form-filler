import { chromium, type Browser, type Page } from 'playwright'
import type { AnswerValue, FieldResult, FillProgress, FillReport, FillRequest } from './types'
import { resolveQuestion } from './locator'
import { fillByType } from './fillers'
import { loadState, saveState, type FieldState } from './state'
import { writeReport, screenshotOnFail } from './report'

export interface FillHooks {
  onProgress?: (p: FillProgress) => void
  /** has_login 时回调，返回要跳转的新链接（null 表示沿用当前） */
  onNeedLogin?: (currentUrl: string) => Promise<string | null>
  /** 返回 true 表示用户请求停止，engine 在每道题之间检查 */
  isCancelled?: () => boolean
}

export interface FillOutcome {
  report: FillReport
  browser: Browser
  page: Page
}

const DEFAULTS = {
  waitTimeout: 10000,
  waitAfterLoad: 1000,
  slowMo: 0,
  screenshotOnFail: true,
  headless: false
}

export async function runFill(
  req: FillRequest,
  hooks: FillHooks = {}
): Promise<FillOutcome> {
  const cfg = { ...DEFAULTS, ...req.config }

  // 启动浏览器（有 userDataDir 时用持久化 context 保存登录态）
  const launchOpts = {
    headless: cfg.headless,
    slowMo: cfg.slowMo,
    ...(cfg.channel
      ? { channel: cfg.channel }
      : cfg.executablePath
        ? { executablePath: cfg.executablePath }
        : {})
  }
  let browser: Browser
  let context
  if (cfg.userDataDir) {
    context = await chromium.launchPersistentContext(cfg.userDataDir, launchOpts)
    browser = context.browser()!
  } else {
    browser = await chromium.launch(launchOpts)
    context = await browser.newContext()
  }
  const page = await context.newPage()

  await page.goto(cfg.link, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(cfg.waitAfterLoad)

  // 登录环节（不自动检测，完全由 hasLogin 配置驱动，见需求文档 §6）
  if (cfg.hasLogin && hooks.onNeedLogin) {
    const current = page.url()
    const next = await hooks.onNeedLogin(current)
    if (next && next !== current) {
      await page.goto(next, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(cfg.waitAfterLoad)
    }
  }

  // 断点续填：只填 state 中记录的未完成字段
  let targets = req.questions
  if (cfg.statePath && req.onlyMissing) {
    const prior = loadState(cfg.statePath)
    if (Object.keys(prior).length > 0) {
      targets = req.questions.filter((q) => q.id in prior)
    }
  }

  const fields: FieldResult[] = []
  const screenshots: string[] = []
  const total = targets.length

  for (let i = 0; i < targets.length; i++) {
    if (hooks.isCancelled?.()) break
    const q = targets[i]
    const answer: AnswerValue | undefined = req.answers[q.id]
    let result: FieldResult

    if (answer === undefined || answer === null || answer === '') {
      result = { id: q.id, status: 'missing', error: '未配置答案' }
    } else {
      const resolved = await resolveQuestion(page, q.selectors, cfg.waitTimeout)
      if (!resolved) {
        result = { id: q.id, status: 'missing', error: '所有定位策略均未命中' }
        if (cfg.screenshotOnFail) {
          const p = await screenshotOnFail(page, cfg.outputDir, q.id)
          if (p) screenshots.push(p)
        }
      } else if (req.dryRun) {
        // 干跑：只验证命中，不真正填写
        result = { id: q.id, status: 'filled', strategy: resolved.strategy, answer: String(answer) }
      } else {
        try {
          await fillByType(q, resolved.loc, answer)
          result = {
            id: q.id,
            status: 'filled',
            strategy: resolved.strategy,
            answer: Array.isArray(answer) ? answer.join(',') : String(answer)
          }
        } catch (e) {
          result = {
            id: q.id,
            status: 'failed',
            strategy: resolved.strategy,
            answer: Array.isArray(answer) ? answer.join(',') : String(answer),
            error: e instanceof Error ? e.message : String(e)
          }
          if (cfg.screenshotOnFail) {
            const p = await screenshotOnFail(page, cfg.outputDir, q.id)
            if (p) screenshots.push(p)
          }
        }
      }
    }

    fields.push(result)
    hooks.onProgress?.({
      id: q.id,
      index: i + 1,
      total,
      status: result.status,
      answer: result.answer,
      message: result.error
    })
  }

  // 汇总
  const summary = {
    total: fields.length,
    filled: fields.filter((f) => f.status === 'filled').length,
    missing: fields.filter((f) => f.status === 'missing').length,
    failed: fields.filter((f) => f.status === 'failed').length
  }

  // 落盘断点续填状态：只存未完成项
  if (cfg.statePath) {
    const state: Record<string, FieldState> = {}
    for (const f of fields) {
      if (f.status !== 'filled') state[f.id] = f.status
    }
    saveState(cfg.statePath, state)
  }

  const report: FillReport = {
    runTime: new Date().toISOString(),
    siteLink: page.url(),
    dryRun: !!req.dryRun,
    fields,
    summary,
    ...(screenshots.length > 0 ? { screenshots } : {})
  }
  writeReport(cfg.outputDir, report)

  return { report, browser, page }
}
