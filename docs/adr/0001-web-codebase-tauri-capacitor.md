# 单一 Web 代码库 + Tauri/Capacitor 打包（不用游戏引擎）

游戏需同时发布 Steam（PC，含小组件模式）与 TapTap（Android），且产品要求"小"。决定：全部 UI 与逻辑用单一 TypeScript + Web 技术栈实现；桌面端用 Tauri 打包（无边框置顶小组件窗 + Steam 分发），移动端用 Capacitor 打包（TapTap 分发），PWA 作为开发期与网页兜底。布局竖屏优先，一套布局三端派生。

**Considered Options**: Unity/Godot 游戏引擎（玩法是 UI 驱动的模拟经营，无实时动作渲染需求，引擎换来的是大一个数量级的包体与三端 UI 重写）；Flutter（可行，但桌面无边框小组件生态与 Steam 集成路径不如 Tauri 成熟）。

**Consequences**: Steam 成就/云存档等平台能力需经 Tauri 原生桥接；Capacitor 是 TapTap 发布的必经路径，不再是"以后再说"。
