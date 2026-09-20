import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Page } from 'playwright-core'
import type { FillReport } from './types'

function timestamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 写填表报告，返回文件路径 */
export function writeReport(dir: string, report: FillReport): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, `report_${timestamp()}.json`)
  writeFileSync(p, JSON.stringify(report, null, 2), 'utf-8')
  return p
}

/** 定位失败/填写失败时截图，返回路径或 null */
export async function screenshotOnFail(
  page: Page,
  dir: string,
  id: string
): Promise<string | null> {
  try {
    mkdirSync(dir, { recursive: true })
    const p = join(dir, `${id}_fail_${timestamp()}.png`)
    // 显式给超时：会话的默认超时被压到 5s（见 browser.ts），对截图来说太短
    await page.screenshot({ path: p, timeout: 20_000 })
    return p
  } catch {
    return null
  }
}
