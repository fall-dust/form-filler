import { describe, expect, it } from 'vitest'
import { SIDE_NOTES_KEY, noteOpen, setNoteOpen, type KeyValueStore } from '../sideNotes'

/** 内存版 store：可以指定初始内容，也可以让它写失败 */
function makeStore(init: Record<string, string> = {}, failWrite = false): KeyValueStore & {
  dump: () => Record<string, string>
} {
  const map = { ...init }
  return {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => {
      if (failWrite) throw new Error('quota exceeded')
      map[k] = v
    },
    dump: () => map
  }
}

describe('左栏说明折叠状态', () => {
  it('没有记录时默认收起', () => {
    expect(noteOpen(makeStore(), '说明：A')).toBe(false)
  })

  it('记录过展开则读出展开', () => {
    const store = makeStore()
    setNoteOpen(store, '说明：A', true)
    expect(noteOpen(store, '说明：A')).toBe(true)
  })

  it('只认 true，其它值一律当收起', () => {
    const store = makeStore({ [SIDE_NOTES_KEY]: JSON.stringify({ '说明：A': 'yes' }) })
    expect(noteOpen(store, '说明：A')).toBe(false)
  })

  it('写入时保留其它块的记录', () => {
    const store = makeStore()
    setNoteOpen(store, '说明：A', true)
    setNoteOpen(store, '说明：B', true)
    setNoteOpen(store, '说明：B', false)
    expect(noteOpen(store, '说明：A')).toBe(true)
    expect(noteOpen(store, '说明：B')).toBe(false)
  })

  it('旧值损坏时不抛错，且能正常写入新记录', () => {
    const store = makeStore({ [SIDE_NOTES_KEY]: '{不是 JSON' })
    expect(noteOpen(store, '说明：A')).toBe(false)
    setNoteOpen(store, '说明：A', true)
    expect(noteOpen(store, '说明：A')).toBe(true)
  })

  it('值不是对象（数组/字符串）时按空处理', () => {
    const store = makeStore({ [SIDE_NOTES_KEY]: '[1,2,3]' })
    setNoteOpen(store, '说明：A', true)
    expect(noteOpen(store, '说明：A')).toBe(true)
  })

  it('写失败（隐私模式/配额满）不抛错，读仍是收起', () => {
    const store = makeStore({}, true)
    expect(() => setNoteOpen(store, '说明：A', true)).not.toThrow()
    expect(noteOpen(store, '说明：A')).toBe(false)
  })
})
