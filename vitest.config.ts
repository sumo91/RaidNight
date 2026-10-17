import { defineConfig } from 'vitest/config';

// 门面测试不依赖 DOM:node 环境即可(测试接缝见 src/sim/facade.ts)。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
