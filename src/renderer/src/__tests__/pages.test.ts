import { describe, expect, it } from 'vitest'
import { fingerprint } from '../freshness'
import { carryAnswers, pageSignature, pageTitle, routeGrab } from '../pages'
import type { Question, TaskPage } from '../types'

function q(id: string, question = '题干', options = ['A', 'B']): Question {
  return {
    id,
    question,
    type: 'radio',
    options,
    optionValues: options,
    selectors: [{ css: `input[name="${id}"]` }]
  }
}

function page(over: Partial<TaskPage> & { id: string }): TaskPage {
  return { name: over.id, questions: [], answers: {}, ...over }
}

/** 腾讯问卷那种「每次渲染都换一截随机前缀」的字段名 */
const tencentPage = (rand: string): string =>
  `<form><div class="q"><input name="${rand}-q-38-8883"></div><button>下一页</button></form>`

describe('结构签名', () => {
  it('同一页重新渲染（属性/长数字变了）签名不变', () => {
    expect(pageSignature(tencentPage('809'))).toBe(pageSignature(tencentPage('1207')))
    expect(pageSignature('<form class="a"><input name="q1"></form>')).toBe(
      pageSignature('<form class="b" data-v-9f2c><input name="q9"></form>')
    )
  })

  it('可见文字变了签名就变（题干/选项改动必须能认出来）', () => {
    const a = '<form><p>请选择你的满意度</p><input name="q1"></form>'
    const b = '<form><p>请选择你的年龄段</p><input name="q1"></form>'
    expect(pageSignature(a)).not.toBe(pageSignature(b))
  })

  it('script / style 不参与签名（它们跟题目无关，且各版本差异大）', () => {
    const a = '<form><input name="q1"></form><script>var t=1</script>'
    const b = '<form><input name="q1"></form><script>var t=9999</script>'
    expect(pageSignature(a)).toBe(pageSignature(b))
  })

  it('长数字（时间戳/序号）被忽略，短数字保留（题号必须算数）', () => {
    expect(pageSignature('<p>提交时间 1726730000000</p>')).toBe(
      pageSignature('<p>提交时间 1726739999999</p>')
    )
    expect(pageSignature('<p>第 1 题</p>')).not.toBe(pageSignature('<p>第 2 题</p>'))
  })
})

describe('抓取落页判定', () => {
  const html1 = '<form><p>第一页</p><input name="809-q-1-1"></form>'

  it('一字不差 → refresh（只更新这一页的 HTML，题目照旧）', () => {
    const pages = [page({ id: 'p1', fp: fingerprint(html1), sig: pageSignature(html1) })]
    expect(routeGrab({ html: html1, pages }).route).toEqual({ kind: 'refresh', pageId: 'p1' })
  })

  it('结构相同（重新渲染过）→ same-page：别让题目白重做', () => {
    const pages = [page({ id: 'p1', fp: 'fp-old', sig: pageSignature(tencentPage('809')) })]
    const plan = routeGrab({ html: tencentPage('1207'), pages })
    expect(plan.route).toEqual({ kind: 'same-page', pageId: 'p1' })
    expect(plan.fp).not.toBe('fp-old') // 精确指纹确实变了，靠签名救回来
  })

  it('空占位页 → fill（第一次抓取填进第 1 页，不凭空多一页）', () => {
    // 只有一页且它是空的 → 填进去
    expect(routeGrab({ html: html1, pages: [page({ id: 'p1' })] }).route).toEqual({
      kind: 'fill',
      pageId: 'p1'
    })
    // 两页都是空占位页 → 用第一页，也没必要多出一页
    expect(routeGrab({ html: html1, pages: [page({ id: 'p1' }), page({ id: 'p2' })] }).route).toEqual(
      { kind: 'fill', pageId: 'p1' }
    )
    // 其中一页是空的：优先「当前页」那一个
    const withEmpty = [page({ id: 'p1', questions: [q('q1')] }), page({ id: 'p2' })]
    expect(routeGrab({ html: html1, pages: withEmpty, activePageId: 'p2' }).route).toEqual({
      kind: 'fill',
      pageId: 'p2'
    })
  })

  it('见过的页优先命中已有页，没见过的才建新页', () => {
    const p1html = '<form><p>第一页</p></form>'
    const p2html = '<form><p>第二页</p></form>'
    const pages = [
      page({ id: 'p1', fp: '__x__', sig: pageSignature(p1html), questions: [q('q1')] }),
      page({ id: 'p2', fp: '__y__', sig: pageSignature(p2html), questions: [q('q9')] })
    ]
    // 翻回第 1 页抓取 → 命中 p1（题目保留），不会新建 p3
    expect(routeGrab({ html: p1html, pages }).route).toEqual({ kind: 'same-page', pageId: 'p1' })
    // 全新的一页 → new-page
    expect(routeGrab({ html: '<form><p>第三页</p></form>', pages }).route).toEqual({
      kind: 'new-page'
    })
  })
})

describe('页名与答案带入', () => {
  it('页名优先取 <title>，其次取第一个标题', () => {
    expect(pageTitle('<html><head><title>满意度调查</title></head><body>x</body></html>')).toBe(
      '满意度调查'
    )
    expect(pageTitle('<body><h1>第 2 部分：用车体验</h1></body>')).toBe('第 2 部分：用车体验')
    expect(pageTitle('<form><input></form>')).toBe('')
  })

  it('题干与选项完全相同的题才带入答案', () => {
    const prev = {
      questions: [q('a', '满意度', ['很满意', '不满意']), q('b', '年龄', ['<18', '>18'])],
      answers: { a: '很满意', b: '>18' }
    }
    const next = [
      { ...q('n1', '满意度', ['很满意', '不满意']) }, // 同题 → 带入
      { ...q('n2', '年龄段', ['<18', '>18']) } // 题干不同 → 不带
    ]
    const carried = carryAnswers(prev, next)
    expect(carried).toEqual({ n1: '很满意' })
  })

  it('上一页对应题没作答 / 没有上一页时，不带任何答案', () => {
    const prev = { questions: [q('a', '满意度')], answers: { a: '   ' } }
    expect(carryAnswers(prev, [q('n1', '满意度')])).toEqual({})
    expect(carryAnswers(null, [q('n1', '满意度')])).toEqual({})
  })
})
