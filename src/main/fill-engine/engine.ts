import type { Browser, BrowserContext, Page } from 'playwright-core'
import { launchBrowser, shutdown } from './browser'
import type {
  AnswerValue,
  FieldResult,
  FillProgress,
  FillReport,
  FillRequest,
  ParsedQuestion
} from './types'
import { resolveQuestion } from './locator'
import { fillByType } from './fillers'
import { verifyFilled, isStrictType, alreadyFilled } from './verify'
import { loadState, saveState, type FieldState } from './state'
import { writeReport, screenshotOnFail } from './report'
import { trySubmit } from './submit'
import { FillStoppedError } from './util'

// FillStoppedError 定义在 util.ts —— 这里原样转出，保持既有 import 路径不变。
export { FillStoppedError }

/** 可复用的页面会话（由调用方保管，供多页问卷「接着填」） */
export interface ReusableSession {
  browser: Browser
  context: BrowserContext
  page: Page
}

export interface FillHooks {
  onProgress?: (p: FillProgress) => void
  /** 返回 true 表示用户请求停止，engine 在每道题之间、每道题内部的各步之间检查 */
  isCancelled?: () => boolean
  /**
   * 取消信号：点「停止」时 resolve。启动浏览器、页面导航这类**没有中间检查点**的
   * 长等待靠它赛跑中断 —— 否则「停止」在启动/导航阶段完全无效（实测踩过）。
   */
  cancelled?: Promise<void>
  /**
   * 多页问卷「接着填」：返回仍存活的会话则**直接复用** —— 不重开浏览器、不重新导航，
   * 在当前页面（用户可能已手动翻到下一页）继续填写，而不是回到表单第 1 页。
   */
  getSession?: () => ReusableSession | null
  /** 会话就绪（新开或复用）后交回调用方保管，供下次复用 */
  onSessionReady?: (s: ReusableSession) => void
}

/**
 * 把一个等待与「停止」信号放在一起赛跑：停止先到 → 抛 FillStoppedError。
 * 输掉赛跑的原等待**不会被中断**（Playwright 没有可中止句柄），由调用方在
 * catch 里收尾（如关掉迟到的启动结果）；这里先挂上空 catch 防未处理 rejection。
 */
async function raceStop<T>(work: Promise<T>, cancelled?: Promise<void>): Promise<T> {
  work.catch(() => {})
  if (!cancelled) return work
  return Promise.race([
    work,
    cancelled.then(() => {
      throw new FillStoppedError()
    })
  ])
}

/**
 * 单题整体时间预算：站点弹遮罩/重渲染拖慢时，一道题最多拖这么久就判失败跳过。
 *
 * 回读类操作一律带短超时后，正常一道题的耗时是「一两秒」量级；25s 已经明显不对劲了。
 * 曾用 60s，问卷网那种「选项文字在兄弟节点」的结构会因回读白等而每题都撞满预算，
 * 用户看到的就是「一直卡住、每题都要等一分钟」。
 */
const QUESTION_BUDGET_MS = 25_000

const DEFAULTS = {
  waitTimeout: 10000,
  waitAfterLoad: 1000,
  slowMo: 0,
  screenshotOnFail: true,
  headless: false
}

export interface FillOutcome {
  report: FillReport
  browser: Browser
  page: Page
  /** 本次是否复用了已打开的浏览器会话（false = 重新打开） */
  reused: boolean
}

export async function runFill(
  req: FillRequest,
  hooks: FillHooks = {}
): Promise<FillOutcome> {
  const cfg = { ...DEFAULTS, ...req.config }

  // 多页问卷「接着填」：有存活会话则复用它 —— 不重开、不重新导航（停在用户当前页）
  const existing = hooks.getSession?.() ?? null
  let browser: Browser
  let context: BrowserContext
  let page: Page
  const reused = existing !== null

  if (existing) {
    browser = existing.browser
    context = existing.context
    page = existing.page
    await page.bringToFront().catch(() => {})
  } else {
    // 启动浏览器。传了 userDataDir 就是持久化 profile：登录态（cookie）落在盘上，重开仍在。
    // launch 挂住时（profile 被残留进程占用等）「停止」也能立刻中断 —— 靠 cancelled 赛跑。
    const launchP = launchBrowser(cfg)
    try {
      ;({ browser, context, page } = await raceStop(launchP, hooks.cancelled))
    } catch (e) {
      if (e instanceof FillStoppedError) {
        // 迟到的启动结果也要收尾，避免留下孤儿浏览器继续锁着 profile 目录。
        // 用 browser.ts#shutdown（CDP 优先）：本环境下 Playwright 的 browser.close() 会一直挂着不返回，
        // 那样 Chromium 根本退不掉，profile 目录锁也就一直释放不了。
        void launchP.then(
          (r) => {
            void shutdown(r.browser).catch(() => {})
          },
          () => {}
        )
      }
      throw e
    }

    try {
      await raceStop(page.goto(cfg.link, { waitUntil: 'domcontentloaded' }), hooks.cancelled)
      await raceStop(page.waitForTimeout(cfg.waitAfterLoad), hooks.cancelled)
    } catch (e) {
      // 导航阶段被停止：会话尚未登记（onSessionReady 未调），浏览器归我们收（同样走 CDP 关闭）
      if (e instanceof FillStoppedError) void shutdown(browser).catch(() => {})
      throw e
    }
  }

  // 会话就绪（新开或复用）后交回调用方保管，供下次复用
  hooks.onSessionReady?.({ browser, context, page })

  // 断点续填：只遍历上次未成功的题（已填写成功的题不再重复操作）
  let questions = req.questions
  if (cfg.statePath && req.onlyMissing) {
    const prior = loadState(cfg.statePath)
    if (Object.keys(prior).length > 0) {
      questions = req.questions.filter((q) => q.id in prior)
    }
  }

  const total = questions.length
  const fields: FieldResult[] = []
  const screenshots: string[] = []
  let processed = 0

  const emit = (r: FieldResult): void => {
    fields.push(r)
    processed++
    hooks.onProgress?.({
      id: r.id,
      index: processed,
      total,
      status: r.status,
      answer: r.answer,
      message: r.error
    })
  }

  /** 填一道题。stopReason() 在每一步之间检查：点「停止」/ 单题超时都能在一两秒内退出 */
  const fillOne = async (q: ParsedQuestion): Promise<FieldResult> => {
    const deadline = Date.now() + QUESTION_BUDGET_MS
    const stopReason = (): string | null => {
      if (hooks.isCancelled?.()) return '用户停止'
      if (Date.now() > deadline) return `单题超时（${QUESTION_BUDGET_MS / 1000}s），已跳过`
      return null
    }

    const answer: AnswerValue | undefined = req.answers[q.id]

    if (answer === undefined || answer === null || answer === '') {
      return { id: q.id, status: 'missing', error: '未配置答案' }
    }
    const shown = Array.isArray(answer) ? answer.join(',') : String(answer)

    // 选择题要求定位到「整组选项」：回退链里若某条只命中单个选项（常见于问卷平台
    // 每个选项 name 不同、或框架自动生成 name 的场景），继续探测后续策略，取命中最多者。
    let reason = stopReason()
    if (reason) return { id: q.id, status: 'failed', error: reason }

    const groupLike = q.type === 'radio' || q.type === 'checkbox' || q.type === 'judge'
    const resolved = await resolveQuestion(
      page,
      q.selectors,
      cfg.waitTimeout,
      groupLike ? Math.max(2, q.options.length) : undefined
    )
    if (!resolved) {
      if (cfg.screenshotOnFail) {
        const p = await screenshotOnFail(page, cfg.outputDir, q.id)
        if (p) screenshots.push(p)
      }
      return { id: q.id, status: 'missing', error: '所有定位策略均未命中' }
    }

    if (req.dryRun) {
      // 干跑：只验证命中，不真正填写
      return { id: q.id, status: 'filled', strategy: resolved.strategy, answer: shown }
    }

    // **先校验后填写**：页面/断点里已经是目标状态就直接采信，不再点击。
    // 重复点击已勾选项会踩坑（如问卷网把重复点选标成 err-option 并弹遮罩，
    // 后续所有点击全被拖到超时，表现为「卡住」）。
    // alreadyFilled 是严格判定（按配置选项下标/精确文本），宽松校验会把
    // 「非常满意」当成「满意」而跳过整题 —— 不能用 verifyFilled 来做这件事。
    if (await alreadyFilled(resolved.loc, q, answer).catch(() => false)) {
      return {
        id: q.id,
        status: 'filled',
        strategy: resolved.strategy,
        answer: shown,
        verified: true
      }
    }

    reason = stopReason()
    if (reason) {
      return { id: q.id, status: 'failed', strategy: resolved.strategy, error: reason }
    }

    // 填写前滚动到可见，降低被遮挡/视口外导致的失败
    await resolved.loc
      .first()
      .scrollIntoViewIfNeeded({ timeout: 2000 })
      .catch(() => {})

    try {
      await fillByType(q, resolved.loc, answer)
      // 填写动作本身也可能被站点拖住（遮罩、重渲染、组件等待）：进回读前再给一次跳出机会
      reason = stopReason()
      if (reason) {
        return { id: q.id, status: 'failed', strategy: resolved.strategy, error: reason }
      }
      // 填写后回读校验；严格题型不符 → 重填一次 → 仍不符判 failed
      let ok = await verifyFilled(resolved.loc, q, answer).catch(() => false)
      if (!ok) {
        reason = stopReason()
        if (reason) {
          return { id: q.id, status: 'failed', strategy: resolved.strategy, error: reason }
        }
        await fillByType(q, resolved.loc, answer)
        ok = await verifyFilled(resolved.loc, q, answer).catch(() => false)
      }
      if (ok || !isStrictType(q.type)) {
        return {
          id: q.id,
          status: 'filled',
          strategy: resolved.strategy,
          answer: shown,
          ...(ok ? {} : { verified: false })
        }
      }

      const failed: FieldResult = {
        id: q.id,
        status: 'failed',
        strategy: resolved.strategy,
        answer: shown,
        error: '填写后校验不一致（重试 1 次仍不符）'
      }
      if (cfg.screenshotOnFail) {
        const p = await screenshotOnFail(page, cfg.outputDir, q.id)
        if (p) screenshots.push(p)
      }
      return failed
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const failed: FieldResult = {
        id: q.id,
        status: 'failed',
        strategy: resolved.strategy,
        answer: shown,
        error: msg
      }
      if (cfg.screenshotOnFail) {
        const p = await screenshotOnFail(page, cfg.outputDir, q.id)
        if (p) screenshots.push(p)
      }
      return failed
    }
  }

  for (const q of questions) {
    if (hooks.isCancelled?.()) break
    // 「开始填」事件先走：状态栏立刻从「正在启动浏览器」切到「正在填写 x/y」，
    // 该题亮起「填写中…」—— 否则一道慢题（站点拖时间）会让界面看起来像死了
    hooks.onProgress?.({ id: q.id, index: processed + 1, total, status: 'filling' })
    emit(await fillOne(q))
  }

  // 汇总
  const summary = {
    total: fields.length,
    filled: fields.filter((f) => f.status === 'filled').length,
    missing: fields.filter((f) => f.status === 'missing').length,
    failed: fields.filter((f) => f.status === 'failed').length
  }

  // 自动提交（可选，默认关闭）：仅当全部题目填写成功才执行，绝不自动重试
  let submitted: boolean | undefined
  let submitConfirmed: boolean | undefined
  let submitError: string | undefined
  let submitNote: string | undefined
  if (cfg.autoSubmit && !req.dryRun) {
    if (summary.missing > 0 || summary.failed > 0) {
      submitError = `存在未完成题目（missing ${summary.missing} / failed ${summary.failed}），已跳过自动提交`
    } else {
      const r = await trySubmit(page)
      submitted = r.submitted
      // 「是否真的提交成功」独立落成字段，不再只藏在提示文案里
      if (r.submitted) submitConfirmed = r.confirmed === true
      if (r.error) submitError = r.error
      else if (r.submitted && !r.confirmed) {
        // 点下去了，但没观测到 submit 事件/请求/导航/按钮禁用——无法确认是否真的提交成功。
        // 常见于异步提交、静默校验拦截、接口静默失败。如实提示交由人工确认，绝不重试点击。
        const who = r.target ? `「${r.target}」` : '提交按钮'
        submitNote = `已点击${who}，但未检测到页面响应（无 submit 事件 / 网络请求 / 页面跳转 / 按钮禁用）。可能是异步提交或校验拦截，请人工确认是否提交成功`
      }
    }
  } else if (cfg.autoSubmit && req.dryRun) {
    submitError = '干跑模式不提交'
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
    ...(screenshots.length > 0 ? { screenshots } : {}),
    ...(submitted !== undefined ? { submitted } : {}),
    ...(submitConfirmed !== undefined ? { submitConfirmed } : {}),
    ...(submitError ? { submitError } : {}),
    ...(submitNote ? { submitNote } : {}),
    // 多页问卷「接着填」：本次是在原浏览器窗口的当前页面继续（而非重新打开）
    ...(reused ? { reusedSession: true } : {})
  }
  writeReport(cfg.outputDir, report)

  return { report, browser, page, reused }
}
