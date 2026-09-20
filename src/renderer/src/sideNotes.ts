// 左栏说明折叠块的展开状态存取。
//
// 纯函数 + 显式传入 store（浏览器传 localStorage），方便单测：不依赖真实 localStorage，
// 损坏/不可用的情况也不会把界面搞崩——读失败一律当「收起」，写失败静默忽略。

/** 只用到这两个方法，便于测试时传假实现 */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 所有说明折叠块的展开状态存在同一个键下：{ [标题]: true } */
export const SIDE_NOTES_KEY = 'ff.sideNotes'

/** 该说明块是否处于展开状态（默认收起） */
export function noteOpen(store: KeyValueStore, title: string): boolean {
  try {
    const raw = store.getItem(SIDE_NOTES_KEY)
    if (!raw) return false
    const map = JSON.parse(raw) as Record<string, unknown>
    return map[title] === true
  } catch {
    return false
  }
}

/** 记录展开/收起；写失败（隐私模式、配额满）不影响使用 */
export function setNoteOpen(store: KeyValueStore, title: string, open: boolean): void {
  try {
    const raw = store.getItem(SIDE_NOTES_KEY)
    let map: Record<string, unknown> = {}
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          map = parsed as Record<string, unknown>
        }
      } catch {
        /* 旧值损坏：直接覆盖，不连累其它块 */
      }
    }
    map[title] = open
    store.setItem(SIDE_NOTES_KEY, JSON.stringify(map))
  } catch {
    /* 忽略 */
  }
}
