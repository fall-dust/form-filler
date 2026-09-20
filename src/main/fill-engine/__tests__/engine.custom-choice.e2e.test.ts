import { describe, it, expect } from 'vitest'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { runFill, type ReusableSession } from '../engine'
import { getLiveSession, setSession, closeSession } from '../session'
import type { ParsedQuestion } from '../types'

const cwd = process.cwd()

/**
 * 与问卷网真实抓取结果同形：第 1 条 css 命中 4 个（不可见的）原生 input，
 * 第 2 条只命中组容器，第 3 条是文本回退。
 */
const questions: ParsedQuestion[] = [
  {
    id: 'q1',
    question: '您通常需要多长时间才能入睡（从上床准备睡觉到睡着的时长）？',
    type: 'radio',
    options: ['≤15分钟', '16-30分钟', '31-60分钟', '＞60分钟'],
    optionValues: [
      '6aae2dbbe123a0d46aa18de0',
      '6aae2dbbe123a0d46aa18de1',
      '6aae2dbbe123a0d46aa18de2',
      '6aae2dbbe123a0d46aa18de3'
    ],
    selectors: [
      { css: '#question-6aae2dbbe123a0d46aa18de4 input[type=radio]' },
      { css: '#question-6aae2dbbe123a0d46aa18de4 .ws-radio-group' },
      { text: '您通常需要多长时间才能入睡（从上床准备睡觉到睡着的时长）？' }
    ]
  },
  {
    id: 'q2',
    question: '夜间醒来后，你会做哪些事？',
    type: 'checkbox',
    options: ['看手机', '喝水', '上厕所'],
    optionValues: ['c0', 'c1', 'c2'],
    selectors: [
      { css: '#question-6aae2dbee123a0d46aa18df2 input[type=checkbox]' },
      { css: '#question-6aae2dbee123a0d46aa18df2 .ws-checkbox-group' }
    ]
  }
]

const answers: Record<string, string | string[]> = {
  q1: '16-30分钟',
  q2: ['看手机', '上厕所']
}

/**
 * 自定义控件（问卷网 `ws-radio` / `ws-checkbox`）回归。
 *
 * 这类结构有两个坑，一起踩就会表现成「浏览器里明明填上了，却卡在这一题不走」：
 *   1. 原生 input 是零尺寸 + aria-hidden，选中逻辑挂在外层可见容器上；
 *      只对隐藏 input 派发 click，不触发组件状态更新。
 *   2. 选项文字在**兄弟节点** `.ws-radio__label > .option-title` 里，原生 input 与
 *      它的直接父级都没有文字 —— 回读取不到文字就判「填写后校验不一致」，
 *      而且取不到的过程会各自白等 Playwright 默认的 30s，直接撞穿单题预算。
 */
describe('自定义控件：选项文字在兄弟节点 + 原生 input 不可见', () => {
  it('能填对、回读通过，且重复填写不重复点击、不撞单题预算', async () => {
    const link = pathToFileURL(resolve(cwd, 'samples', 'wenjuan_custom_choice.html')).href
    const cfg = {
      link,
      headless: true,
      waitTimeout: 5000,
      waitAfterLoad: 200,
      outputDir: resolve(cwd, 'out', 'test-output')
    }
    const key = 'e2e-wenjuan-custom-1'
    const hooks = {
      getSession: () => getLiveSession(key),
      onSessionReady: (s: ReusableSession) => setSession(key, { ...s, link })
    }

    // 第一次：全量填写
    const t1 = Date.now()
    const r1 = await runFill({ config: cfg, questions, answers }, hooks)
    const cost1 = Date.now() - t1

    expect(r1.report.summary.failed).toBe(0)
    expect(r1.report.summary.missing).toBe(0)
    expect(r1.report.summary.filled).toBe(2)
    // 回读必须通过：坏掉时这里会是 verified: false（「填写后校验不一致」）
    for (const f of r1.report.fields) expect(f.verified).not.toBe(false)

    const dom = await r1.page.evaluate(() => {
      const picked = (sel: string): string[] =>
        Array.from(document.querySelectorAll(sel))
          .filter((el) => el.classList.contains('is-checked'))
          .map((el) => el.querySelector('.option-title')?.textContent?.trim() ?? '')
          .filter((t) => t.length > 0)
      return {
        radio: picked('.ws-radio'),
        checkbox: picked('.ws-checkbox'),
        clicks: (window as unknown as { __clicks?: number }).__clicks ?? 0
      }
    })
    expect(dom.radio).toEqual(['16-30分钟'])
    expect(dom.checkbox).toEqual(['看手机', '上厕所'])

    // 第二次：复用会话。页面已是目标状态 → 命中「已完成」判定直接采信，不再点击
    const t2 = Date.now()
    const r2 = await runFill({ config: cfg, questions, answers }, hooks)
    const cost2 = Date.now() - t2

    expect(r2.reused).toBe(true)
    expect(r2.report.summary.filled).toBe(2)
    for (const f of r2.report.fields) expect(f.verified).not.toBe(false)

    const after = await r2.page.evaluate(
      () => (window as unknown as { __clicks?: number }).__clicks ?? 0
    )
    expect(after).toBe(dom.clicks)

    // 性能守护：回读若又漏了显式超时，Playwright 的默认 30s 会在这里直接暴露。
    // 实测复用会话跑完这两题只要几十毫秒（首次那次的耗时基本都是浏览器冷启动）。
    expect(cost1).toBeLessThan(25_000)
    expect(cost2).toBeLessThan(3_000)

    await closeSession(key)
  }, 120000)
})
