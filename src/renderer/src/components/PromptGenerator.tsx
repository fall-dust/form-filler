import { useState } from 'react'
import type { Question } from '../types'
import {
  buildPrompt,
  buildAnswerPrompt,
  parseImportedQuestions,
  parseImportedAnswers
} from '../prompt'

interface Props {
  html: string
  questions: Question[]
  onImport: (questions: Question[]) => void
  onImportAnswers: (answers: Record<string, string>) => void
}

export default function PromptGenerator({
  html,
  questions,
  onImport,
  onImportAnswers
}: Props): JSX.Element {
  // 元素/题型提示词
  const [prompt, setPrompt] = useState('')
  const [copied, setCopied] = useState(false)
  const [importText, setImportText] = useState('')
  const [error, setError] = useState('')

  // 答案提示词
  const [goal, setGoal] = useState('')
  const [answerPrompt, setAnswerPrompt] = useState('')
  const [answerCopied, setAnswerCopied] = useState(false)
  const [answerImportText, setAnswerImportText] = useState('')
  const [answerError, setAnswerError] = useState('')

  const generate = (): void => {
    setPrompt(buildPrompt(html))
    setCopied(false)
  }
  const copy = async (): Promise<void> => {
    if (await window.api.copyText(prompt)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  const doImport = (): void => {
    const r = parseImportedQuestions(importText)
    if (r.error) setError(r.error)
    else {
      setError('')
      onImport(r.questions!)
    }
  }

  const generateAnswer = (): void => {
    setAnswerPrompt(buildAnswerPrompt(questions, goal))
    setAnswerCopied(false)
  }
  const copyAnswer = async (): Promise<void> => {
    if (await window.api.copyText(answerPrompt)) {
      setAnswerCopied(true)
      setTimeout(() => setAnswerCopied(false), 1500)
    }
  }
  const doImportAnswers = (): void => {
    const r = parseImportedAnswers(answerImportText)
    if (r.error) setAnswerError(r.error)
    else {
      setAnswerError('')
      onImportAnswers(r.answers!)
    }
  }

  return (
    <div style={{ marginTop: 16, borderTop: '1px dashed #d0d7de', paddingTop: 12 }}>
      {/* ① 元素/题型提示词 */}
      <div className="row" style={{ alignItems: 'center' }}>
        <button onClick={generate} disabled={!html.trim()}>
          生成提示词（元素/题型）
        </button>
        <span className="hint">拿去问 AI，再把返回的 JSON 贴回下方导入。</span>
      </div>
      {prompt && (
        <div>
          <div className="row" style={{ alignItems: 'center', marginTop: 8 }}>
            <label style={{ margin: 0 }}>提示词（元素/题型）</label>
            <button onClick={copy}>{copied ? '已复制 ✓' : '复制'}</button>
          </div>
          <textarea readOnly value={prompt} style={{ minHeight: 200 }} />
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <label>粘贴 AI 返回的题目 JSON，导入</label>
        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder='[{"id":"q1","question":"…","type":"radio","options":["A、…"],"selectors":[{"css":"input[name=\"q1\"]"}]}]'
        />
        <div className="row" style={{ marginTop: 8, alignItems: 'center' }}>
          <button className="primary" onClick={doImport} disabled={!importText.trim()}>
            导入题目
          </button>
          {error && <span className="warn">{error}</span>}
        </div>
      </div>

      {/* ② 答案提示词（需先有题目） */}
      {questions.length > 0 && (
        <div style={{ marginTop: 16, borderTop: '1px solid #eaeef2', paddingTop: 12 }}>
          <label>作答目标 / 情境（可选）</label>
          <input
            type="text"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="如：这是考试，请给出正确答案；或：作为满意的客户作答"
          />
          <div className="row" style={{ alignItems: 'center', marginTop: 8 }}>
            <button onClick={generateAnswer}>生成答案提示词</button>
            <span className="hint">根据上面 {questions.length} 道题生成答案提示词。</span>
          </div>
          {answerPrompt && (
            <div>
              <div className="row" style={{ alignItems: 'center', marginTop: 8 }}>
                <label style={{ margin: 0 }}>答案提示词</label>
                <button onClick={copyAnswer}>{answerCopied ? '已复制 ✓' : '复制'}</button>
              </div>
              <textarea readOnly value={answerPrompt} style={{ minHeight: 180 }} />
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <label>粘贴 AI 返回的答案 JSON，导入</label>
            <textarea
              value={answerImportText}
              onChange={(e) => setAnswerImportText(e.target.value)}
              placeholder='{"q1":"B、@Pointcut","q5":["自动填表","断点续填"]}'
            />
            <div className="row" style={{ marginTop: 8, alignItems: 'center' }}>
              <button className="primary" onClick={doImportAnswers} disabled={!answerImportText.trim()}>
                导入答案
              </button>
              {answerError && <span className="warn">{answerError}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
