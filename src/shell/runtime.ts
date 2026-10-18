/**
 * 装配层共享运行时(T19):门面所有权 + 持久化 + 现实时钟换算 + 离线补结算。
 *
 * 从 src/main.ts 抽出的装配逻辑,全窗(src/main.ts)与小组件窗
 * (src/widget-main.ts)共用 —— 现实时间只存在于装配层(ADR-0004),
 * 两处入口都经本模块把现实时间增量换算为游戏时间增量,门面本身不接受现实时间。
 *
 * Tauri 桌面壳里两个窗口(小组件常驻 + 全窗)同时存活,但模拟运行时
 * 同一时刻只允许一个在走(属主裁决见 shell/ownership.ts):start() 载入
 * 本机最新存档并按落盘时间戳做离线补结算(ADR-0003:基于时间戳推进、
 * 幂等),stop() 停表落盘 —— 交还/接管不丢进度、不双推进。
 */

import { GAME_MINUTES_PER_REAL_MS, GAME_MINUTES_PER_WEEK, realMsToGameMinutes } from '../sim/clock';
import { SimulationFacade, decodeSaveEnvelope, encodeSave, type StepOutput } from '../sim/facade';
import type { SimEvent } from '../sim/events';
import type { SimInput } from '../sim/facade';
import type { GameState } from '../sim/state';
// 类型单向引用(编译期擦除,无运行时耦合):装配层产出视图数据,UI 只渲染
import type { OfflineHarvestView } from '../ui/app';
import { formatGameDuration, formatGameStamp, formatRealDuration } from '../ui/format';

/** 开发期固定种子(无存档时用于建会);与全窗/小组件两入口共享同一常量。 */
export const DEV_SEED = 20261018;

/** 本机自动存档的存储键(格式与版本见 sim/save.ts)。 */
const SAVE_KEY = 'wowidle.save';

/**
 * 离线补结算的分段上限:1 游戏周(= 1 现实天)一段。
 * 单段开销有界;分段不改结果 —— 门面对同一起止时间的任意切分严格等价
 * (sim/offline.test.ts:分段与整跳等价)。
 */
const OFFLINE_SEGMENT_GAME_MINUTES = GAME_MINUTES_PER_WEEK;

/** 离线补结算结果:补记事件 + 「离线归来」摘要(未跨日界时摘要为 null)。 */
export interface OfflineResult {
  readonly events: readonly SimEvent[];
  readonly harvest: OfflineHarvestView | null;
}

export interface SimRuntimeCallbacks {
  /** 时钟滴答推进后的输出(状态 + 本步事件);UI 指令路径不经此回调。 */
  onOutput(state: GameState, events: readonly SimEvent[]): void;
}

export interface SimRuntimeOptions {
  /** 本局种子(无存档时建会用)。 */
  readonly seed: number;
  /** 现实时钟采样间隔(毫秒);只影响 UI 帧率,不影响游戏节奏。 */
  readonly tickIntervalMs: number;
}

/** 读取本机存档:缺失、损坏或版本无法迁移一律返回 null(回退新档)。 */
function loadSave(): { state: GameState; savedAtMs: number } | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw === null ? null : decodeSaveEnvelope(raw);
  } catch {
    return null;
  }
}

/**
 * 模拟运行时:封装门面实例 + 自动存档 + 现实时钟滴答。
 * start/stop 幂等 —— 供属主切换反复调用;每次 start 都从本机存档重建
 * (上一次 stop 已落盘,故等价且避免长驻内存态与存档漂移)。
 */
export class SimRuntime {
  private facade: SimulationFacade;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastRealMs = 0;
  private carryMs = 0;
  private running = false;
  private readonly callbacks: SimRuntimeCallbacks;
  private readonly options: SimRuntimeOptions;

  constructor(options: SimRuntimeOptions, callbacks: SimRuntimeCallbacks) {
    this.options = options;
    this.callbacks = callbacks;
    this.facade = new SimulationFacade(options.seed);
  }

  get state(): GameState {
    return this.facade.state;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * 起表:载入本机最新存档(缺失则建新会)、按落盘时间戳补离线结算、
   * 启动滴答。返回补结算结果供入口渲染(新会为空事件 + null 摘要)。
   */
  start(): OfflineResult {
    if (this.running) {
      return { events: [], harvest: null };
    }
    const saved = loadSave();
    this.facade = new SimulationFacade(this.options.seed, undefined, saved?.state);
    const catchUp =
      saved !== null && saved.savedAtMs > 0
        ? this.settleOffline(Date.now() - saved.savedAtMs)
        : { events: [] as SimEvent[], harvest: null as OfflineHarvestView | null };
    this.persistNow();
    this.running = true;
    this.lastRealMs = performance.now();
    this.carryMs = 0;
    this.timer = setInterval(() => this.tick(), this.options.tickIntervalMs);
    return catchUp;
  }

  /** 停表:停滴答并落盘(封皮带落盘时刻,下次 start 的补结算起测点)。 */
  stop(): void {
    if (!this.running) {
      return;
    }
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.persistNow();
    this.running = false;
  }

  /** 会长指令(装配层转发给门面):结算 + 落盘;渲染由入口用返回值完成。 */
  dispatch(input: SimInput): StepOutput {
    const output = this.facade.dispatch(input);
    this.persistNow();
    return output;
  }

  /** 模拟离线(调试条):走与真实离线完全相同的补结算路径。 */
  simulateOffline(realMs: number): OfflineResult {
    const result = this.settleOffline(realMs);
    this.persistNow();
    return result;
  }

  /**
   * 导入存档文本:解码 + 迁移 + 结构校验都在 sim,失败返回 null;
   * 成功则恢复状态、按封皮时间戳补离线并立即落盘(导入即成本机最新进度)。
   */
  importSave(text: string): OfflineResult | null {
    const decoded = decodeSaveEnvelope(text);
    if (decoded === null) {
      return null;
    }
    this.facade.restore(decoded.state);
    const catchUp = this.settleOffline(decoded.savedAtMs > 0 ? Date.now() - decoded.savedAtMs : 0);
    this.persistNow();
    return catchUp;
  }

  /** 导出存档文本(封皮带导出时刻;文件名与下载由入口负责)。 */
  exportSave(): string {
    return encodeSave(this.facade.state, Date.now());
  }

  /** 清空本机存档(入口随后自行重开页面)。 */
  wipeStorage(): void {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      // 清不掉也无妨:重载后会被覆盖写
    }
  }

  /** 现实时间 → 游戏时间增量:增量取整并保留余数进位,保证确定性不受浮点影响。 */
  private tick(): void {
    const now = performance.now();
    this.carryMs += now - this.lastRealMs;
    this.lastRealMs = now;
    const delta = Math.floor(realMsToGameMinutes(this.carryMs));
    if (delta <= 0) {
      return;
    }
    this.carryMs -= delta / GAME_MINUTES_PER_REAL_MS;
    const output = this.facade.dispatch({ deltaGameMinutes: delta });
    this.persistNow();
    this.callbacks.onOutput(output.state, output.events);
  }

  /** 写入本机存档(封皮带落盘时刻,离线结算的起测点);存储不可用时静默降级为本局内存态。 */
  private persistNow(): void {
    try {
      localStorage.setItem(SAVE_KEY, encodeSave(this.facade.state, Date.now()));
    } catch {
      // 本局照常运行,只是不落盘
    }
  }

  /**
   * 离线补结算:把一段离线现实时长换算为游戏分钟,分段派发并收割全部结果。
   * 入参是「离线了多久」(时长);摘要统计在装配层完成,UI 只渲染。
   */
  private settleOffline(elapsedRealMs: number): OfflineResult {
    if (elapsedRealMs <= 0) {
      return { events: [], harvest: null }; // 没有离线时长:不做补结算
    }
    const fromClock = this.facade.state.clockGameMinutes;
    const totalGameMinutes = Math.floor(realMsToGameMinutes(elapsedRealMs));

    // 分段派发:每段 ≤ 1 游戏周,段内由门面逐日结算;事件按发生顺序累计
    const events: SimEvent[] = [];
    let remaining = totalGameMinutes;
    while (remaining > 0) {
      const segment = Math.min(remaining, OFFLINE_SEGMENT_GAME_MINUTES);
      events.push(...this.facade.dispatch({ deltaGameMinutes: segment }).events);
      remaining -= segment;
    }
    if (events.length === 0) {
      return { events, harvest: null }; // 离线不足一个日界:时钟已推进,但没有可呈现的结果
    }

    const wins = events.filter((e) => e.kind === '下本' && e.text.includes('速通')).length;
    const losses = events.filter((e) => e.kind === '下本' && e.text.includes('败退')).length;
    const equipped = events.filter((e) => e.kind === '下本' && e.text.includes('换上')).length;
    const raidKills = events.filter((e) => e.kind === '团本' && e.text.includes('被击杀')).length;
    const raidWipes = events.filter((e) => e.kind === '团本' && e.text.includes('团灭于')).length;
    const raidClears = events.filter((e) => e.kind === '团本' && e.text.includes('全通')).length;
    const highlights: string[] = [];
    if (wins + losses > 0) {
      highlights.push(`下本速通 ${wins} 次、败退 ${losses} 次。`);
    }
    if (equipped > 0) {
      highlights.push(`缴获并换上 ${equipped} 件装备。`);
    }
    if (raidClears > 0) {
      highlights.push(`团本夜全通 ${raidClears} 次。`);
    }
    if (raidKills + raidWipes > 0) {
      highlights.push(`团本击杀首领 ${raidKills} 名${raidWipes > 0 ? `、团灭 ${raidWipes} 次` : ''}。`);
    }
    const harvest: OfflineHarvestView = {
      awayText: formatRealDuration(elapsedRealMs),
      advancedText: formatGameDuration(totalGameMinutes),
      fromStamp: formatGameStamp(fromClock),
      toStamp: formatGameStamp(this.facade.state.clockGameMinutes),
      eventCount: events.length,
      highlights,
    };
    return { events, harvest };
  }
}
