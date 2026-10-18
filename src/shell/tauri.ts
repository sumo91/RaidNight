/**
 * Tauri 桌面壳桥(T19,ADR-0001):零 npm 依赖的类型化封装。
 *
 * Tauri 以 withGlobalTauri 注入 window.__TAURI__(见 src-tauri/tauri.conf.json),
 * 本模块只声明我们用到的那一小块形状并做安全访问 —— 浏览器(开发服务器 /
 * PWA)下 window.__TAURI__ 不存在,tauriAvailable() 为 false,所有能力
 * 优雅缺省,页面照常作为纯 Web 应用运行。
 *
 * 桌面壳的窗口与属主裁决在 Rust 侧(src-tauri/src/main.rs);这里只有
 * 「调命令 / 听事件 / 调窗口几何」三件事。
 */

/** 事件反注册函数。 */
export type UnlistenFn = () => void;

/** Tauri 注入全局的最小子集(只声明用到的成员)。 */
interface TauriGlobal {
  readonly core: {
    invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  };
  readonly event: {
    listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn>;
  };
  readonly window: {
    getCurrentWindow(): TauriWindow;
  };
  readonly dpi: {
    PhysicalPosition: new (x: number, y: number) => object;
    PhysicalSize: new (width: number, height: number) => object;
  };
}

/** 窗口外位姿(物理像素,左上原点)。 */
export interface OuterPosition {
  readonly x: number;
  readonly y: number;
}

/** 窗口外尺寸(物理像素)。 */
export interface OuterSize {
  readonly width: number;
  readonly height: number;
}

/** 显示器(物理像素;position/size 为全屏区域,不含工作区信息)。 */
export interface TauriMonitor {
  readonly position: OuterPosition;
  readonly size: OuterSize;
  readonly scaleFactor: number;
}

/** 本页所属 Tauri 窗口(几何读写子集;权限见 src-tauri/capabilities/default.json)。 */
export interface TauriWindow {
  readonly label: string;
  outerPosition(): Promise<OuterPosition>;
  outerSize(): Promise<OuterSize>;
  setPosition(position: object): Promise<void>;
  setSize(size: object): Promise<void>;
  currentMonitor(): Promise<TauriMonitor | null>;
}

/** 是否运行在 Tauri 桌面壳内。 */
export function tauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

function getTauri(): TauriGlobal | undefined {
  if (!tauriAvailable()) {
    return undefined;
  }
  return (window as unknown as { __TAURI__: TauriGlobal }).__TAURI__;
}

/** 当前页所属窗口(仅 Tauri 下有值)。 */
export function currentTauriWindow(): TauriWindow | undefined {
  return getTauri()?.window.getCurrentWindow();
}

/** 物理坐标/尺寸构造器(传给 setPosition/setSize 的载荷必须是其实例)。 */
export function physicalPosition(x: number, y: number): object | undefined {
  const dpi = getTauri()?.dpi;
  return dpi === undefined ? undefined : new dpi.PhysicalPosition(x, y);
}

export function physicalSize(width: number, height: number): object | undefined {
  const dpi = getTauri()?.dpi;
  return dpi === undefined ? undefined : new dpi.PhysicalSize(width, height);
}

/** 模拟属主(桌面壳裁决,见 Rust 侧 SIM_OWNER):0 = 小组件窗,1 = 全窗。 */
export type SimOwner = 'widget' | 'main';

function parseOwner(payload: number): SimOwner {
  return payload === 1 ? 'main' : 'widget';
}

/** 冷加载补问当前属主(事件可能早于页面脚本就绪发出,补问兜底)。 */
export async function querySimOwner(): Promise<SimOwner | undefined> {
  const tauri = getTauri();
  if (tauri === undefined) {
    return undefined;
  }
  try {
    return parseOwner(await tauri.core.invoke<number>('sim_owner'));
  } catch {
    return undefined;
  }
}

/** 监听属主切换广播(wn:owner;载荷 0 = 小组件,1 = 全窗)。 */
export async function listenSimOwner(
  handler: (owner: SimOwner) => void,
): Promise<UnlistenFn | undefined> {
  const tauri = getTauri();
  if (tauri === undefined) {
    return undefined;
  }
  try {
    return await tauri.event.listen<number>('wn:owner', (event) => handler(parseOwner(event.payload)));
  } catch {
    return undefined;
  }
}

/** 打开全窗(小组件的「点击进入全窗」;Rust 侧切属主 + 显示/建窗 + 聚焦)。 */
export async function openMainWindow(): Promise<void> {
  const tauri = getTauri();
  if (tauri === undefined) {
    return;
  }
  try {
    await tauri.core.invoke('open_main_window');
  } catch {
    // 打不开(壳异常)时静默:小组件照常显示,不打扰玩家
  }
}
