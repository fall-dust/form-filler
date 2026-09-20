import { useState, type ReactNode } from 'react'
import { noteOpen, setNoteOpen } from '../sideNotes'

/** localStorage 在某些环境下取用会抛错，统一包一层 */
function safeStore(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * 左栏长说明的折叠块：默认收起，只占一行；展开状态按标题记在本机。
 *
 * 目的：左栏是 260px 的窄列，整段说明会把控件挤走。这里把「解释」收起来，
 * 标题本身写清楚讲什么（如「说明：会话 · 多页填写 · 登录态」），需要时点开看全文。
 */
export function SideNote({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(() => {
    const store = safeStore()
    return store ? noteOpen(store, title) : false
  })

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    const store = safeStore()
    if (store) setNoteOpen(store, title, next)
  }

  return (
    <div className="side-note">
      <button
        type="button"
        className="side-note-head"
        aria-expanded={open}
        onClick={toggle}
        title={open ? '收起说明' : '展开说明'}
      >
        <span className={open ? 'chev chev-open' : 'chev'} aria-hidden="true">
          ▸
        </span>
        {title}
      </button>
      {open && <div className="side-note-body">{children}</div>}
    </div>
  )
}
