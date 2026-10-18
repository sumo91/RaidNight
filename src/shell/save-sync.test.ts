import { describe, expect, it } from 'vitest';
import { SimulationFacade } from '../sim/facade';
import { encodeSave } from '../sim/save';
import { pickRestoreSource } from './save-sync';

/**
 * T21 壳层纯函数测试:存档双介质恢复源裁决(localStorage 热副本 vs
 * 桌面文件权威副本,ADR-0003)。
 *
 * 说明:游戏逻辑一律只测门面接缝(AGENTS.md);本文件测的是装配层的
 * 纯决策模块(不碰 DOM、不碰 Tauri),与 widget-geometry.test.ts 同类。
 * 存档样本经门面真实产生(建会 + 推进),保证封皮与结构防御都过真链路。
 */

function facadeState(): string {
  const facade = new SimulationFacade(20261018);
  facade.dispatch({ deltaGameMinutes: 60 });
  return encodeSave(facade.state);
}

describe('T21 存档恢复源裁决', () => {
  it('文件缺失或损坏 ⇒ 不恢复(localStorage / 新档照旧)', () => {
    expect(pickRestoreSource('任意本机档', null)).toBeNull();
    expect(pickRestoreSource('任意本机档', '不是 JSON')).toBeNull();
  });

  it('本机档缺失或损坏 ⇒ 文件档救回(原样文本返回)', () => {
    const disk = facadeState();
    expect(pickRestoreSource(null, disk)).toBe(disk);
    expect(pickRestoreSource('本机损坏档', disk)).toBe(disk);
  });

  it('两份都完好 ⇒ 取 savedAtMs 新者;文件更旧或同刻 ⇒ 不恢复', () => {
    const state = facadeState();
    const newerDisk = JSON.stringify({ ...JSON.parse(state), savedAtMs: 2000 });
    const olderLocal = JSON.stringify({ ...JSON.parse(state), savedAtMs: 1000 });
    expect(pickRestoreSource(olderLocal, newerDisk)).toBe(newerDisk);

    const sameDisk = JSON.stringify({ ...JSON.parse(state), savedAtMs: 1000 });
    expect(pickRestoreSource(olderLocal, sameDisk)).toBeNull();

    const olderDisk = JSON.stringify({ ...JSON.parse(state), savedAtMs: 500 });
    expect(pickRestoreSource(olderLocal, olderDisk)).toBeNull();
  });

  it('缺省 savedAtMs(0)的旧档视为最旧:带时间基准的一方胜出', () => {
    const state = facadeState();
    const localOld = JSON.stringify({ ...JSON.parse(state), savedAtMs: 0 });
    const diskStamped = JSON.stringify({ ...JSON.parse(state), savedAtMs: 1 });
    expect(pickRestoreSource(localOld, diskStamped)).toBe(diskStamped);
  });

  it('双份都无时间基准 ⇒ 不恢复(避免启动期无据翻转)', () => {
    const state = facadeState();
    const plain = JSON.stringify({ ...JSON.parse(state), savedAtMs: 0 });
    expect(pickRestoreSource(plain, plain)).toBeNull();
  });
});

describe('T21 评审修复:清档屏障', () => {
  it('文件档早于清档时刻 ⇒ 不复活(删除未落地/失败时的残留)', () => {
    const state = facadeState();
    const staleDisk = JSON.stringify({ ...JSON.parse(state), savedAtMs: 4000 });
    // 本机档已清(local null)、文件档还是清档前的 —— 正是评审指出的竞态现场
    expect(pickRestoreSource(null, staleDisk, 5000)).toBeNull();
    expect(pickRestoreSource('本机损坏档', staleDisk, 5000)).toBeNull();
  });

  it('文件档晚于清档时刻 ⇒ 正常恢复(清档后落盘的合法进度)', () => {
    const state = facadeState();
    const freshDisk = JSON.stringify({ ...JSON.parse(state), savedAtMs: 6000 });
    expect(pickRestoreSource(null, freshDisk, 5000)).toBe(freshDisk);
  });

  it('无时间基准(savedAtMs=0)的文件档在设屏障时视为残留 ⇒ 不复活', () => {
    const state = facadeState();
    const undated = JSON.stringify({ ...JSON.parse(state), savedAtMs: 0 });
    expect(pickRestoreSource(null, undated, 5000)).toBeNull();
  });

  it('从未清档(缺省 0)⇒ 不设屏障,既有语义不变', () => {
    const state = facadeState();
    expect(pickRestoreSource(null, state)).toBe(state);
    expect(pickRestoreSource(null, state, 0)).toBe(state);
  });
});
