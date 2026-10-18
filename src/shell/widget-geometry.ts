/**
 * 小组件窗口几何(纯函数,T19):贴角吸附、收纳回屏、尺寸钳制、几何记忆解析。
 *
 * 这里只有数学,不接触 Tauri / DOM —— 坐标一律物理像素、原点左上
 * (Tauri 对外统一为左上原点,内部已吸收 macOS 的左下原点差异)。
 * 真正的窗口读写(setPosition/setSize/外位姿读取)在 shell/widget-window.ts,
 * 由它调这里的纯函数做裁决。
 */

/** 矩形(物理像素)。 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 贴角吸附阈值:窗口边距屏幕边 ≤ 该值即吸齐(像素)。 */
export const WIDGET_SNAP_DISTANCE_PX = 24;

/** macOS 顶部内缩:菜单栏高度近似值 —— 吸附顶边时避开菜单栏。 */
export const WIDGET_TOP_INSET_PX = 28;

/** 窗口尺寸界限(逻辑像素;物理值由调用方按 scaleFactor 换算后同样钳制)。 */
export const WIDGET_MIN_SIZE = { width: 220, height: 110 } as const;
export const WIDGET_MAX_SIZE = { width: 480, height: 520 } as const;

/** 缺省尺寸(逻辑像素;Rust 建窗值与此保持一致)。 */
export const WIDGET_DEFAULT_SIZE = { width: 320, height: 200 } as const;

/**
 * 贴角吸附:窗口任一边距屏幕对应边 ≤ 阈值 ⇒ 吸齐该边;角 = 两边同时吸。
 * 不满足阈值的位置原样返回(纯函数,不做任何 IO)。
 */
export function snapWindow(
  frame: Rect,
  screen: Rect,
  threshold: number = WIDGET_SNAP_DISTANCE_PX,
): Rect {
  let dx = 0;
  if (frame.x - screen.x <= threshold) {
    dx = screen.x - frame.x; // 吸左
  } else if (screen.x + screen.width - (frame.x + frame.width) <= threshold) {
    dx = screen.x + screen.width - (frame.x + frame.width); // 吸右
  }
  let dy = 0;
  if (frame.y - screen.y <= threshold) {
    dy = screen.y - frame.y; // 吸上
  } else if (screen.y + screen.height - (frame.y + frame.height) <= threshold) {
    dy = screen.y + screen.height - (frame.y + frame.height); // 吸下
  }
  return dx === 0 && dy === 0 ? frame : { ...frame, x: frame.x + dx, y: frame.y + dy };
}

/**
 * 收纳回屏:记忆的位置可能在拔掉外接屏后漂出可见区 —— 把窗口拉回,
 * 至少保留 keep 像素可见(横竖两轴各自独立钳制)。
 */
export function clampToScreen(frame: Rect, screen: Rect, keep = 72): Rect {
  const x = Math.min(
    Math.max(frame.x, screen.x + keep - frame.width),
    screen.x + screen.width - keep,
  );
  const y = Math.min(
    Math.max(frame.y, screen.y + keep - frame.height),
    screen.y + screen.height - keep,
  );
  return x === frame.x && y === frame.y ? frame : { ...frame, x, y };
}

/** 尺寸钳制:[min, max] 区间内取整钳制。 */
export function clampSize(
  width: number,
  height: number,
  min: { readonly width: number; readonly height: number } = WIDGET_MIN_SIZE,
  max: { readonly width: number; readonly height: number } = WIDGET_MAX_SIZE,
): { width: number; height: number } {
  return {
    width: Math.max(min.width, Math.min(max.width, Math.round(width))),
    height: Math.max(min.height, Math.min(max.height, Math.round(height))),
  };
}

/**
 * 解析记忆的几何(localStorage 值):结构完好且数值有限才收,
 * 损坏/缺字段/非有限数一律 null(调用方回退缺省位形)。不做屏内钳制
 * —— 那需要屏幕尺寸,由恢复时的调用方完成。
 */
export function parseWidgetGeometry(raw: string | null): Rect | null {
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  const nums = [value.x, value.y, value.width, value.height];
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    return null;
  }
  return { x: value.x as number, y: value.y as number, width: value.width as number, height: value.height as number };
}
