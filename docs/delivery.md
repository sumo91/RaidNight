# 交付打包指南(T21)—— Steam(Win) + TapTap(Android)

ADR-0001 的交付面:桌面 = Tauri(Steam),移动 = Capacitor(TapTap);
买断制、纯单机、无后端(ADR-0003)。本文是各平台的构建路径、验证记录
与**如实标注的缺口**。版本三处对齐:根 `package.json`、
`src-tauri/tauri.conf.json`、`android/app/build.gradle`(当前 0.1.0)。

| 平台 | 产物 | 构建路径 | 状态 |
| --- | --- | --- | --- |
| macOS 桌面 | `WowIdle.app` + `.dmg` | 本机 `npx tauri build` | ✅ 本机已产出并验证可运行 |
| Windows 桌面 | NSIS 安装器 | CI:桌面构建工作流 | ⚠️ 本机无 MSVC,产物在 CI(见 §2) |
| Android | APK(debug/release) | CI:安卓构建工作流 | ⚠️ 本机无 JDK/SDK,产物在 CI(见 §3) |
| 商店素材 | 图标/胶囊/截图/文案 | `store/`(本仓) | ✅ 就绪(见 §5) |

## 1. macOS 桌面(本机验证通过)

```bash
npm install            # @tauri-apps/cli 已在 devDependencies
npx tauri build        # 先 npm run build 出 dist/,再 cargo 出 .app
```

产物:`src-tauri/target/release/bundle/macos/WowIdle.app`。
T21 本机验证记录(2026-10-18,arm64):

- `.app` 启动正常(小组件窗形态),进程存活;
- 存档双介质落盘:`~/Library/Application Support/dev.raidnight.wowidle/wowidle-save.json`
  随每个滴答更新(kind=wowidle-save、version=13),时钟推进正确;
- 外部改写该文件后重启,应用按文件档恢复(文件 → localStorage 回灌链路验证);
- `store/desktop/WowIdle-0.1.0-aarch64.dmg` 可挂载、含 app 与 Applications 替身。

**本机已知坑**(macOS 文件保护层,同 AGENTS.md「如何测试」一节):

- `rustup` 装工具链会在 `~/.rustup` 的 rename 处反复失败
  (`could not rename 'downloaded' file ... os error 2`)。绕行:直接装
  官方独立分发包,不经 rustup:

  ```bash
  curl -sSfL https://static.rust-lang.org/dist/<日期>/rust-<版本>-aarch64-apple-darwin.tar.gz -o /tmp/rust.tar.gz
  tar xzf /tmp/rust.tar.gz && cd rust-*/ && ./install.sh --prefix="$HOME/.rust-standalone"
  export PATH="$HOME/.rust-standalone/bin:$PATH"
  ```

- `tauri build` 的 DMG 装帧步骤(create-dmg 经 Finder AppleScript 排布
  窗口)在本机会 AppleEvent 超时失败;`.app` 本身产出正常。需 DMG 时用
  素面 hdiutil(无 Finder 脚本):

  ```bash
  STG=$(mktemp -d)/staging && mkdir -p "$STG"
  cp -R src-tauri/target/release/bundle/macos/WowIdle.app "$STG/"
  ln -s /Applications "$STG/Applications"
  hdiutil create -volname WowIdle -srcfolder "$STG" -ov -format UDZO store/desktop/WowIdle-0.1.0-aarch64.dmg
  ```

## 2. Windows 桌面(CI 产出)

本机(macOS/arm64)不做 Windows 交叉编译 —— MSVC 目标需要 Windows SDK,
按工单约定走 CI:`.github/workflows/build-desktop.yml`。

1. GitHub 仓库 → Actions → 「桌面构建(Tauri)」→ Run workflow(或打 `v*` tag);
2. 等 `windows` 作业完成,从 artifact `WowIdle-windows-x64` 下载
   `WowIdle_0.1.0_x64-setup.exe`(NSIS 安装器,`--bundles nsis` 覆盖了
   配置里面向 macOS 的 targets);
3. `macos` 作业同配方出 `.app`/`.dmg`,证明 CI 可复现桌面产物。

**Steam 交付缺口(如实标注,未完成)**:

- Steamworks SDK 未接入:需要 Steam Partner 账号下载 SDK 并持有
  AppID,本仓无法代办。当前应用零 Steam 依赖、可独立运行。
- Steam 成就/覆盖层:ADR-0003 走平台 API,v1 未实现 —— 待 AppID 就位后
  经 Tauri 插件(tauri-plugin-steamworks 或自桥)接入,属后续工单。
- **Steam Cloud(Auto-Cloud,零代码路径)**:存档已落本地文件
  (`%APPDATA%/dev.raidnight.wowidle/wowidle-save.json`,macOS 同构)。
  Partner 后台 SteamCloud → Auto-Cloud 里把该路径加入同步根
  (Windows:`%APPDATA%/dev.raidnight.wowidle/`;macOS:
  `~/Library/Application Support/dev.raidnight.wowidle/`)即可,无需改代码。
- 上传:AppID 就位后用 steamcmd + depot build 脚本推送(命令见
  Steamworks 文档「Uploading a Build」),本仓不提交账号凭据。

## 3. Android / TapTap(CI 产出)

工程:`android/`(Capacitor 模板,已提交)+ `capacitor.config.ts`
(appId `dev.raidnight.wowidle`,webDir `dist`)。web 代码零 Capacitor
依赖 —— WebView 直载 `dist/index.html`,浏览器回退路径自然生效。

**本机缺口(如实标注)**:本机无 JDK(`java -version` 报缺运行时)也无
Android SDK,APK 构建一律走 CI:`.github/workflows/build-android.yml`。

1. Actions → 「安卓构建(Capacitor)」→ Run workflow(或打 `v*` tag);
2. 作业内容:`npm ci` → `npm run build` → `cap sync android` →
   `gradlew assembleDebug assembleRelease`(GitHub 托管 runner 自带
   Android SDK,JDK 由 setup-java 供给);
3. 产物:artifact `WowIdle-android-apk`(debug 可装即玩;release 无密钥时
   回退调试签名 —— `android/app/build.gradle` 的 `releaseSigning`)。
   JDK 用 21(Capacitor 8.5.3 的 Gradle 是 `VERSION_21`,17 编不过)。

**发布签名(上 TapTap 前必做,一次性)**:

```bash
keytool -genkey -v -keystore wowidle-release.keystore -alias wowidle \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -i wowidle-release.keystore | pbcopy   # 或 openssl base64
```

把四个值配成仓库 secrets:`WOWIDLE_KEYSTORE_BASE64`、
`WOWIDLE_KEYSTORE_PASSWORD`、`WOWIDLE_KEY_ALIAS`、`WOWIDLE_KEY_PASSWORD`。
之后同一工作流直出正式签名 release APK(密钥库文件由工作流从 base64
还原后注入 `WOWIDLE_KEYSTORE_PATH`)。keystore 本体与口令**不进仓**。

TapTap 提交:开发者中心 → 创建游戏(单机买断,约 ¥22–30)→ 上传
release APK → 填 `store/taptap/page-zh.md` 的文案与
`store/screenshots/` 的竖版截图 → 提审。

## 4. 存档持久化(桌面,ADR-0003「存档为本地文件」)

桌面端双介质,同一份版本化 JSON(sim/save.ts 编码):

- `localStorage`(WKWebView 热副本,起表即读)+
- 应用数据目录的本地文件(`wowidle-save.json`,壳侧临时文件 + 原子
  rename 写入)—— 强退不丢尾的权威副本,也是 Steam Auto-Cloud 的同步面。

冷启动:属主仲裁起表前先 `hydrateFromDisk()` 按封皮 `savedAtMs` 回灌
新者(裁决规则 `src/shell/save-sync.ts`,纯函数有直测)。
浏览器/PWA 路径不变(仅 localStorage)。Android WebView 的 localStorage
由系统数据目录持久,无需文件桥。

## 5. 商店素材(`store/`,全部可再生)

```bash
npm run gen:store   # Steam 胶囊 ×4 + TapTap 图标 + 安卓全密度启动图标
npm run gen:icon    # 桌面壳图标(src-tauri/icons/)
npm run sim:dump -- 5 /tmp/demo.json   # 商店截图用的第 5 周演示存档
```

- `store/steam/page-zh.md` —— 商店页文案(名称/简介/长文/标签/系统需求占位)
- `store/steam/capsule-*.png`、`library-600x900.png` —— 主胶囊 616×353、
  头部 460×215、小胶囊 231×87、库竖版 600×900
- `store/taptap/page-zh.md` + `icon-512.png` —— TapTap 文案与图标
- `store/screenshots/` —— 真实游戏截图:竖版 1080×1920(TapTap)×5、
  横版 1920×1080(Steam,T20 双栏)×3、小组件 420×320 ×1;
  截图状态来自真实门面模拟(种子 20261018,第 5 周存档注入)
- `store/desktop/`(gitignore,本地产物)—— mac DMG

游戏名是工作名「WowIdle」(DESIGN 未决项):定名后改
`scripts/gen-store-art.ts` 的 `TITLE` 与两份 page-zh.md 重跑即可。
