# WowIdle（工作名）

魔兽风格公会会长放置模拟游戏，面向 Steam 与 TapTap。项目语言与领域术语见 `GLOSSARY.md`，架构决策见 `docs/adr/`。

## 开发

技术栈：Vite + TypeScript（单一 Web 代码库，后续 Tauri/Capacitor 打包，ADR-0001）。不引入重型框架：游戏本体是纯 TS 状态机，UI 是原生 DOM 薄渲染层。

### 目录结构

- `src/sim/` — 游戏本体：确定性模拟门面状态机，**全项目唯一测试接缝**。输入 = 会长指令 + 游戏时间增量，输出 = 新状态 + 事件日志。
  - `facade.ts` 门面与纯函数 `step`；`state.ts` 状态形状；`commands.ts` 会长指令；`events.ts` 事件日志；`clock.ts` 游戏时钟常量与换算；`rng.ts` 注入式种子随机源。
- `src/content/` — 数据驱动内容（文案池、物品表等）。内容禁止硬编码进 `sim`。
- `src/ui/` — 状态之上的薄渲染层：禁止业务规则、禁止在此换算或推进游戏时间。
- `src/main.ts` — 装配层：创建门面、挂载 UI、把现实时间增量换算为游戏时间增量（全项目唯一允许出现现实时间的地方）。
- `index.html` / `vite.config.ts` / `vitest.config.ts` — 竖屏应用外壳与构建、测试配置。

### 如何测试

```bash
npm test          # vitest run --configLoader runner，一次跑完
npm run test:watch
```

测试只打门面接缝（`src/sim/facade.ts`）：给定种子与「指令 + 时间跳变」脚本，断言状态快照与事件日志；不启动 UI、不依赖 DOM。

> `--configLoader runner`（T12 评审修复引入）：vitest/vite 官方配置加载器，不经 esbuild 打包配置文件。动机 —— 本机 macOS 文件保护层会无限期阻塞 esbuild 二进制 `open()` 项目内（~/Documents 下）的文件，默认的 bundle 加载器让配置文件走 esbuild 真实打开，导致 `vitest run` / `vite build` 启动即挂起；runner 加载器不触发该路径，语义不变。

### 如何构建

```bash
npm run build     # tsc --noEmit && vite build --configLoader runner，产物在 dist/
npm run dev       # 本地开发服务器
npm run preview   # 预览构建产物
```

### 代码约定

- 领域术语以 `GLOSSARY.md` 为准（团员、小队、名册、团队、一轮……），命名不用 Avoid 词。
- 界面文案与代码注释一律中文；面向玩家的专有名词遵循 ADR-0002（原创命名，不用既有 IP 专名）。
- `src/sim/` 内禁用全局随机与现实时钟（不得出现 `Math.random` / `Date.now` / `performance.now`）；随机只走 `rng.ts` 的种子随机源，随机链状态存于 `GameState` 内、可序列化、可重放。
- 游戏时间以「游戏分钟」为原子（自建会起累计的整数）；速率常量（1 现实天 = 1 游戏周，ADR-0004）只存在于 `src/sim/clock.ts`；门面不接受现实时间，现实时间只在 `src/main.ts` 换算。
- 状态不可变：`step(prev, input)` 返回新状态，不得原地修改。
- 新内容优先落在 `src/content/` 做数据驱动，而非散落硬编码。
- 不引入工单之外的重型框架（状态管理库 / 游戏引擎 / 组件库均不需要）。

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (sumo91/RaidNight) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
