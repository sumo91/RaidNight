# WowIdle 桌面壳(Tauri v2)

T19 小组件模式(GLOSSARY:小组件模式)的桌面壳。壳内**没有任何游戏规则**
(ADR-0001:模拟本体在 Web 侧 `src/`,经门面接缝运转),只做两件事:

1. **开窗**:小组件窗(无边框、置顶、透明、跳过任务栏、可调大小,常驻)+
   全窗(按需创建;关闭 = 隐藏收回小组件形态,进程常驻)。
2. **模拟属主仲裁**:窗口可见性即属主 —— 全窗可见 ⇒ 全窗独占推进,
   否则小组件常驻推进;切换时广播 `wn:owner` 事件(载荷 0/1),
   页面冷加载可用 `sim_owner` 命令补问。两页共享同一 localStorage 存档,
   交还时停表落盘、接管时按存档时间戳补结算(ADR-0003,幂等),绝不双推进。

窗口几何(贴角吸附 / 大小位置记忆 / 抓柄调大小)在页内完成:
`src/shell/widget-window.ts`(纯数学裁决在 `src/shell/widget-geometry.ts`)。

## 运行(需要 Rust 工具链)

本目录代码在本机没有 Rust 工具链时**未经过编译验证**(T19 提交时本机
无 cargo/rustc;Windows 交叉构建与打包验证属 T21)。装好 Rust 后:

```bash
# 方式一:官方 CLI(任选其一)
npm install -D @tauri-apps/cli && npm run tauri dev
cargo install tauri-cli && cargo tauri dev

# 方式二:直接 cargo(首次需自行装依赖)
cd src-tauri && cargo run
```

`tauri dev` 会先起 Vite 开发服务器(devUrl 固定 5173,见 vite.config.ts
的 strictPort),再开小组件窗。点击小组件卡片进入全窗;关全窗 = 收回
小组件形态;关小组件窗 = 退出应用。

## 图标

`icons/` 由 `npm run gen:icon` 生成(零依赖,走 T17 美术管线的
量化 + 描边链;ICNS/ICO 容器为手写拼装)。换图标:改
`scripts/gen-app-icon.ts` 的字符画后重跑;或后续用 `tauri icon` 从
`icons/icon.png` 重新派生全套。

## 已知边界(T21 处理)

- Windows 打包(`.ico` 已就位,PNG 压缩条目格式)与 NSIS/Steam 分发。
- capability 权限名以本仓 `capabilities/default.json` 为准,如遇 ACL
  校验报错(版本差异),按报错提示核对 `core:window:*` 条目名。
