import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SideNote } from '../components/SideNote'

// 在 node 环境下渲染（没有 window/localStorage）：既验证「默认收起」的渲染结果，
// 也验证取不到 localStorage 时组件不会崩。
const html = (): string =>
  renderToStaticMarkup(
    createElement(SideNote, {
      title: '说明：会话 · 多页填写 · 登录态',
      children: createElement('p', null, '这一段不应该默认出现在界面上')
    })
  )

describe('左栏说明折叠块的渲染', () => {
  it('默认收起：标题在，正文不在', () => {
    const out = html()
    expect(out).toContain('说明：会话 · 多页填写 · 登录态')
    expect(out).not.toContain('这一段不应该默认出现在界面上')
  })

  it('可访问性：按钮带 aria-expanded=false，便于读屏与样式联动', () => {
    expect(html()).toContain('aria-expanded="false"')
  })

  it('没有 localStorage 的环境（node/隐私模式）不报错', () => {
    expect(() => html()).not.toThrow()
  })
})
