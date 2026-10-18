import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// base 用相对路径,便于后续 Tauri / Capacitor 打包嵌入(ADR-0001)。
// 多页入口(T19):index.html = 全窗(竖屏应用),widget.html = 桌面小组件页。
// strictPort:Tauri dev 的 devUrl 固定 5173(src-tauri/tauri.conf.json),
// 端口被占时直接报错而不是悄悄换端口让桌面壳连不上。
export default defineConfig({
  base: './',
  server: {
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        widget: fileURLToPath(new URL('./widget.html', import.meta.url)),
      },
    },
  },
});
