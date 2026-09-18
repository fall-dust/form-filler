import type { Question } from '../types'
import PromptGenerator from './PromptGenerator'

interface Props {
  link: string
  setLink: (v: string) => void
  hasLogin: boolean
  setHasLogin: (v: boolean) => void
  headless: boolean
  setHeadless: (v: boolean) => void
  channel: string
  setChannel: (v: string) => void
  html: string
  setHtml: (v: string) => void
  onImport: (questions: Question[]) => void
  onImportAnswers: (answers: Record<string, string>) => void
  questions: Question[]
  answers: Record<string, string>
  setAnswer: (id: string, v: string) => void
}

function AnswerCell({
  q,
  value,
  setAnswer
}: {
  q: Question
  value: string
  setAnswer: (id: string, v: string) => void
}): JSX.Element {
  const isChoice =
    q.type === 'radio' || q.type === 'judge' || q.type === 'select' || q.type === 'matrix'

  // 选项已知 → 下拉选择
  if (isChoice && q.options.length > 0) {
    return (
      <select value={value} onChange={(e) => setAnswer(q.id, e.target.value)}>
        <option value="">（未选）</option>
        {q.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  if (q.type === 'checkbox') {
    return (
      <input
        type="text"
        value={value}
        placeholder="多选用逗号分隔"
        onChange={(e) => setAnswer(q.id, e.target.value)}
      />
    )
  }
  // 选项未知 → 自由文本，脚本运行时动态读取选项并匹配
  const placeholder = isChoice ? '输入选项文字，如：B、@Pointcut' : ''
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => setAnswer(q.id, e.target.value)}
    />
  )
}

export default function ConfigPanel(props: Props): JSX.Element {
  const {
    link,
    setLink,
    hasLogin,
    setHasLogin,
    headless,
    setHeadless,
    channel,
    setChannel,
    html,
    setHtml,
    onImport,
    onImportAnswers,
    questions,
    answers,
    setAnswer
  } = props

  return (
    <div>
      <div className="row">
        <div style={{ flex: 3 }}>
          <label>目标链接</label>
          <input
            type="text"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://example.com/form"
          />
        </div>
        <div style={{ flex: 'none' }}>
          <label>浏览器</label>
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">随包 Chromium（默认）</option>
            <option value="msedge">系统 Edge（瘦身）</option>
            <option value="chrome">系统 Chrome（瘦身）</option>
          </select>
        </div>
        <div style={{ flex: 'none' }}>
          <label>
            <input
              type="checkbox"
              checked={hasLogin}
              onChange={(e) => setHasLogin(e.target.checked)}
              style={{ marginRight: 4 }}
            />
            有登录环节
          </label>
        </div>
        <div style={{ flex: 'none' }}>
          <label title="无头模式：勾选后浏览器在后台静默运行、不弹窗；不勾选则弹出可见窗口">
            <input
              type="checkbox"
              checked={headless}
              onChange={(e) => setHeadless(e.target.checked)}
              style={{ marginRight: 4 }}
            />
            headless（无头）
          </label>
        </div>
      </div>

      <p className="hint" style={{ marginTop: -4 }}>
        headless（无头模式）：勾选后浏览器在后台静默运行、不弹出窗口；不勾选则弹出可见窗口。
        本工具「绝不自动提交」，需你人工核对并手动提交，因此通常保持不勾选。
      </p>

      <label>粘贴表单 HTML（用于生成提示词）</label>
      <textarea
        value={html}
        onChange={(e) => setHtml(e.target.value)}
        placeholder="<form> … </form>"
      />

      <PromptGenerator
        html={html}
        questions={questions}
        onImport={onImport}
        onImportAnswers={onImportAnswers}
      />

      {questions.length > 0 && (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>ID</th>
              <th>题干</th>
              <th>题型</th>
              <th>选项</th>
              <th>答案</th>
            </tr>
          </thead>
          <tbody>
            {questions.map((q) => (
              <tr key={q.id}>
                <td className="mono">{q.id}</td>
                <td>{q.question || '（未识别）'}</td>
                <td>{q.type}</td>
                <td>
                  {q.type === 'matrix'
                    ? `${q.matrixRows?.join('、')} × ${q.options.join(' / ')}`
                    : q.options.join(' / ')}
                </td>
                <td className="answer">
                  <AnswerCell q={q} value={answers[q.id] ?? ''} setAnswer={setAnswer} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
