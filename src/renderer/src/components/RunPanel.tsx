import { useEffect, useState } from 'react'
import type { FillProgress, FillReport } from '../types'

interface Props {
  running: boolean
  progress: FillProgress[]
  report: FillReport | null
  error: string
  onRun: () => void
  onStop: () => void
}

/** 超长文本折叠/展开 */
function CollapsibleText({ text, max = 60 }: { text: string; max?: number }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  if (text.length <= max) return <>{text}</>
  return (
    <span>
      {expanded ? text : `${text.slice(0, max)}…`}
      <button className="link" onClick={() => setExpanded((v) => !v)}>
        {expanded ? '收起' : '展开'}
      </button>
    </span>
  )
}

export default function RunPanel(props: Props): JSX.Element {
  const { running, progress, report, error, onRun, onStop } = props
  const [shots, setShots] = useState<Record<string, string>>({})

  // 报告更新后，把失败截图读成 base64 数据 URL 内嵌展示
  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      const list = report?.screenshots ?? []
      if (list.length === 0) {
        if (!cancelled) setShots({})
        return
      }
      const map: Record<string, string> = {}
      for (const p of list) {
        const url = (await window.api.readScreenshot(p)) as string | null
        if (url) map[p] = url
      }
      if (!cancelled) setShots(map)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [report])

  return (
    <div>
      {error && <div className="error-banner">填写失败：{error}</div>}

      <div className="row">
        <button className="primary" onClick={onRun} disabled={running}>
          开始填写
        </button>
        <button className="danger" onClick={onStop} disabled={!running}>
          停止
        </button>
        <span className="hint">填完后浏览器保持打开，由你人工核对并自行提交。</span>
      </div>

      {report && (
        <div>
          <div className="summary">
            <div>
              总题数 <b>{report.summary.total}</b>
            </div>
            <div>
              已填 <b>{report.summary.filled}</b>
            </div>
            <div>
              未命中 <b>{report.summary.missing}</b>
            </div>
            <div>
              失败 <b>{report.summary.failed}</b>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>题目</th>
                <th>状态</th>
                <th>策略</th>
                <th>答案</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {report.fields.map((f) => (
                <tr key={f.id}>
                  <td className="mono">{f.id}</td>
                  <td>
                    <span className={`badge ${f.status}`}>{f.status}</span>
                  </td>
                  <td className="mono">{f.strategy ?? ''}</td>
                  <td>{f.answer ?? ''}</td>
                  <td className="warn">
                    {f.error ? <CollapsibleText text={f.error} /> : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.screenshots && report.screenshots.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <p className="hint">失败截图：</p>
              {report.screenshots.map((s) => (
                <div key={s} style={{ marginBottom: 12 }}>
                  {shots[s] ? (
                    <img
                      src={shots[s]}
                      alt={s}
                      style={{
                        maxWidth: '100%',
                        border: '1px solid #d0d7de',
                        borderRadius: 6
                      }}
                    />
                  ) : (
                    <span className="mono">{s}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 运行日志：持久显示，不因运行结束而消失 */}
      {progress.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p className="hint">
            运行日志（{running ? '进行中' : '已结束'}）
            {progress[progress.length - 1] &&
              ` · ${progress[progress.length - 1].index}/${progress[progress.length - 1].total}`}
          </p>
          <ul>
            {progress.map((p) => (
              <li key={`${p.index}-${p.id}`} style={{ marginBottom: 4 }}>
                <span className={`badge ${p.status}`}>{p.status}</span>{' '}
                <span className="mono">{p.id}</span>{' '}
                {p.answer ? <span>{p.answer}</span> : null}{' '}
                {p.message ? <CollapsibleText text={p.message} /> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
