import { describe, expect, it } from 'vitest'
import { ensureSession, getLiveSession, closeSession } from '../session'
import { detectNextButtons, clickNextButton } from '../next-button'

const dataUrl = (body: string, script = ''): string =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<!DOCTYPE html><html lang="zh-CN"><head><title>多页问卷</title></head><body>${body}${
      script ? `<script>${script}</script>` : ''
    }</body></html>`
  )

/** 一页问卷：有翻页按钮，也有绝不能被误点的「提交/上一步」 */
const FORM_PAGE = `
  <form>
    <p>第 1 部分</p>
    <input name="809-q-1-1">
    <button id="prev" type="button">上一步</button>
    <button id="hidden" type="button" style="display:none">下一页</button>
    <button id="next" type="button">下一页</button>
    <button id="submit" type="button">提交</button>
    <button id="done" type="button">完成</button>
  </form>
`
const FLIP_SCRIPT = `
  document.getElementById('next').addEventListener('click', function () {
    document.body.innerHTML = '<form><p>第 2 部分</p><input name="809-q-9-1"><button id="n2" type="button">下一步</button></form>'
  })
`

/**
 * 「下一页」按钮的识别与点击。
 *
 * 识别是只读的（不改页面、不点任何东西），点击**只在用户明确点界面 chip 时**发生。
 * 最要紧的安全边界：绝不能把「提交 / 完成 / 上一步」当成翻页按钮 —— 这里把它钉死。
 */
describe('识别「下一页」按钮', () => {
  it('只认出真正的翻页按钮：提交/完成/上一步/隐藏的一律不算', async () => {
    const key = 'next-detect'
    try {
      await ensureSession(key, dataUrl(FORM_PAGE), { headless: true }, 200)
      const page = getLiveSession(key)!.page
      const list = await detectNextButtons(page)

      const texts = list.map((b) => b.text)
      expect(texts).toContain('下一页')
      expect(texts).not.toContain('提交')
      expect(texts).not.toContain('完成')
      expect(texts).not.toContain('上一步')
      // 隐藏的那个虽然文字也是「下一页」，但宽高为 0，必须排除
      expect(list.filter((b) => b.text === '下一页')).toHaveLength(1)
      expect(list[0].disabled).toBe(false)
      expect(list[0].frameUrl).toBe('') // 主 frame
    } finally {
      await closeSession(key)
    }
  }, 120000)

  it('禁用的按钮照实报告「不可用」，而不是假装能点', async () => {
    const key = 'next-disabled'
    try {
      await ensureSession(
        key,
        dataUrl('<form><button id="n" type="button" disabled>下一步</button></form>'),
        { headless: true },
        200
      )
      const page = getLiveSession(key)!.page
      const list = await detectNextButtons(page)
      expect(list).toHaveLength(1)
      expect(list[0].text).toBe('下一步')
      expect(list[0].disabled).toBe(true)
    } finally {
      await closeSession(key)
    }
  }, 120000)

  it('主 frame 没有时去子 frame 找（内嵌问卷的按钮常在 iframe 里）', async () => {
    const key = 'next-iframe'
    try {
      await ensureSession(
        key,
        dataUrl(
          `<iframe id="f" style="width:600px;height:300px"></iframe>`,
          `document.getElementById('f').srcdoc = '<form><button type="button">继续填写</button></form>'`
        ),
        { headless: true },
        500
      )
      const page = getLiveSession(key)!.page
      const list = await detectNextButtons(page)
      expect(list.map((b) => b.text)).toContain('继续填写')
      expect(list[0].frameUrl).not.toBe('') // 记下了 frame，点击时要用同一个 frame
    } finally {
      await closeSession(key)
    }
  }, 120000)
})

describe('点击「下一页」', () => {
  it('点下去真的翻页了，并返回实际生效的策略', async () => {
    const key = 'next-click'
    try {
      await ensureSession(key, dataUrl(FORM_PAGE, FLIP_SCRIPT), { headless: true }, 200)
      const page = getLiveSession(key)!.page
      const [btn] = await detectNextButtons(page)

      const r = await clickNextButton(page, { selector: btn.selector, text: btn.text })
      expect(r.ok).toBe(true)
      expect(r.strategy).toBeTruthy()
      // 页面确实翻到了第 2 部分
      expect(await page.locator('text=第 2 部分').count()).toBe(1)
      // 翻页后重新识别：新页的按钮是「下一步」
      const after = await detectNextButtons(page)
      expect(after.map((b) => b.text)).toContain('下一步')
    } finally {
      await closeSession(key)
    }
  }, 120000)

  it('临时标记被前端重渲染冲掉时，靠文本兜底也能点到', async () => {
    const key = 'next-click-fallback'
    try {
      await ensureSession(key, dataUrl(FORM_PAGE, FLIP_SCRIPT), { headless: true }, 200)
      const page = getLiveSession(key)!.page
      const [btn] = await detectNextButtons(page)

      // 模拟框架重渲染：把识别时打的标记全部抹掉，只留文字
      await page.evaluate(() => {
        document.querySelectorAll('[data-formfiller-next]').forEach((el) => {
          el.removeAttribute('data-formfiller-next')
        })
      })

      const r = await clickNextButton(page, { selector: btn.selector, text: '下一页' })
      expect(r.ok).toBe(true)
      expect(await page.locator('text=第 2 部分').count()).toBe(1)
    } finally {
      await closeSession(key)
    }
  }, 120000)
})
