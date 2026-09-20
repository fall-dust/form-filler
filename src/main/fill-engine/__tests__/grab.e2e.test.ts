import { describe, it, expect } from 'vitest'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { ensureSession, getLiveSession, closeSession } from '../session'
import { grabCurrentHtml, waitForGrabReady, readyHint } from '../grab'
import { runFill } from '../engine'
import type { ParsedQuestion } from '../types'

const cwd = process.cwd()
const sampleUrl = (name: string): string => pathToFileURL(resolve(cwd, 'samples', name)).href
const dataUrl = (body: string, script = ''): string =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<!DOCTYPE html><html lang="zh-CN"><head><title>测试页</title></head><body>${body}${
      script ? `<script>${script}</script>` : ''
    }</body></html>`
  )

/**
 * 「启动浏览器」与「抓取」是两件独立的事：
 * - 启动（ensureSession）只打开目标页面，**不抓取** —— 题目/答案还没生成也能先把页面开起来；
 * - 抓取（grabCurrentHtml）只在用户明确点击时执行，且必须**已有窗口** + **页面已加载好**，
 *   否则会抓回空壳（用户反馈过「还没加载好就抓，这是不行的」）。
 */
describe('启动浏览器：只打开目标页面', () => {
  it('打开后窗口停在目标链接上，页面内容原样保留（没有抓取动作）', async () => {
    const key = 'open-only'
    expect(getLiveSession(key)).toBeNull()

    try {
      const r = await ensureSession(key, sampleUrl('form_sample.html'), { headless: true }, 200)
      expect(r.opened).toBe(true)

      const s = getLiveSession(key)
      expect(s).not.toBeNull()
      expect(s!.link).toBe(sampleUrl('form_sample.html'))
      expect(s!.page.url()).toContain('form_sample.html')
      // 控件都在原位：启动流程不碰页面
      expect(await s!.page.locator('#name').count()).toBe(1)
    } finally {
      await closeSession(key)
    }
  }, 120000)

  it('已有窗口且链接未变 → 复用（不重开、不重新导航）；链接改了才重开', async () => {
    const key = 'open-reuse'
    try {
      const r1 = await ensureSession(key, sampleUrl('form_sample.html'), { headless: true }, 200)
      expect(r1.opened).toBe(true)

      // 在页面上留个标记：若发生重新导航，标记会消失
      await r1.session.page.evaluate(() => {
        ;(window as unknown as { __mark?: number }).__mark = 7
      })

      const r2 = await ensureSession(key, sampleUrl('form_sample.html'), { headless: true }, 200)
      expect(r2.opened).toBe(false) // 复用，没重开
      expect(r2.session.page).toBe(r1.session.page) // 同一个 Page
      expect(
        await r2.session.page.evaluate(() => (window as unknown as { __mark?: number }).__mark)
      ).toBe(7) // 没重新导航

      // 目标链接改了 → 关掉旧窗口、按新链接重开（不能把两件事混在一个窗口里）
      const other = sampleUrl('iframe_child.html')
      const r3 = await ensureSession(key, other, { headless: true }, 200)
      expect(r3.opened).toBe(true)
      expect(r3.session.link).toBe(other)
      expect(r3.session.page).not.toBe(r1.session.page)
      expect(r3.session.page.url()).toContain('iframe_child.html')
    } finally {
      await closeSession(key)
    }
  }, 120000)
})

describe('抓取前的就绪判定：页面没长好就先不抓', () => {
  it('页面迟到渲染出控件 → 等它出来才判定就绪（不抓空壳）', async () => {
    const key = 'grab-wait-late'
    // 起手页面「什么都没有」：没有控件、也没有正文 —— 此时抓只会抓到空壳。
    // 控件由测试**在等待开始之后**才注入，于是「等到就绪」只能是真等，而不是碰巧撞上
    // （早先写成页内 setTimeout(1200)，在整包并行跑、CPU 抢占时会把「等待」压在启动耗时里，
    //   断言 waited>=900 就会偶发失败 —— 改为由测试侧控制注入时机）。
    const link = dataUrl('<div id="root"></div>')
    try {
      const r = await ensureSession(key, link, { headless: true }, 100)

      const t0 = Date.now()
      const pending = waitForGrabReady(r.session.page, 8000)
      const injected = new Promise<void>((done) => {
        setTimeout(() => {
          void r.session.page
            .evaluate(() => {
              const i = document.createElement('input')
              i.id = 'late'
              const root = document.getElementById('root')
              if (root) root.appendChild(i)
            })
            .then(
              () => done(),
              () => done()
            )
        }, 500)
      })

      const probe = await pending
      const waited = Date.now() - t0
      await injected

      expect(probe.ok).toBe(true)
      expect(probe.controls).toBeGreaterThanOrEqual(1)
      // 页面起手是空的：只有控件注入之后才可能判就绪 —— 若「没等」，这里只会拿到 ok=false 的空壳
      expect(waited).toBeGreaterThanOrEqual(400)

      // 此时抓回来才拿得到那个迟到的控件
      const g = await grabCurrentHtml(r.session.page)
      expect(g.html).toContain('id="late"')
    } finally {
      await closeSession(key)
    }
  }, 120000)

  it('页面始终没有内容 → 判定未就绪，并给出可读提示', async () => {
    const key = 'grab-empty'
    try {
      const r = await ensureSession(key, dataUrl('<div></div>'), { headless: true }, 100)
      const probe = await waitForGrabReady(r.session.page, 1200)
      expect(probe.ok).toBe(false)
      expect(probe.controls).toBe(0)
      expect(probe.closed).toBe(false)
      expect(readyHint(probe)).toContain('页面')
    } finally {
      await closeSession(key)
    }
  }, 120000)

  it('窗口已被关掉 → 判定为 closed，提示重新启动浏览器', async () => {
    const key = 'grab-closed'
    try {
      const r = await ensureSession(key, dataUrl('<input id="a" type="text">'), {
        headless: true
      }, 100)
      await r.session.page.close()

      const probe = await waitForGrabReady(r.session.page, 800)
      expect(probe.ok).toBe(false)
      expect(probe.closed).toBe(true)
      expect(readyHint(probe)).toContain('启动浏览器')
    } finally {
      await closeSession(key)
    }
  }, 120000)
})

describe('抓取当前页 HTML', () => {
  it('收录主 frame + 含表单控件的子 frame，并剥掉 script/style', async () => {
    const key = 'grab-content'
    try {
      const r = await ensureSession(key, sampleUrl('form_sample.html'), { headless: true }, 200)
      const g = await grabCurrentHtml(r.session.page)

      // 主 frame + samples/iframe_child.html（含表单控件）→ 至少 2 个 frame
      expect(g.frames).toBeGreaterThanOrEqual(2)
      expect(g.html).toContain('id="name"') // 主 frame 的控件
      expect(g.html).toContain('id="child-name"') // iframe 内控件也被收录
      expect(g.html).toContain('<!-- frame:') // 子 frame 标了来源
      expect(g.html).not.toContain('<script') // 噪音已剥掉
      expect(g.html).not.toContain('<style')
    } finally {
      await closeSession(key)
    }
  }, 120000)

  it('窗口打开过的页面能被「开始填写」直接复用 —— 不重开、不回到第 1 页', async () => {
    const key = 'grab-then-fill'
    const link = dataUrl('<form><input id="a" type="text"></form>')
    const q: ParsedQuestion = {
      id: 'q1',
      question: '姓名？',
      type: 'text',
      options: [],
      optionValues: [],
      selectors: [{ css: '#a' }]
    }

    try {
      // 第一步：先「启动浏览器」把页面打开（此时还没有题目/答案）
      const r = await ensureSession(key, link, { headless: true }, 200)
      expect(r.opened).toBe(true)
      await r.session.page.evaluate(() => {
        ;(window as unknown as { __touched?: boolean }).__touched = true
      })

      // 第二步：生成题目后点「开始填写」→ 必须复用刚才那个窗口/页面
      const f = await runFill(
        {
          config: {
            link,
            headless: true,
            waitTimeout: 5000,
            waitAfterLoad: 200,
            outputDir: resolve(cwd, 'out', 'test-output')
          },
          questions: [q],
          answers: { q1: '张三' }
        },
        { getSession: () => getLiveSession(key) }
      )

      expect(f.reused).toBe(true)
      expect(f.report.reusedSession).toBe(true)
      expect(f.report.summary.filled).toBe(1)
      expect(f.page).toBe(r.session.page) // 同一个 Page：没有重开浏览器
      expect(await f.page.inputValue('#a')).toBe('张三')
      expect(
        await f.page.evaluate(() => (window as unknown as { __touched?: boolean }).__touched)
      ).toBe(true) // 仍停在打开时那个页面，没被重新导航
    } finally {
      await closeSession(key)
    }
  }, 120000)
})
