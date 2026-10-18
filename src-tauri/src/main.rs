//! WowIdle 桌面壳(T19,GLOSSARY:小组件模式)。
//!
//! 职责刻意收窄:开两扇窗 + 仲裁「模拟属主」,不承载任何游戏规则
//! (模拟本体在 Web 侧 src/,经门面接缝运转;ADR-0001)。
//!
//! 形态:
//! · 小组件窗(常驻主窗):无边框、置顶、透明、跳过任务栏、可调大小;
//!   贴角吸附 / 大小位置记忆在页内完成(shell/widget-window.ts)。
//! · 全窗:按需创建(首次点击小组件时),关闭 = 隐藏收回小组件形态,
//!   进程常驻(放置游戏的桌面陪伴形态)。
//!
//! 属主仲裁:窗口可见性即属主 —— 全窗可见 ⇒ 全窗独占推进模拟,
//! 否则小组件常驻推进。切换时广播 wn:owner 事件(载荷 0/1),页面冷加载
//! 可用 sim_owner 命令补问。两页共享同一 localStorage 存档,交还时停表
//! 落盘、接管时按存档时间戳补结算(幂等,ADR-0003),绝不双推进。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 模拟属主:0 = 小组件窗,1 = 全窗。
static SIM_OWNER: AtomicU8 = AtomicU8::new(0);

/// 属主切换广播事件名(页内监听见 shell/tauri.ts)。 */
const OWNER_EVENT: &str = "wn:owner";

fn set_owner(app: &AppHandle, owner: u8) {
    let prev = SIM_OWNER.swap(owner, Ordering::SeqCst);
    if prev != owner {
        let _ = app.emit(OWNER_EVENT, owner);
    }
}

/// 查询当前模拟属主(页面冷加载补问;返回 0 = 小组件,1 = 全窗)。
#[tauri::command]
fn sim_owner() -> u8 {
    SIM_OWNER.load(Ordering::SeqCst)
}

/// 打开全窗:小组件「点击进入全窗」经此调用。先切属主(小组件停表落盘),
/// 再显示既有全窗;首次调用时在主线程上创建(窗口与 WebView 只能主线程建)。
#[tauri::command]
fn open_main_window(app: AppHandle) -> Result<(), String> {
    set_owner(&app, 1);
    if let Some(win) = app.get_webview_window("main") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(err) = WebviewWindowBuilder::new(
            &handle,
            "main",
            WebviewUrl::App("index.html".into()),
        )
        .title("WowIdle(工作名)— 公会会长放置模拟")
        .inner_size(420.0, 860.0)
        .min_inner_size(360.0, 560.0)
        .build()
        {
            eprintln!("[wowidle] 全窗创建失败:{err}");
        }
    })
    .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // 小组件窗(GLOSSARY:小组件模式 = 贴屏幕角落的无边框置顶常驻小窗):
            // 尺寸界限与页内 shell/widget-geometry.ts 的 WIDGET_MIN/MAX 保持一致
            //(逻辑像素;此处只给建窗缺省,记忆位形由页内恢复)。
            WebviewWindowBuilder::new(app, "widget", WebviewUrl::App("widget.html".into()))
                .title("WowIdle 小组件")
                .inner_size(320.0, 200.0)
                .min_inner_size(220.0, 110.0)
                .max_inner_size(480.0, 520.0)
                .decorations(false)   // 无边框(拖拽靠页内顶栏 data-tauri-drag-region)
                .always_on_top(true)  // 置顶常驻
                .transparent(true)    // 卡片圆角之外不遮桌面
                .resizable(true)      // 原生边缘 + 页内右下抓柄双通道
                .skip_taskbar(true)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sim_owner, open_main_window])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    // 全窗的关闭 = 收回小组件形态:隐藏不退出,属主交还小组件
                    //(全窗页内运行时收到 wn:owner=0 后停表落盘)
                    "main" => {
                        api.prevent_close();
                        let _ = window.hide();
                        set_owner(window.app_handle(), 0);
                    }
                    // 小组件是常驻主窗:关掉它 = 退出整个应用
                    "widget" => {
                        window.app_handle().exit(0);
                    }
                    _ => {}
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("WowIdle 桌面壳启动失败");
}
