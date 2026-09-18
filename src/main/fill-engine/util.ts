/** 转义 CSS 属性选择器值中的反斜杠与双引号 */
export function cssEscape(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
