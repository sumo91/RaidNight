/**
 * 小组件窗口形态接线(T19,仅 Tauri 桌面壳内生效):
 * 记忆位形的恢复、顶栏拖拽后的贴角吸附、右下抓柄调大小、几何落盘。
 *
 * 窗口本体(无边框 / 置顶 / 透明 / 可调)由 Rust 侧创建;这里只做
 * 页内交互 → 窗口几何的读写。几何裁决是纯函数(shell/widget-geometry.ts),
 * 本模块负责 IO 与时序:
 *   · 拖拽:顶栏带 data-tauri-drag-region 由壳原生接管;松手检测用
 *     「静止探测」(位置连续数拍不变 ⇒ 拖拽结束)再吸附 —— 不依赖
 *     拖拽事件权限,行为最稳。
 *   · 调大小:右下抓柄指针拖拽 → setSize(物理像素 = 逻辑增量 × 缩放);
 *     参照作教训「缩放后仍可交互」:调的是窗口尺寸、内容随流式布局
 *     重排(不用 transform 缩放),任何尺寸下点击/hover/拖拽照常。
 *   · 记忆:localStorage 单键,吸附/调大小/卸载时落盘;恢复时钳回可见屏
 *     (外接屏拔掉后不悬空)。
 */

import {
  WIDGET_DEFAULT_SIZE,
  WIDGET_TOP_INSET_PX,
  clampSize,
  clampToScreen,
  parseWidgetGeometry,
  snapWindow,
  type Rect,
} from './widget-geometry';
import {
  currentTauriWindow,
  physicalPosition,
  physicalSize,
  type OuterSize,
  type TauriMonitor,
  type TauriWindow,
} from './tauri';

/** 小组件几何记忆键(物理像素;与游戏存档键分开)。 */
const GEOMETRY_KEY = 'wowidle.widget.geometry';

/** 缺省落位边距(右上角出发,避开菜单栏)。 */
const DEFAULT_MARGIN_PX = 16;
const DEFAULT_TOP_PX = 44;

/** 拖拽静止探测:每拍间隔与判定需要的连续静止拍数。 */
const DRAG_POLL_MS = 120;
const DRAG_STABLE_TICKS = 3;
const DRAG_TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取当前窗口几何(物理像素);不在壳内时返回 undefined。 */
async function readFrame(): Promise<Rect | undefined> {
  const win = currentTauriWindow();
  if (win === undefined) {
    return undefined;
  }
  const [position, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

function persistGeometry(frame: Rect): void {
  try {
    localStorage.setItem(GEOMETRY_KEY, JSON.stringify(frame));
  } catch {
    // 存不了就不记:下次回缺省位形,不影响游戏
  }
}

async function persistGeometryNow(): Promise<void> {
  const frame = await readFrame();
  if (frame !== undefined) {
    persistGeometry(frame);
  }
}

/** 吸附用的屏幕矩形:全屏区域 + 顶部内缩(避开 macOS 菜单栏的近似)。 */
function screenRectOf(monitor: TauriMonitor): Rect {
  return {
    x: monitor.position.x,
    y: monitor.position.y + WIDGET_TOP_INSET_PX,
    width: monitor.size.width,
    height: monitor.size.height - WIDGET_TOP_INSET_PX,
  };
}

/** 恢复记忆的位形(无记忆 ⇒ 缺省右上角);一律钳回可见屏。 */
async function restoreGeometry(): Promise<void> {
  const win = currentTauriWindow();
  if (win === undefined) {
    return;
  }
  const monitor = await win.currentMonitor();
  if (monitor === null) {
    return;
  }
  const screen = screenRectOf(monitor);
  const saved = parseWidgetGeometry(localStorage.getItem(GEOMETRY_KEY));
  if (saved !== null) {
    // 记忆是物理像素;尺寸界限按逻辑定义,经缩放换算后钳制
    const scale = monitor.scaleFactor || 1;
    const logical = clampSize(saved.width / scale, saved.height / scale);
    const frame = clampToScreen(
      { x: saved.x, y: saved.y, width: logical.width * scale, height: logical.height * scale },
      screen,
    );
    await win.setPosition(physicalPosition(Math.round(frame.x), Math.round(frame.y)) ?? {});
    await win.setSize(physicalSize(Math.round(frame.width), Math.round(frame.height)) ?? {});
    return;
  }
  // 缺省:右上角贴边落位(尺寸保持建窗缺省,只落位置;物理换算)
  const scale = monitor.scaleFactor || 1;
  const size = await win.outerSize();
  const fallbackWidth = Math.max(size.width, Math.round(WIDGET_DEFAULT_SIZE.width * scale));
  const x = monitor.position.x + monitor.size.width - fallbackWidth - DEFAULT_MARGIN_PX;
  const y = monitor.position.y + DEFAULT_TOP_PX;
  await win.setPosition(physicalPosition(x, y) ?? {});
}

/** 拖拽静止探测:位置变化过且已静止 ⇒ 贴角吸附 + 记忆。 */
async function trackDragAndSnap(): Promise<void> {
  const win: TauriWindow | undefined = currentTauriWindow();
  if (win === undefined) {
    return;
  }
  const start = await win.outerPosition();
  let prev = start;
  let moved = false;
  let stable = 0;
  const deadline = Date.now() + DRAG_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(DRAG_POLL_MS);
    const position = await win.outerPosition();
    if (position.x === prev.x && position.y === prev.y) {
      stable += 1;
      if (stable >= DRAG_STABLE_TICKS) {
        break; // 静止 ⇒ 拖拽结束(或本就只是点了一下顶栏)
      }
    } else {
      moved = true;
      stable = 0;
    }
    prev = position;
  }
  if (!moved) {
    return;
  }
  const size: OuterSize = await win.outerSize();
  const monitor = await win.currentMonitor();
  if (monitor === null) {
    persistGeometry({ x: prev.x, y: prev.y, width: size.width, height: size.height });
    return;
  }
  const snapped = snapWindow(
    { x: prev.x, y: prev.y, width: size.width, height: size.height },
    screenRectOf(monitor),
  );
  if (snapped.x !== prev.x || snapped.y !== prev.y) {
    await win.setPosition(physicalPosition(snapped.x, snapped.y) ?? {});
  }
  persistGeometry(snapped);
}

/** 右下抓柄:指针拖拽调窗口大小(逻辑增量 × 缩放 → 物理尺寸,区间钳制)。 */
function attachResizeGrip(grip: HTMLElement): void {
  grip.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const win = currentTauriWindow();
    if (win === undefined) {
      return;
    }
    void (async () => {
      const monitor = await win.currentMonitor();
      const scale = monitor?.scaleFactor ?? 1;
      const startSize = await win.outerSize();
      const startX = event.clientX;
      const startY = event.clientY;
      let lastApplied = 0;
      const onMove = (moveEvent: PointerEvent) => {
        // 轻节流:指针事件密,窗口几何写不必每拍都发
        const now = performance.now();
        if (now - lastApplied < 16) {
          return;
        }
        lastApplied = now;
        const next = clampSize(
          startSize.width / scale + (moveEvent.clientX - startX),
          startSize.height / scale + (moveEvent.clientY - startY),
        );
        void win.setSize(physicalSize(next.width * scale, next.height * scale) ?? {});
      };
      const onUp = () => {
        grip.removeEventListener('pointermove', onMove);
        try {
          grip.releasePointerCapture(event.pointerId);
        } catch {
          // 指针已离开:无捕获可释
        }
        void persistGeometryNow();
      };
      try {
        grip.setPointerCapture(event.pointerId);
      } catch {
        // 捕获失败也能拖,只是移出抓柄后不再跟随
      }
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp, { once: true });
      grip.addEventListener('pointercancel', onUp, { once: true });
    })();
  });
}

/**
 * 接线入口(小组件页装配时调用一次;非 Tauri 环境下为无操作)。
 * 顶栏(.widget-bar)须带 data-tauri-drag-region(原生拖拽),这里旁听
 * pointerdown 触发静止探测与吸附;右下抓柄(.widget-resize-grip)调大小。
 */
export function initWidgetWindowControls(): void {
  const win = currentTauriWindow();
  if (win === undefined) {
    return;
  }
  void restoreGeometry();
  const bar = document.querySelector<HTMLElement>('.widget-bar');
  bar?.addEventListener('pointerdown', () => void trackDragAndSnap());
  const grip = document.querySelector<HTMLElement>('.widget-resize-grip');
  if (grip !== null) {
    attachResizeGrip(grip);
  }
  window.addEventListener('beforeunload', () => void persistGeometryNow());
}
