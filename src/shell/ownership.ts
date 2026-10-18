/**
 * 模拟属主仲裁的页内侧(T19):决定「本页的运行时此刻该不该走」。
 *
 * 裁决真值在桌面壳(Rust 侧 SIM_OWNER,窗口可见性即属主),经
 * sim_owner 命令(冷加载补问)与 wn:owner 事件(切换广播)到达页面;
 * 全窗可见 ⇒ 全窗独占推进,否则小组件常驻推进 —— 两窗共用同一份
 * localStorage 存档,交还时停表落盘、接管时按时间戳补结算(幂等,
 * ADR-0003),绝不双推进。
 *
 * 浏览器(无 Tauri)回退:全窗入口永远运行(PWA 行为不变,与抽取前
 * 的 src/main.ts 一致);小组件页按标签页可见性起停 —— 浏览器只是
 * 开发观感,两标签同开时的推进竞态不作保证(真实形态走桌面壳)。
 */

import type { SimOwner } from './tauri';
import { listenSimOwner, querySimOwner, tauriAvailable } from './tauri';
import type { OfflineResult, SimRuntime } from './runtime';

export interface OwnershipHooks {
  /** 获得属主:start() 的补结算结果交给入口渲染(新会为空)。 */
  onGained(result: OfflineResult): void;
  /** 失去属主:运行时已停表落盘;入口可标记「已交还」的展示态。 */
  onLost(): void;
}

/**
 * 把一个运行时挂到属主仲裁上(幂等):属主切到本角色 ⇒ start,
 * 切走 ⇒ stop。返回撤销函数(测试/热替换用,入口常驻可不调)。
 */
export function runUnderOwnership(
  role: SimOwner,
  runtime: SimRuntime,
  hooks: OwnershipHooks,
): () => void {
  let current: SimOwner | undefined;

  const apply = (owner: SimOwner): void => {
    if (owner === current) {
      return;
    }
    current = owner;
    if (owner === role) {
      hooks.onGained(runtime.start());
    } else {
      runtime.stop();
      hooks.onLost();
    }
  };

  if (!tauriAvailable()) {
    if (role === 'main') {
      apply('main'); // 浏览器/PWA:全窗永远运行(与抽取前的 main.ts 行为一致)
      return () => undefined;
    }
    // 浏览器开发观感:小组件页可见时运行,切走即停(浏览器节流定时器的配合)
    const sync = () => apply(document.hidden ? 'main' : 'widget');
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => document.removeEventListener('visibilitychange', sync);
  }

  // 桌面壳:先回灌桌面存档文件(T21,起表前完成 —— 文件是权威副本,
  // 裁决见 shell/save-sync),再补问一次属主(事件可能早于本脚本就绪
  // 发出),最后常听广播;串行化保证 start() 一定读得到回灌后的存档。
  let unlisten: (() => void) | undefined;
  void (async () => {
    await runtime.hydrateFromDisk();
    const owner = await querySimOwner();
    if (owner !== undefined) {
      apply(owner);
    }
    unlisten = await listenSimOwner(apply);
  })();
  return () => unlisten?.();
}
