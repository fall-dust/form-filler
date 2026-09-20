import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // 渲染层只跑纯逻辑（提示词模板/解析），不依赖 DOM
    include: ['src/main/**/*.test.ts', 'src/renderer/**/*.test.ts']
  }
})
