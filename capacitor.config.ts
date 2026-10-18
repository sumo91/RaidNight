import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 安卓装配(T21,ADR-0001:TapTap 分发走 Capacitor)。
 *
 * 与桌面壳同款的「薄装配」原则:web 代码(src/)完全不感知 Capacitor
 * —— 不 import 任何 @capacitor/* 运行时,安卓 WebView 直接加载
 * `dist/index.html`(全窗页;tauriAvailable() 为 false → 浏览器回退
 * 路径,属主恒为本页,存档走 localStorage,由 WebView 数据目录持久)。
 *
 * appId 与 src-tauri/tauri.conf.json 的 identifier 保持同一反向域名。
 */
const config: CapacitorConfig = {
  appId: 'dev.raidnight.wowidle',
  appName: 'WowIdle',
  webDir: 'dist',
};

export default config;
