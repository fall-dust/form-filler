import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/** 断点续填状态：只记录未完成字段（对齐需求文档 §8.2） */
export type FieldState = 'missing' | 'failed'

export function loadState(path: string): Record<string, FieldState> {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

export function saveState(path: string, state: Record<string, FieldState>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8')
}

export function resetState(path: string): void {
  if (existsSync(path)) {
    writeFileSync(path, '{}', 'utf-8')
  }
}
