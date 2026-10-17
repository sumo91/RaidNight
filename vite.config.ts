import { defineConfig } from 'vite';

// base 用相对路径,便于后续 Tauri / Capacitor 打包嵌入(ADR-0001)。
export default defineConfig({
  base: './',
});
