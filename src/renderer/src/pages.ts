/**
 * 多页问卷的「页」判定（纯函数，好单测）。
 *
 * 解决的问题：多页问卷每翻一页都要重新抓 HTML。如果没有「页」的概念，抓一次就把上一页的
 * 题目/答案覆盖掉，AI 额度白花；用户也没法「一页一页填、填完还能回到上一页」。
 *
 * 判定两个指纹：
 * - **精确指纹 fp**（freshness.fingerprint）：整份 HTML 一字不差 → 就是这份内容本身。
 * - **结构签名 sig**：只看标签结构与可见文字，**忽略全部属性、并把 4 位以上的数字压成占位**。
 *   页面重新渲染后 `name="809-q-38-8883"`、时间戳这类东西会变（fp 一定变），但结构签名不变
 *   —— 所以能用它认出「还是同一页」，从而沿用已有题目，不必重新生成。
 *
 * 三种落法（见 routeGrab）：更新现有页 / 同一页换 HTML / 存为新页。
 */
import { contentFingerprint } from '../../shared/contracts/hash'
import { structureText } from '../../shared/contracts/page'
import type { Question, TaskPage } from './types'

/**
 * 结构签名：剥掉 script/style/注释、**丢掉标签的全部属性**、压掉空白与长数字，再做指纹。
 *
 * 压缩规则在 `shared/contracts/page.ts#structureText`（唯一实现，主进程的蓝图阶段也要用同一套），
 * 这里只负责套上内容指纹。⚠️ 规则一改，所有老任务存的 `sig` 就全失效 —— 不能随手动。
 */
export function pageSignature(html: string): string {
  return contentFingerprint(structureText(html))
}

/** 从页面 HTML 里取一个像样的页名：<title> → 第一个标题 → '' */
export function pageTitle(html: string): string {
  const clean = (s: string): string =>
    s
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&[a-zA-Z#0-9]{1,8};/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40)

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (title) {
    const t = clean(title[1])
    if (t) return t
  }
  const head = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html)
  if (head) {
    const t = clean(head[1])
    if (t) return t
  }
  return ''
}

/** 抓取结果的落法 */
export type GrabRoute =
  /** 一字不差的同一份内容：只把 HTML 更新回这一页（题目/答案与指纹都不动） */
  | { kind: 'refresh'; pageId: string }
  /**
   * 结构上是同一页，只是重新渲染过（时间戳/随机前缀变了）：
   * 更新该页 HTML 与指纹，**题目与答案照旧** —— 这就是「以后不用再让 AI 重新生成」的关键。
   */
  | { kind: 'same-page'; pageId: string }
  /** 空白占位页（刚建的任务/清空过的页）：第一次抓取直接填进它，不留一个空页 */
  | { kind: 'fill'; pageId: string }
  /** 没见过的一页：存成新页 */
  | { kind: 'new-page' }

/** 抓取结果 + 判定依据（调用方要拿着 fp/sig 落盘，避免算两遍） */
export interface GrabPlan {
  route: GrabRoute
  fp: string
  sig: string
}

/** 一页是不是「还没内容的占位页」（新建任务 / 清空过的页） */
function isPlaceholder(p: TaskPage): boolean {
  return (
    !p.fp &&
    !p.sig &&
    (p.questions?.length ?? 0) === 0 &&
    Object.values(p.answers ?? {}).every((v) => !v || !v.trim())
  )
}

/**
 * 判断这次抓到的 HTML 该落到哪一页。
 *
 * 顺序有讲究：**先精确、再结构、最后才建新页**。宁可复用一页，也不轻易多出一页
 * —— 多出来的页会让「一页一页填」变成一团乱麻。
 */
export function routeGrab(input: {
  html: string
  pages: TaskPage[]
  activePageId?: string
}): GrabPlan {
  const fp = contentFingerprint(input.html)
  const sig = pageSignature(input.html)
  const pages = input.pages ?? []

  const exact = pages.find((p) => p.fp && p.fp === fp)
  if (exact) return { route: { kind: 'refresh', pageId: exact.id }, fp, sig }

  const same = pages.find((p) => p.sig && p.sig === sig)
  if (same) return { route: { kind: 'same-page', pageId: same.id }, fp, sig }

  // 优先填「当前页」这个占位页，其次任意占位页
  const placeholder =
    pages.find((p) => p.id === input.activePageId && isPlaceholder(p)) ??
    pages.find((p) => isPlaceholder(p))
  if (placeholder) return { route: { kind: 'fill', pageId: placeholder.id }, fp, sig }

  return { route: { kind: 'new-page' }, fp, sig }
}

/** 题干/选项归一键：只比文字，不管空格与全半角空白的差异 */
function questionKey(q: Question): string {
  return [
    q.question.replace(/\s+/g, ''),
    q.type,
    q.options.map((o) => o.replace(/\s+/g, '')).join('\u0001')
  ].join('\u0002')
}

/**
 * 新页生成题目后，把**上一页里题干与选项完全相同**的题的答案带过来。
 *
 * 多页问卷常有重复题（每页都问一次满意度），带上答案能省一次 AI 生成；
 * 只认「完全一样」的题，不确定的一律不带 —— 宁可空着让人填，也不能张冠李戴。
 */
export function carryAnswers(
  prev: { questions: Question[]; answers: Record<string, string> } | null,
  next: Question[]
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!prev || prev.questions.length === 0) return out
  const byKey = new Map<string, string>()
  for (const q of prev.questions) {
    const a = (prev.answers[q.id] ?? '').trim()
    if (a) byKey.set(questionKey(q), a)
  }
  for (const q of next) {
    const a = byKey.get(questionKey(q))
    if (a) out[q.id] = a
  }
  return out
}

/** 页面条上显示的一行摘要：`3 题 · 3 答` */
export function pageStat(p: TaskPage): string {
  const n = p.questions?.length ?? 0
  const a = Object.values(p.answers ?? {}).filter((v) => v && v.trim()).length
  return n === 0 ? '未生成题目' : `${n} 题 · ${a} 答`
}
