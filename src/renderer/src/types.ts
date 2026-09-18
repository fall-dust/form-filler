export type QuestionType =
  | 'text'
  | 'textarea'
  | 'radio'
  | 'judge'
  | 'checkbox'
  | 'select'
  | 'date'
  | 'file'
  | 'matrix'

export interface SelectorStrategy {
  css?: string
  xpath?: string
  text?: string
}

export interface Question {
  id: string
  question: string
  type: QuestionType
  options: string[]
  optionValues: string[]
  matrixRows?: string[]
  selectors: SelectorStrategy[]
  hint?: string
}

export type FieldStatus = 'filled' | 'missing' | 'failed'

export interface FieldResult {
  id: string
  status: FieldStatus
  strategy?: string
  answer?: string
  error?: string
}

export interface FillReport {
  runTime: string
  siteLink: string
  dryRun: boolean
  fields: FieldResult[]
  summary: { total: number; filled: number; missing: number; failed: number }
  screenshots?: string[]
}

export interface FillProgress {
  id: string
  index: number
  total: number
  status: FieldStatus
  answer?: string
  message?: string
}
