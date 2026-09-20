import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTaskStore, type TaskStore } from '../store'
import type { ParsedQuestion } from '../types'

let root = ''
const clock = (): Date => new Date('2026-09-19T10:00:00.000Z')

function open(dir = root): TaskStore {
  return createTaskStore(dir, { debounceMs: 0, now: clock })
}

function q(id: string, question = '题干'): ParsedQuestion {
  return {
    id,
    question,
    type: 'radio',
    options: ['A', 'B'],
    optionValues: ['A', 'B'],
    selectors: [{ css: `input[name="${id}"]` }]
  }
}

const pageFile = (id: string, pageId: string): string =>
  join(root, 'tasks', id, 'pages', `${pageId}.html`)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ff-pages-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * 多页问卷的页面存档：每页各自留着自己的 HTML / 题目 / 答案。
 * 这是「一页一页填、翻回旧页不必重新让 AI 生成题目」的地基。
 */
describe('页面存档（多页问卷）', () => {
  it('老数据（没有 pages）载入时迁移成单页，顶层内容成为第 1 页', () => {
    const s = open()
    const it = s.create('旧问卷')
    s.patch(it.id, { questions: [q('q1')], answers: { q1: 'A' }, questionsFor: 'fp-x' })

    const reopened = open()
    const cfg = reopened.get(it.id)!
    expect(cfg.pages).toHaveLength(1)
    expect(cfg.pages![0].id).toBe('p1')
    expect(cfg.pages![0].questions).toHaveLength(1)
    expect(cfg.pages![0].answers.q1).toBe('A')
    expect(cfg.pages![0].questionsFor).toBe('fp-x')
    expect(cfg.activePageId).toBe('p1')
    // 顶层仍是当前页的镜像
    expect(cfg.questions).toHaveLength(1)
    expect(cfg.questionsFor).toBe('fp-x')
  })

  it('建页写 HTML 到 pages/<id>.html，并切成当前页；新页起步为空', () => {
    const s = open()
    const it = s.create()
    s.patch(it.id, { questions: [q('q1')], answers: { q1: 'A' } })
    s.setHtml(it.id, '<form>P1</form>')

    const cfg = s.pageCreate(it.id, {
      name: '满意度',
      html: '<form>P2</form>',
      fp: 'fp2',
      sig: 'sig2',
      url: 'https://x/2'
    })!
    expect(cfg.pages).toHaveLength(2)
    expect(cfg.activePageId).toBe('p2')
    expect(cfg.pages![1].name).toBe('满意度')
    // 顶层镜像换成了新页 —— 新页还没题目，所以顶层题目也空了
    expect(cfg.questions).toHaveLength(0)
    expect(cfg.answers).toEqual({})
    expect(readFileSync(pageFile(it.id, 'p2'), 'utf8')).toBe('<form>P2</form>')
    // 第 1 页的内容原样保留
    expect(cfg.pages![0].questions).toHaveLength(1)
    expect(s.pageHtml(it.id, 'p1')).toBe('<form>P1</form>')
  })

  it('建页不传名字时按「第 N 页」自动命名', () => {
    const s = open()
    const it = s.create()
    const cfg = s.pageCreate(it.id, { html: '<form>P2</form>' })!
    expect(cfg.pages![1].name).toBe('第 2 页')
    expect(cfg.pages![1].nameAuto).toBe(true)
  })

  it('切页：顶层题目/答案/指纹换成该页的（对钩按该页自己判）', () => {
    const s = open()
    const it = s.create()
    s.patch(it.id, { questions: [q('q1')], answers: { q1: 'A' }, questionsFor: 'fp1' })
    s.pageCreate(it.id, { html: '<form>P2</form>', fp: 'fp2' })
    s.patch(it.id, { questions: [q('q9')], answers: { q9: 'B' }, questionsFor: 'fp2' })

    const back = s.pageSelect(it.id, 'p1')!
    expect(back.questions.map((x) => x.id)).toEqual(['q1'])
    expect(back.answers.q1).toBe('A')
    expect(back.questionsFor).toBe('fp1')
    expect(back.activePageId).toBe('p1')

    const again = s.pageSelect(it.id, 'p2')!
    expect(again.questions.map((x) => x.id)).toEqual(['q9'])
    expect(again.questionsFor).toBe('fp2')
  })

  it('patch 内容只落到当前页，不串到别的页', () => {
    const s = open()
    const it = s.create()
    s.patch(it.id, { questions: [q('q1')], answers: { q1: 'A' } })
    s.pageCreate(it.id, { html: '<form>P2</form>' })
    s.patch(it.id, { questions: [q('q9')], answers: { q9: 'B' } })

    s.pageSelect(it.id, 'p1')
    s.patch(it.id, { answers: { q1: 'C' } })

    const cfg = s.get(it.id)!
    const p1 = cfg.pages!.find((p) => p.id === 'p1')!
    const p2 = cfg.pages!.find((p) => p.id === 'p2')!
    expect(p1.answers.q1).toBe('C')
    expect(p2.answers.q9).toBe('B')
    expect(p2.questions).toHaveLength(1)
  })

  it('指纹可以显式清空（传空串 = 删掉，不留下「假装还有效」的旧值）', () => {
    const s = open()
    const it = s.create()
    s.patch(it.id, { questions: [q('q1')], answers: { q1: 'A' }, questionsFor: 'fp1', answersFor: 'af1' })
    s.patch(it.id, { answersFor: undefined, questionsFor: undefined })

    const cfg = s.get(it.id)!
    expect(cfg.questionsFor).toBeUndefined()
    expect(cfg.answersFor).toBeUndefined()
    // 页里也必须一起清掉，否则切回这一页会「复活」
    expect(cfg.pages![0].questionsFor).toBeUndefined()
  })

  it('删页：落回邻居（优先后一页），HTML 文件一并清掉', () => {
    const s = open()
    const it = s.create()
    s.pageCreate(it.id, { html: '<form>P2</form>' })
    s.pageCreate(it.id, { html: '<form>P3</form>' })
    expect(s.get(it.id)!.pages).toHaveLength(3)

    // 当前在第 3 页，删掉它 → 落回第 2 页
    const after = s.pageDelete(it.id, 'p3')!
    expect(after.pages!.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(after.activePageId).toBe('p2')
    expect(existsSync(pageFile(it.id, 'p3'))).toBe(false)

    // 删掉当前页 p1（第 1 页）→ 落到它后面的 p2
    s.pageSelect(it.id, 'p1')
    const after2 = s.pageDelete(it.id, 'p1')!
    expect(after2.pages!.map((p) => p.id)).toEqual(['p2'])
    expect(after2.activePageId).toBe('p2')
  })

  it('只剩一页时「删除」等价于清空该页（任务永远至少留一页）', () => {
    const s = open()
    const it = s.create()
    s.patch(it.id, { questions: [q('q1')], answers: { q1: 'A' } })
    s.setHtml(it.id, '<form>P1</form>')

    const after = s.pageDelete(it.id, 'p1')!
    expect(after.pages).toHaveLength(1)
    expect(after.pages![0].questions).toHaveLength(0)
    expect(after.questions).toHaveLength(0)
    expect(s.pageHtml(it.id, 'p1')).toBeNull()
  })

  it('页改名 / 补指纹走 pagePatch，空名字视为误操作不动', () => {
    const s = open()
    const it = s.create()
    s.pagePatch(it.id, 'p1', { name: '第一页', fp: 'fp1', sig: 'sig1' })
    const cfg = s.get(it.id)!
    expect(cfg.pages![0].name).toBe('第一页')
    expect(cfg.pages![0].nameAuto).toBe(false)
    expect(cfg.pages![0].sig).toBe('sig1')

    s.pagePatch(it.id, 'p1', { name: '   ' })
    expect(s.get(it.id)!.pages![0].name).toBe('第一页')
  })

  it('任务列表的题目数是全部页之和，不是只有当前页', () => {
    const s = open()
    const it = s.create()
    s.patch(it.id, { questions: [q('q1')], answers: { q1: 'A' } })
    s.pageCreate(it.id, { html: '<form>P2</form>' })
    s.patch(it.id, { questions: [q('q9'), q('q10')], answers: { q9: 'B' } })

    const item = s.list().find((t) => t.id === it.id)!
    expect(item.questionCount).toBe(3)
    expect(item.answerCount).toBe(2)
  })

  it('hasHtml 看的是「任一页有 HTML」（切到没 HTML 的页不影响判定）', () => {
    const s = open()
    const it = s.create()
    s.setHtml(it.id, '<form>P1</form>')
    expect(s.list().find((t) => t.id === it.id)!.hasHtml).toBe(true)
    s.pageCreate(it.id, { name: '空页' })
    expect(s.list().find((t) => t.id === it.id)!.hasHtml).toBe(true)
  })

  it('HTML 读写走当前页：getHtml/setHtml 是「当前页」的别名', () => {
    const s = open()
    const it = s.create()
    s.setHtml(it.id, '<form>P1</form>')
    s.pageCreate(it.id, { html: '<form>P2</form>' })
    expect(s.getHtml(it.id)).toBe('<form>P2</form>')
    s.setHtml(it.id, '<form>P2b</form>')
    expect(s.pageHtml(it.id, 'p2')).toBe('<form>P2b</form>')
    expect(s.pageHtml(it.id, 'p1')).toBe('<form>P1</form>')
  })
})

describe('页面存档与其他机制的配合', () => {
  it('快照带全部页：回滚能把每一页的 HTML 一起还原', () => {
    const s = open()
    const it = s.create()
    s.setHtml(it.id, '<form>P1-v1</form>')
    s.pageCreate(it.id, { html: '<form>P2-v1</form>' })
    s.setHtml(it.id, '<form>P2-v2</form>')

    const meta = s.createSnapshot(it.id, 'manual', { withHtml: true })!
    s.setHtml(it.id, '<form>P2-v3</form>')
    s.pageSelect(it.id, 'p1')
    s.setHtml(it.id, '<form>P1-v2</form>')

    s.rollback(it.id, meta.ts)
    expect(s.pageHtml(it.id, 'p1')).toBe('<form>P1-v1</form>')
    expect(s.pageHtml(it.id, 'p2')).toBe('<form>P2-v2</form>')
  })

  it('reset 清空全部页的内容，回到「刚建好的样子」（清空前连每页 HTML 一起留档）', () => {
    const s = open()
    const it = s.create()
    s.patch(it.id, { questions: [q('q1')], answers: { q1: 'A' } })
    s.setHtml(it.id, '<form>P1</form>')
    s.pageCreate(it.id, { name: '第二页', html: '<form>P2</form>' })
    s.patch(it.id, { questions: [q('q9')], answers: { q9: 'B' } })

    const next = s.reset(it.id)!
    expect(next.pages).toHaveLength(1)
    expect(next.pages![0].name).toBe('第 1 页')
    expect(next.pages![0].questions).toHaveLength(0)
    expect(Object.keys(next.pages![0].answers)).toHaveLength(0)
    expect(s.pageHtml(it.id, 'p1')).toBeNull()
    expect(s.pageHtml(it.id, 'p2')).toBeNull()
    expect(next.questionsFor).toBeUndefined()
    // 清空前那份「连每页 HTML」的存档还在，能整页回滚
    // 注意要按 label 找，不能假定 timestamps[0] 就是它 —— 测试用的时钟是冻结的，
    // 同一秒内的多份快照按文件名排序，谁在前并不确定。
    const snap = s.snapshots(it.id).find((x) => x.label === 'pre-rollback')!
    expect(snap.hasHtml).toBe(true)
    s.rollback(it.id, snap.ts)
    expect(s.pageHtml(it.id, 'p1')).toBe('<form>P1</form>')
    expect(s.pageHtml(it.id, 'p2')).toBe('<form>P2</form>')
  })

  it('复制任务连每一页的 HTML 一起复制；不连 HTML 时把页上的指纹一并清掉', () => {
    const s = open()
    const it = s.create('原件')
    s.patch(it.id, { questions: [q('q1')], answers: { q1: 'A' }, questionsFor: 'fp1' })
    s.setHtml(it.id, '<form>P1</form>')
    s.pageCreate(it.id, { html: '<form>P2</form>', fp: 'fp2', sig: 'sig2' })

    const copy = s.duplicate(it.id, true)!
    const c1 = s.get(copy.id)!
    expect(c1.pages).toHaveLength(2)
    expect(s.pageHtml(copy.id, 'p2')).toBe('<form>P2</form>')

    const noHtml = s.duplicate(it.id, false)!
    const c2 = s.get(noHtml.id)!
    expect(c2.pages).toHaveLength(2)
    // 没有 HTML 的副本里，指纹与 fp/sig 都没有意义 —— 必须清掉，否则一打开就报「题目过期」
    expect(c2.pages!.every((p) => !p.questionsFor && !p.answersFor && !p.fp && !p.sig)).toBe(true)
    expect(c2.questionsFor).toBeUndefined()
  })

  it('导出连 HTML 时带上每一页（含正文），导入后页数、页名、HTML 都对', () => {
    const s = open()
    const it = s.create('两页问卷')
    s.patch(it.id, { questions: [q('q1')], answers: { q1: 'A' }, questionsFor: 'fp1' })
    s.setHtml(it.id, '<form>P1</form>')
    s.pageCreate(it.id, { name: '第二页', html: '<form>P2</form>', fp: 'fp2', sig: 'sig2' })
    s.patch(it.id, { questions: [q('q9')], answers: { q9: 'B' }, questionsFor: 'fp2' })

    const file = s.exportTasks([it.id], true)
    expect(file.tasks[0].pages).toHaveLength(2)
    expect(file.tasks[0].pages![0].html).toBe('<form>P1</form>')
    expect(file.tasks[0].pages![1].html).toBe('<form>P2</form>')

    const target = open(join(root, 'importer'))
    const out = target.importTasks(file)
    expect(out.imported).toHaveLength(1)
    const cfg = target.get(out.imported[0].id)!
    expect(cfg.pages).toHaveLength(2)
    expect(cfg.pages!.map((p) => p.name)).toEqual(['第 1 页', '第二页'])
    expect(target.pageHtml(out.imported[0].id, 'p1')).toBe('<form>P1</form>')
    expect(target.pageHtml(out.imported[0].id, 'p2')).toBe('<form>P2</form>')
    // 当前页（第 2 页）的指纹随页一起带过来，对钩判定不会失忆
    expect(cfg.questionsFor).toBe('fp2')
  })

  it('导入不带 pages 的老导出文件：按顶层字段合成单页', () => {
    const s = open()
    const out = s.importTasks({
      format: 'form-filler-task',
      formatVersion: 1,
      exportedAt: '2026-09-19T10:00:00.000Z',
      tasks: [
        {
          name: '老格式',
          link: 'https://old',
          channel: '',
          questions: [q('q1')],
          answers: { q1: 'A' },
          sourceHtml: '<form>OLD</form>'
        }
      ] as never
    })
    const cfg = s.get(out.imported[0].id)!
    expect(cfg.pages).toHaveLength(1)
    expect(cfg.pages![0].questions).toHaveLength(1)
    expect(s.pageHtml(out.imported[0].id, 'p1')).toBe('<form>OLD</form>')
  })

  it('删任务进历史任务时，页数计入元信息并可恢复', () => {
    const s = open()
    const it = s.create()
    s.patch(it.id, { questions: [q('q1')], answers: { q1: 'A' } })
    s.pageCreate(it.id, { html: '<form>P2</form>' })
    s.patch(it.id, { questions: [q('q9')], answers: { q9: 'B' } })

    s.trash(it.id)
    const t = s.listTrash().find((x) => x.id === it.id)!
    expect(t.questionCount).toBe(2)

    s.restore(it.id)
    const cfg = s.get(it.id)!
    expect(cfg.pages).toHaveLength(2)
    expect(s.pageHtml(it.id, 'p2')).toBe('<form>P2</form>')
  })
})
