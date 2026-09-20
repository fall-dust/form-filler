import { describe, it, expect } from 'vitest'
import { resolve } from 'path'
import { runFill, type ReusableSession } from '../engine'
import { getLiveSession, setSession, closeSession } from '../session'
import type { ParsedQuestion } from '../types'

const mk = (body: string): string =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!DOCTYPE html><html lang="zh-CN"><body>${body}</body></html>`)

const q = (id: string, sel: string): ParsedQuestion => ({
  id,
  question: id,
  type: 'text',
  options: [],
  optionValues: [],
  selectors: [{ css: sel }]
})

const baseCfg = (link: string): {
  link: string
  headless: boolean
  waitTimeout: number
  waitAfterLoad: number
  outputDir: string
} => ({
  link,
  headless: true,
  waitTimeout: 5000,
  waitAfterLoad: 200,
  outputDir: resolve(process.cwd(), 'out', 'test-output')
})

/**
 * 多页问卷「接着填」的核心契约：
 * 第二次运行必须复用同一个浏览器窗口/页面，**不重新导航**，
 * 从而停在用户手动翻到的下一页继续填写，而不是回到表单第 1 页。
 */
describe('多页问卷：复用浏览器会话接着填', () => {
  it('第二次运行复用同一窗口/页面且不重新导航（停在用户翻到的下一页）', async () => {
    const link = mk(
      '<form id="p1"><input id="a" type="text">' +
        "<button id=\"next\" type=\"button\" onclick=\"document.getElementById('p1').style.display='none';" +
        "document.getElementById('p2').style.display='block';window.__page=2\">下一页</button>" +
        '</form>' +
        '<form id="p2" style="display:none"><input id="b" type="text"></form>'
    )
    const cfg = baseCfg(link)
    const key = 'e2e-reuse-1'
    const hooks = {
      getSession: () => getLiveSession(key),
      onSessionReady: (s: ReusableSession) => setSession(key, { ...s, link })
    }

    // 第一次：全新打开，填第 1 页
    const r1 = await runFill(
      { config: cfg, questions: [q('q1', '#a')], answers: { q1: '第一页' } },
      hooks
    )
    expect(r1.reused).toBe(false)
    expect(r1.report.reusedSession).toBeUndefined()
    expect(r1.report.summary.filled).toBe(1)

    // 模拟用户在浏览器里点「下一页」翻到第 2 页
    await r1.page.click('#next')
    expect(await r1.page.evaluate(() => (window as { __page?: number }).__page)).toBe(2)

    // 第二次：复用会话 + 第 2 页题目（相当于重新解析出的新页面题目）
    const r2 = await runFill(
      { config: cfg, questions: [q('q2', '#b')], answers: { q2: '第二页' } },
      hooks
    )
    expect(r2.reused).toBe(true)
    expect(r2.report.reusedSession).toBe(true)
    expect(r2.report.summary.filled).toBe(1)
    expect(r2.report.summary.missing).toBe(0)
    // 同一个 Page 对象
    expect(r2.page).toBe(r1.page)
    // 关键断言：没有重新导航 → 仍停在第 2 页（若重开会回到第 1 页，__page 变回 undefined）
    expect(await r2.page.evaluate(() => (window as { __page?: number }).__page)).toBe(2)
    expect(await r2.page.locator('#b').inputValue()).toBe('第二页')

    await closeSession(key)
  }, 120000)

  it('会话已失效（浏览器被关掉）时回退为重新打开，而不是复用死会话', async () => {
    const link = mk('<input id="a" type="text">')
    const cfg = baseCfg(link)
    const key = 'e2e-reuse-2'
    const hooks = {
      getSession: () => getLiveSession(key),
      onSessionReady: (s: ReusableSession) => setSession(key, { ...s, link })
    }

    const r1 = await runFill(
      { config: cfg, questions: [q('q1', '#a')], answers: { q1: 'x' } },
      hooks
    )
    expect(r1.reused).toBe(false)

    // 用户关掉浏览器 → 注册表判定失活
    await Promise.race([r1.browser.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
    expect(getLiveSession(key)).toBeNull()

    // 再跑：应重新打开（reused=false），而不是复用死会话
    const r2 = await runFill(
      { config: cfg, questions: [q('q1', '#a')], answers: { q1: 'y' } },
      hooks
    )
    expect(r2.reused).toBe(false)
    expect(r2.report.reusedSession).toBeUndefined()
    expect(r2.report.summary.filled).toBe(1)

    await closeSession(key)
  }, 120000)
})
