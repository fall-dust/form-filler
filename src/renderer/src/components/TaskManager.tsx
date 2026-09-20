import { useCallback, useEffect, useState } from 'react'
import type { SnapshotLabel, SnapshotMeta, TaskIndexItem, TaskStoreSettings, TrashItem } from '../types'

interface Props {
  tasks: TaskIndexItem[]
  activeId: string
  settings: TaskStoreSettings | null
  onClose: () => void
  onSelect: (id: string) => void
  onCreate: () => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onDuplicate: (id: string) => Promise<void>
  onTrash: (id: string) => Promise<void>
  onResetContent: (id: string, name: string) => void
  onExport: (ids: string[] | 'all') => Promise<void>
  onExportAll: () => Promise<void>
  onImport: () => Promise<void>
  onRestore: (id: string) => Promise<void>
  onPurgeTrash: (id: string) => Promise<void>
  onEmptyTrash: () => Promise<void>
  onRollback: (id: string, ts: string) => Promise<void>
  onSaveSettings: (patch: Partial<TaskStoreSettings>) => Promise<void>
}

const LABEL_TEXT: Record<SnapshotLabel, string> = {
  auto: '自动',
  manual: '手动',
  'key-action': '关键动作',
  'pre-rollback': '覆盖前',
  // 抓取新网页前的自动存档：上一页的 HTML 与题目留在这一份里，可连页面一起回滚
  'pre-grab': '抓取前'
}

/** 相对时间（越近越友好，超过一个月直接给日期） */
function rel(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const d = Date.now() - t
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  if (d < 30 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`
  return new Date(t).toLocaleDateString('zh-CN')
}

function fmtSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

/** 剩余保留期文案 */
function remainText(expiresAt: string | null): string {
  if (!expiresAt) return '永久保留'
  const left = Date.parse(expiresAt) - Date.now()
  if (left <= 0) return '即将清理'
  const days = Math.ceil(left / 86_400_000)
  return days > 1 ? `剩余 ${days} 天` : '剩余不足 1 天'
}

export default function TaskManager(props: Props): JSX.Element {
  const {
    tasks,
    activeId,
    settings,
    onClose,
    onSelect,
    onCreate,
    onRename,
    onDuplicate,
    onTrash,
    onResetContent,
    onExport,
    onExportAll,
    onImport,
    onRestore,
    onPurgeTrash,
    onEmptyTrash,
    onRollback,
    onSaveSettings
  } = props

  const [tab, setTab] = useState<'tasks' | 'trash'>('tasks')
  const [trash, setTrash] = useState<TrashItem[]>([])
  // 首次拉取完成前不显示数字，避免先闪一下「（0）」再跳成真实值
  const [trashLoaded, setTrashLoaded] = useState(false)

  // 就地重命名
  const [renamingId, setRenamingId] = useState('')
  const [renameValue, setRenameValue] = useState('')

  // 历史版本
  const [historyId, setHistoryId] = useState('')
  const [snaps, setSnaps] = useState<SnapshotMeta[]>([])

  // 二次确认（仅用于不可逆的彻底删除）
  const [purgeId, setPurgeId] = useState('')
  const [emptyConfirm, setEmptyConfirm] = useState(false)

  /** 每次打开、或外部动作后都重新拉取，避免正则在两处维护 */
  const loadTrash = useCallback(async (): Promise<void> => {
    setTrash((await window.api.trashList()) as TrashItem[])
    setTrashLoaded(true)
  }, [])

  // 挂载即拉取：抽屉打开时「历史任务（N）」的数字必须是真实值，不能等到切到该页才算
  // tasks 变化（删除/恢复/彻底删除/清空）后也重新拉，保证数字与内容同步
  useEffect(() => {
    void loadTrash()
  }, [tasks, loadTrash])

  const loadSnaps = useCallback(async (id: string): Promise<void> => {
    setSnaps((await window.api.tasksSnapshots(id)) as SnapshotMeta[])
  }, [])

  const toggleHistory = async (id: string): Promise<void> => {
    if (historyId === id) {
      setHistoryId('')
      return
    }
    setHistoryId(id)
    await loadSnaps(id)
  }

  const commitRename = async (): Promise<void> => {
    const id = renamingId
    const name = renameValue.trim()
    setRenamingId('')
    if (!id || !name) return
    await onRename(id, name)
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="drawer-tabs">
            <button
              className={`tab ${tab === 'tasks' ? 'active' : ''}`}
              onClick={() => setTab('tasks')}
            >
              任务（{tasks.length}）
            </button>
            <button
              className={`tab ${tab === 'trash' ? 'active' : ''}`}
              onClick={() => setTab('trash')}
            >
              历史任务{trashLoaded ? `（${trash.length}）` : ''}
            </button>
          </div>
          <button className="step-fold" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="drawer-body">
          {tab === 'tasks' ? (
            <>
              {tasks.length === 0 && <p className="hint">暂无任务，点下方「新建任务」开始。</p>}
              {tasks.map((t) => (
                <div key={t.id} className={`task-row ${t.id === activeId ? 'current' : ''}`}>
                  <div className="task-row-main" onClick={() => onSelect(t.id)}>
                    {renamingId === t.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename()
                          if (e.key === 'Escape') setRenamingId('')
                        }}
                      />
                    ) : (
                      <span className="task-row-name">
                        {t.id === activeId ? '● ' : ''}
                        {t.name}
                      </span>
                    )}
                    <span className="hint">
                      {t.questionCount} 题 · 已答 {t.answerCount} · 更新于 {rel(t.updatedAt)}
                      {t.hasHtml ? ' · 含 HTML' : ''}
                    </span>
                  </div>
                  <div className="task-actions">
                    <button
                      className="link"
                      onClick={() => {
                        setRenamingId(t.id)
                        setRenameValue(t.name)
                      }}
                    >
                      重命名
                    </button>
                    <button className="link" onClick={() => void onDuplicate(t.id)}>
                      复制
                    </button>
                    <button className="link" onClick={() => void toggleHistory(t.id)}>
                      {historyId === t.id ? '收起历史' : '历史版本'}
                    </button>
                    <button className="link" onClick={() => void onExport([t.id])}>
                      导出
                    </button>
                    <button className="link" onClick={() => onResetContent(t.id, t.name)}>
                      清空内容
                    </button>
                    <button className="link danger-link" onClick={() => void onTrash(t.id)}>
                      删除
                    </button>
                  </div>

                  {historyId === t.id && (
                    <div className="history">
                      <div className="history-head">
                        <span className="hint">历史版本（回滚前会自动再留一份当前状态）</span>
                        <button
                          className="link"
                          onClick={() =>
                            void (async () => {
                              await window.api.tasksSnapshotCreate(t.id, 'manual')
                              await loadSnaps(t.id)
                            })()
                          }
                        >
                          新建快照
                        </button>
                      </div>
                      {snaps.length === 0 && <p className="hint">还没有历史版本。</p>}
                      <ul className="snap-list">
                        {snaps.map((s) => (
                          <li key={s.ts}>
                            <span className="snap-time">{new Date(s.createdAt).toLocaleString('zh-CN')}</span>
                            <span className={`badge snap-${s.label}`}>{LABEL_TEXT[s.label]}</span>
                            <span className="hint">
                              {s.questionCount} 题 · 已答 {s.answerCount} · {fmtSize(s.size)}
                              {s.hasHtml ? ' · 含页面 HTML' : ''}
                            </span>
                            <button
                              className="link"
                              onClick={() =>
                                void (async () => {
                                  await onRollback(t.id, s.ts)
                                  await loadSnaps(t.id)
                                })()
                              }
                            >
                              回滚到此版本
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}

              <div className="drawer-foot">
                <button className="primary" onClick={() => void onImport()}>
                  导入配置
                </button>
                <button onClick={() => void onExportAll()} disabled={tasks.length === 0}>
                  导出全部任务
                </button>
                <button onClick={() => void onCreate()}>新建任务</button>
              </div>
            </>
          ) : (
            <>
              {trash.length === 0 && <p className="hint">还没有历史任务：删掉的任务会先放到这里，可随时恢复。</p>}
              {trash.length > 0 && (
                <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
                  这里放的是删掉的任务（与单个任务的「历史版本」不是一回事）。想继续用就点「恢复」；
                  超过保留期的会被自动清理。
                </p>
              )}
              {trash.map((tr) => (
                <div key={tr.id} className="task-row">
                  <div className="task-row-main">
                    <span className="task-row-name">{tr.name}</span>
                    <span className="hint">
                      {tr.questionCount} 题 · 删除于 {rel(tr.deletedAt)} · {remainText(tr.expiresAt)}
                    </span>
                  </div>
                  <div className="task-actions">
                    <button className="link" onClick={() => void onRestore(tr.id)}>
                      恢复
                    </button>
                    {purgeId === tr.id ? (
                      <span className="danger-inline">
                        删除后无法恢复
                        <button
                          className="link danger-link"
                          onClick={() =>
                            void (async () => {
                              await onPurgeTrash(tr.id)
                              await loadTrash()
                              setPurgeId('')
                            })()
                          }
                        >
                          确定彻底删除
                        </button>
                        <button className="link" onClick={() => setPurgeId('')}>
                          取消
                        </button>
                      </span>
                    ) : (
                      <button className="link danger-link" onClick={() => setPurgeId(tr.id)}>
                        彻底删除
                      </button>
                    )}
                  </div>
                </div>
              ))}

              <div className="drawer-foot">
                <label style={{ margin: 0 }}>历史任务保留期</label>
                <select
                  style={{ width: 120 }}
                  value={settings?.trashRetentionDays ?? 30}
                  onChange={(e) => void onSaveSettings({ trashRetentionDays: Number(e.target.value) })}
                >
                  <option value={7}>7 天</option>
                  <option value={30}>30 天</option>
                  <option value={90}>90 天</option>
                  <option value={0}>永久保留</option>
                </select>
                {emptyConfirm ? (
                  <span className="danger-inline">
                    清空后无法恢复
                    <button
                      className="link danger-link"
                      onClick={() =>
                        void (async () => {
                          await onEmptyTrash()
                          await loadTrash()
                          setEmptyConfirm(false)
                        })()
                      }
                    >
                      确定清空
                    </button>
                    <button className="link" onClick={() => setEmptyConfirm(false)}>
                      取消
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setEmptyConfirm(true)} disabled={trash.length === 0}>
                    清空历史任务
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
