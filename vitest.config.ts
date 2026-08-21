import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // 冒烟测试会 spawn 子进程（tsx 加载 src/main.ts），CI 冷启动下较慢
    testTimeout: 30_000,
  },
});
