import { describe, expect, it } from 'vitest';
import {
  WIDGET_MAX_SIZE,
  WIDGET_MIN_SIZE,
  clampSize,
  clampToScreen,
  parseWidgetGeometry,
  snapWindow,
} from './widget-geometry';

/**
 * T19 壳层纯函数测试:小组件窗口几何(贴角吸附 / 收纳回屏 / 尺寸钳制 / 记忆解析)。
 *
 * 说明:游戏逻辑一律只测门面接缝(AGENTS.md);本文件测的是桌面壳的
 * 纯数学模块(不碰 DOM、不碰 Tauri),与 src/art/pipeline.test.ts 同类
 * —— 非游戏规则的纯函数直测。
 */

const SCREEN = { x: 0, y: 0, width: 1440, height: 900 };

describe('T19 贴角吸附', () => {
  it('近左边缘 ⇒ 吸齐左边;近上边缘 ⇒ 同时吸齐顶边(角)', () => {
    const snapped = snapWindow({ x: 10, y: 12, width: 300, height: 200 }, SCREEN);
    expect(snapped).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });

  it('近右下角 ⇒ 两边同时吸齐', () => {
    const snapped = snapWindow({ x: 1440 - 300 - 18, y: 900 - 200 - 6, width: 300, height: 200 }, SCREEN);
    expect(snapped).toEqual({ x: 1140, y: 700, width: 300, height: 200 });
  });

  it('只近一边 ⇒ 只吸一边', () => {
    const snapped = snapWindow({ x: 500, y: 900 - 200 - 10, width: 300, height: 200 }, SCREEN);
    expect(snapped).toEqual({ x: 500, y: 700, width: 300, height: 200 });
  });

  it('都不在阈值内 ⇒ 原位不动(同一对象语义的等值返回)', () => {
    const frame = { x: 400, y: 300, width: 300, height: 200 };
    expect(snapWindow(frame, SCREEN)).toEqual(frame);
  });

  it('副屏坐标(原点非 0)按各自屏幕边吸附', () => {
    const second = { x: 1440, y: 0, width: 1920, height: 1080 };
    const snapped = snapWindow({ x: 1440 + 1920 - 300 - 20, y: 500, width: 300, height: 200 }, second);
    expect(snapped).toEqual({ x: 3060, y: 500, width: 300, height: 200 });
  });
});

describe('T19 收纳回屏(拔掉外接屏后)', () => {
  it('完全漂出屏外 ⇒ 拉回,屏上可见部分 ≥ keep 像素(横竖两轴)', () => {
    const clamped = clampToScreen({ x: 5000, y: -3000, width: 300, height: 200 }, SCREEN, 72);
    const visibleX =
      Math.min(clamped.x + clamped.width, SCREEN.x + SCREEN.width) - Math.max(clamped.x, SCREEN.x);
    const visibleY =
      Math.min(clamped.y + clamped.height, SCREEN.y + SCREEN.height) - Math.max(clamped.y, SCREEN.y);
    expect(visibleX).toBeGreaterThanOrEqual(72);
    expect(visibleY).toBeGreaterThanOrEqual(72);
  });

  it('屏内原位 ⇒ 不动', () => {
    const frame = { x: 100, y: 100, width: 300, height: 200 };
    expect(clampToScreen(frame, SCREEN)).toEqual(frame);
  });
});

describe('T19 尺寸钳制与几何记忆', () => {
  it('超界钳回、取整、屏内原样', () => {
    expect(clampSize(100, 50)).toEqual({ width: WIDGET_MIN_SIZE.width, height: WIDGET_MIN_SIZE.height });
    expect(clampSize(9999, 9999)).toEqual({ width: WIDGET_MAX_SIZE.width, height: WIDGET_MAX_SIZE.height });
    expect(clampSize(320.6, 200.2)).toEqual({ width: 321, height: 200 });
  });

  it('记忆解析:合法 JSON 收、损坏/缺字段/非有限数一律回 null', () => {
    expect(parseWidgetGeometry(JSON.stringify({ x: 12, y: 34, width: 300, height: 200 }))).toEqual({
      x: 12,
      y: 34,
      width: 300,
      height: 200,
    });
    expect(parseWidgetGeometry(null)).toBeNull();
    expect(parseWidgetGeometry('')).toBeNull();
    expect(parseWidgetGeometry('{oops')).toBeNull();
    expect(parseWidgetGeometry('[]')).toBeNull();
    expect(parseWidgetGeometry('{"x":12}')).toBeNull();
    expect(
      parseWidgetGeometry(JSON.stringify({ x: Number.NaN, y: 0, width: 300, height: 200 })),
    ).toBeNull();
  });
});
