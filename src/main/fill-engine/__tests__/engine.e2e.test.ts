import { describe, it, expect } from 'vitest'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { chromium } from 'playwright-core'
import { runFill } from '../engine'
import { trySubmit } from '../submit'
import type { ParsedQuestion } from '../types'

const cwd = process.cwd()

// 与 samples/form_sample.html 对应的九类题型（显式给出选择器，模拟 AI 导入的完整配置）
const questions: ParsedQuestion[] = [
  {
    id: 'q1',
    question: '你的姓名？',
    type: 'text',
    options: [],
    optionValues: [],
    selectors: [{ css: '#name' }]
  },
  {
    id: 'q2',
    question: '你的建议？',
    type: 'textarea',
    options: [],
    optionValues: [],
    selectors: [{ css: '#suggestion' }]
  },
  {
    id: 'q3',
    question: '性别？',
    type: 'radio',
    options: ['男', '女', '保密'],
    optionValues: ['男', '女', '保密'],
    selectors: [{ css: 'input[type="radio"][name="gender"]' }]
  },
  {
    id: 'q4',
    question: '是否同意本协议？',
    type: 'judge',
    options: ['是', '否'],
    optionValues: ['是', '否'],
    selectors: [{ css: 'input[type="radio"][name="agree"]' }]
  },
  {
    id: 'q5',
    question: '你感兴趣的功能？',
    type: 'checkbox',
    options: ['自动填表', '智能解析', '断点续填'],
    optionValues: ['自动填表', '智能解析', '断点续填'],
    selectors: [{ css: 'input[type="checkbox"][name="features"]' }]
  },
  {
    id: 'q6',
    question: '满意度？',
    type: 'select',
    options: ['非常满意', '满意', '一般'],
    optionValues: ['5', '4', '3'],
    selectors: [{ css: '#satisfaction' }]
  },
  {
    id: 'q7',
    question: '出生日期？',
    type: 'date',
    options: [],
    optionValues: [],
    selectors: [{ css: '#birthday' }]
  },
  {
    id: 'q8',
    question: '上传头像？',
    type: 'file',
    options: [],
    optionValues: [],
    selectors: [{ css: '#avatar' }]
  },
  {
    id: 'q9',
    question: '请对以下各项满意度打分',
    type: 'matrix',
    options: ['非常满意', '满意', '一般'],
    optionValues: ['非常满意', '满意', '一般'],
    matrixRows: ['服务态度', '产品质量'],
    selectors: [{ css: 'table.matrix' }]
  },
  {
    id: 'q10',
    question: '预算满意度（0-100）？',
    type: 'slider',
    options: [],
    optionValues: [],
    selectors: [{ css: '#budget' }]
  },
  {
    id: 'q11',
    question: '服务体验星级？',
    type: 'rate',
    options: [],
    optionValues: [],
    selectors: [{ css: '#rateExp' }]
  },
  {
    id: 'q12',
    question: '是否开启消息通知？',
    type: 'switch',
    options: [],
    optionValues: [],
    selectors: [{ css: '#notifySwitch' }]
  },
  {
    id: 'q13',
    question: '所在城市？',
    type: 'richselect',
    options: ['北京', '上海', '广州', '深圳'],
    optionValues: ['北京', '上海', '广州', '深圳'],
    selectors: [{ css: '#citySelect' }]
  },
  {
    id: 'q14',
    question: '个人简介？',
    type: 'richtext',
    options: [],
    optionValues: [],
    selectors: [{ css: '#bio' }]
  },
  {
    id: 'q15',
    question: '来访日期？',
    type: 'date',
    options: [],
    optionValues: [],
    selectors: [{ css: '#visitDate' }]
  },
  {
    id: 'q16',
    question: '公司名称？',
    type: 'text',
    options: [],
    optionValues: [],
    selectors: [{ css: '#child-name' }, { text: '公司名称？' }]
  },
  {
    id: 'q17',
    question: '所属部门？',
    type: 'text',
    options: [],
    optionValues: [],
    selectors: [{ css: '#child-dept' }]
  }
]

const answers: Record<string, string | string[]> = {
  q1: '张三',
  q2: '很棒，继续加油',
  q3: '男',
  q4: '是',
  q5: ['自动填表', '断点续填'],
  q6: '满意',
  q7: '2000-01-01',
  q8: resolve(cwd, 'README.md'),
  q9: '满意',
  q10: '75',
  q11: '4',
  q12: 'true',
  q13: '上海',
  q14: '热爱自动化测试的工程师',
  q15: '2026-09-15',
  q16: '示例科技有限公司',
  q17: '质量保障部'
}

describe('fill-engine 端到端（headless chromium）', () => {
  it('全部题型（含新题型与 iframe）filled 且 DOM 回读正确', async () => {
    const url = pathToFileURL(resolve(cwd, 'samples', 'form_sample.html')).href
    const { report, browser, page } = await runFill({
      config: {
        link: url,
        headless: true,
        waitTimeout: 5000,
        waitAfterLoad: 300,
        outputDir: resolve(cwd, 'out', 'test-output')
      },
      questions,
      answers
    })

    expect(report.summary.failed).toBe(0)
    expect(report.summary.missing).toBe(0)
    expect(report.summary.filled).toBe(questions.length)

    const state = await page.evaluate(() => {
      const val = (sel: string): string | null =>
        (document.querySelector(sel) as HTMLInputElement | HTMLSelectElement | null)?.value ?? null
      const checked = (sel: string): boolean =>
        (document.querySelector(sel) as HTMLInputElement | null)?.checked ?? false
      return {
        name: val('input[name="name"]'),
        suggestion: val('textarea[name="suggestion"]'),
        gender: checked('input[name="gender"][value="男"]'),
        agree: checked('input[name="agree"][value="是"]'),
        feat1: checked('input[name="features"][value="自动填表"]'),
        feat2: checked('input[name="features"][value="断点续填"]'),
        satisfaction: val('select[name="satisfaction"]'),
        birthday: val('input[name="birthday"]'),
        m1: checked('input[name="m1"][value="满意"]'),
        m2: checked('input[name="m2"][value="满意"]'),
        budget: val('#budget'),
        budgetEcho: document.getElementById('budgetVal')?.textContent ?? '',
        rateNow: document.getElementById('rateExp')?.getAttribute('aria-valuenow') ?? '',
        star4: document.querySelectorAll('#rateExp .el-rate__item')[3]?.classList.contains('active') ?? false,
        notify: document.getElementById('notifySwitch')?.getAttribute('aria-checked') ?? '',
        city: document.querySelector('#citySelect .placeholder')?.textContent ?? '',
        bio: document.getElementById('bio')?.textContent ?? '',
        visit: val('#visitDate')
      }
    })

    expect(state.name).toBe('张三')
    expect(state.suggestion).toBe('很棒，继续加油')
    expect(state.gender).toBe(true)
    expect(state.agree).toBe(true)
    expect(state.feat1).toBe(true)
    expect(state.feat2).toBe(true)
    expect(state.satisfaction).toBe('4') // 「满意」对应 value 4
    expect(state.birthday).toBe('2000-01-01')
    expect(state.m1).toBe(true)
    expect(state.m2).toBe(true)
    expect(state.budget).toBe('75')
    expect(state.budgetEcho).toBe('75') // input 事件已派发，回显同步
    expect(state.rateNow).toBe('4')
    expect(state.star4).toBe(true)
    expect(state.notify).toBe('true')
    expect(state.city).toBe('上海')
    expect(state.bio).toContain('热爱自动化测试')
    expect(state.visit).toBe('2026-09-15')

    // iframe 子表单：在子 frame 内回读
    const child = page.frames().find((f) => f !== page.mainFrame())
    expect(child).toBeDefined()
    const childState = {
      company: await child!.locator('#child-name').inputValue(),
      dept: await child!.locator('#child-dept').inputValue()
    }
    expect(childState.company).toBe('示例科技有限公司')
    expect(childState.dept).toBe('质量保障部')

    // 收尾保护：本机环境下 chromium 偶发退出挂起，不阻塞测试结论
    await Promise.race([
      browser.close(),
      new Promise((r) => setTimeout(r, 5000))
    ]).catch(() => {})
  }, 120000)

  it('autoSubmit：全部填写成功后按文本找到提交按钮并点击；未开启时不提交', async () => {
    const url = pathToFileURL(resolve(cwd, 'samples', 'form_sample.html')).href
    const base = {
      config: {
        link: url,
        headless: true,
        waitTimeout: 5000,
        waitAfterLoad: 300,
        outputDir: resolve(cwd, 'out', 'test-output')
      },
      questions,
      answers
    }

    // 默认（不开启）：报告中无 submitted
    const r1 = await runFill(base)
    expect(r1.report.submitted).toBeUndefined()

    // 开启：命中「提交问卷」按钮并点击（样例里混入了主按钮样式的「保存草稿/下一步」
    // 和 disabled 的「提交」作为干扰项，打分制必须全部避开）
    const r2 = await runFill({ ...base, config: { ...base.config, autoSubmit: true } })
    expect(r2.report.summary.failed).toBe(0)
    expect(r2.report.submitted).toBe(true)
    const clicked = await r2.page.evaluate(() => (window as { __submitted?: boolean }).__submitted)
    expect(clicked).toBe(true)
    // 确认没有误点任何干扰按钮
    const wrong = await r2.page.evaluate(() => (window as { __wrongClick?: string }).__wrongClick)
    expect(wrong).toBeUndefined()

    // 有未完成项：跳过自动提交并给出原因
    const r3 = await runFill({ ...base, config: { ...base.config, autoSubmit: true }, answers: {} })
    expect(r3.report.submitted).toBeUndefined()
    expect(r3.report.submitError).toContain('跳过自动提交')

    await Promise.race([
      Promise.all([r1.browser.close(), r2.browser.close()]),
      new Promise((r) => setTimeout(r, 5000))
    ]).catch(() => {})
  }, 120000)

  it('autoSubmit：提交结果落 submitConfirmed 字段；无响应时另产出 submitNote 并写明点击目标', async () => {
    const mk = (body: string): string =>
      'data:text/html;charset=utf-8,' +
      encodeURIComponent(`<!DOCTYPE html><html lang="zh-CN"><body>${body}</body></html>`)
    const single: ParsedQuestion[] = [
      {
        id: 'q1',
        question: '姓名？',
        type: 'text',
        options: [],
        optionValues: [],
        selectors: [{ css: '#a' }]
      }
    ]
    const cfg = (link: string) => ({
      link,
      headless: true,
      waitTimeout: 5000,
      waitAfterLoad: 300,
      autoSubmit: true,
      outputDir: resolve(cwd, 'out', 'test-output')
    })
    const req = (link: string) => ({
      config: cfg(link),
      questions: single,
      answers: { q1: '张三' }
    })

    // ① 静默页：按钮点了不发 submit 事件、不发请求、不跳转 → 无法确认，提示人工核对
    const r1 = await runFill(
      req(mk('<form><input id="a" type="text"><button type="button">提交问卷</button></form>'))
    )
    expect(r1.report.submitted).toBe(true)
    expect(r1.report.submitConfirmed).toBe(false) // 点了但无任何响应 → 结果未确认
    expect(r1.report.submitNote).toContain('未检测到页面响应')
    expect(r1.report.submitNote).toContain('提交问卷') // 提示里说清点了哪个按钮
    expect(r1.report.submitError).toBeUndefined()

    // ② 正常页：原生 submit 按钮触发 form 的 submit 事件 → 已观测到响应，不给提示
    const r2 = await runFill(
      req(
        mk(
          '<form onsubmit="event.preventDefault()"><input id="a" type="text"><button type="submit">提交</button></form>'
        )
      )
    )
    expect(r2.report.submitted).toBe(true)
    expect(r2.report.submitConfirmed).toBe(true) // 捕获到 submit 事件 → 已确认
    expect(r2.report.submitNote).toBeUndefined()

    await Promise.race([
      Promise.all([r1.browser.close(), r2.browser.close()]),
      new Promise((r) => setTimeout(r, 5000))
    ]).catch(() => {})
  }, 120000)

  it('submit：iframe 内的提交按钮也能命中（全 frame 扫描）', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await (await browser.newContext()).newPage()
    await page.goto(pathToFileURL(resolve(cwd, 'samples', 'submit_iframe.html')).href)

    const r = await trySubmit(page)
    expect(r.submitted).toBe(true)
    const clicked = await page.evaluate(() => (window as { __iframeSubmitted?: boolean }).__iframeSubmitted)
    expect(clicked).toBe(true)

    await Promise.race([browser.close(), new Promise((res) => setTimeout(res, 5000))]).catch(() => {})
  }, 60000)
})
