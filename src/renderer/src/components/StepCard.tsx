import { useState, type ReactNode } from 'react'

export type StepStatus = 'done' | 'active' | 'idle'

/**
 * 可折叠步骤卡：流水线的基本单元。
 * 完成的步骤折叠成一行摘要（summary），点击可再展开；
 * open 传入时为受控模式，否则内部自管。
 */
export default function StepCard({
  step,
  title,
  status,
  summary,
  actions,
  children,
  open: openProp,
  onToggle,
  defaultOpen = true
}: {
  step: number
  title: string
  status: StepStatus
  /** 折叠时的摘要内容（如「已粘贴 N 字符」「已导入 9 题」） */
  summary?: ReactNode
  /** 头部右侧操作按钮（展开时显示） */
  actions?: ReactNode
  children: ReactNode
  open?: boolean
  onToggle?: (next: boolean) => void
  defaultOpen?: boolean
}): JSX.Element {
  const [openInner, setOpenInner] = useState(defaultOpen)
  const open = openProp ?? openInner
  const toggle = (next: boolean): void => {
    if (onToggle) onToggle(next)
    else setOpenInner(next)
  }

  const dot =
    status === 'done' ? (
      <span className="step-dot done" title="已完成">✓</span>
    ) : status === 'active' ? (
      <span className="step-dot active">{step}</span>
    ) : (
      <span className="step-dot idle">{step}</span>
    )

  return (
    <section className={`step-card ${status === 'active' ? 'current' : ''}`}>
      <div className="step-head" onClick={() => toggle(!open)}>
        {dot}
        <div className="step-titles">
          <span className="step-title">
            {step} · {title}
          </span>
          {!open && summary != null && <span className="step-summary">{summary}</span>}
        </div>
        {open && actions != null && (
          <div className="step-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}
        <button className="step-fold" title={open ? '折叠' : '展开'}>
          {open ? '▾' : '▸'}
        </button>
      </div>
      {open && <div className="step-body">{children}</div>}
    </section>
  )
}
