import { describe, it, expect } from 'vitest'
import { similarity, bestMatch } from '../similarity'

describe('similarity 文本相似度', () => {
  it('完全相等 = 1', () => {
    expect(similarity('性别', '性别')).toBe(1)
  })

  it('包含关系 = 0.9', () => {
    expect(similarity('姓名', '你的姓名？')).toBe(0.9)
  })

  it('LCS 比例（非包含关系）', () => {
    // 满意 vs 满足：LCS=1（"满"），ratio = 2/4 = 0.5
    expect(similarity('满意', '满足')).toBeCloseTo(0.5, 5)
  })

  it('不相关文本低分', () => {
    expect(similarity('姓名', '日期')).toBe(0)
  })

  it('忽略大小写', () => {
    expect(similarity('yes', 'Yes')).toBe(1)
  })
})

describe('bestMatch', () => {
  it('返回最佳匹配索引', () => {
    expect(bestMatch('男', ['男', '女', '保密'])).toBe(0)
    expect(bestMatch('满意', ['非常满意', '满意', '一般'])).toBe(1)
  })

  it('低于阈值返回 -1', () => {
    expect(bestMatch('xyz', ['男', '女'])).toBe(-1)
  })
})
