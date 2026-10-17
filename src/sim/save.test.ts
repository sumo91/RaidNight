import { describe, expect, it } from 'vitest';
import { LEVELING_MAPS } from '../content/maps';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK, gameWeek } from './clock';
import {
  SAVE_KIND,
  SAVE_VERSION,
  SimulationFacade,
  decodeSave,
  encodeSave,
  type SimInput,
} from './facade';
import type { SimEvent } from './events';
import type { GameState } from './state';

/**
 * T7 门面测试:本地存档 —— 版本化 + 导出/导入 + 离线结算幂等。
 * 与全项目一致只打门面接缝:驱动 SimulationFacade / 纯函数断言状态快照与事件日志;
 * encodeSave / decodeSave 为 sim 纯函数,按 T2–T6 先例直接断言。
 * 存档文本即导出文件内容(localStorage 值与文件共用同一编码)。
 */

const SEED = 20261018;

/** 建会后的一段指令脚本:覆盖改名、招募、淘汰、编队、练级安排与跨日结算。 */
function playOpeningScript(facade: SimulationFacade): SimEvent[] {
  const events: SimEvent[] = [];
  const push = (input: SimInput) => events.push(...facade.dispatch(input).events);

  push({ command: { type: 'renameGuild', name: '星盾远征军' }, deltaGameMinutes: 0 });
  push({ command: { type: 'createSquad' }, deltaGameMinutes: 0 });
  push({ command: { type: 'createSquad' }, deltaGameMinutes: 0 });
  // 招入初始申请池的第一份申请(id 在运行期读取,种子固定 ⇒ 脚本确定)
  const firstApplicationId = facade.state.applicants[0]?.applicationId;
  if (firstApplicationId !== undefined) {
    push({ command: { type: 'recruitApplicant', applicationId: firstApplicationId }, deltaGameMinutes: 0 });
  }
  // 前 5 名团员编入第 1 小队(成员 id 1 起运行期读取),并进驻首张练级地图
  for (const member of facade.state.members.slice(0, 5)) {
    push({
      command: { type: 'assignToSquad', memberId: member.id, squadId: facade.state.squads[0]!.id },
      deltaGameMinutes: 0,
    });
  }
  push({
    command: { type: 'assignLevelingMap', squadId: facade.state.squads[0]!.id, mapId: LEVELING_MAPS[0]!.id },
    deltaGameMinutes: 0,
  });
  // 淘汰第 2 号位团员(人走队清),再跨日推进让自动层结算生效
  push({ command: { type: 'dismissMember', memberId: 2 }, deltaGameMinutes: 0 });
  push({ deltaGameMinutes: GAME_MINUTES_PER_DAY * 2 + 137 });
  return events;
}

/** 到达「有进度的快照」:编成、练级、跨日结算都已发生的状态。 */
function snapshotState(): { state: GameState; openingEvents: SimEvent[] } {
  const facade = new SimulationFacade(SEED, '星盾公会');
  const openingEvents = playOpeningScript(facade);
  return { state: structuredClone(facade.state), openingEvents };
}

/** 追加脚本:导入恢复后继续玩的内容(改名 + 招募 + 跨周边界大跳变)。 */
function playContinuation(facade: SimulationFacade): SimEvent[] {
  const events: SimEvent[] = [];
  const push = (input: SimInput) => events.push(...facade.dispatch(input).events);
  push({ command: { type: 'renameGuild', name: '暮光酒馆' }, deltaGameMinutes: 0 });
  const applicantId = facade.state.applicants[0]?.applicationId;
  if (applicantId !== undefined) {
    push({ command: { type: 'recruitApplicant', applicationId: applicantId }, deltaGameMinutes: 0 });
  }
  push({ deltaGameMinutes: GAME_MINUTES_PER_WEEK * 2 + GAME_MINUTES_PER_DAY * 3 + 59 });
  return events;
}

describe('存档 round-trip(验收标准 2 与 5)', () => {
  it('编码 → 解码恢复的状态与原状态完全一致(逐字节)', () => {
    const { state } = snapshotState();
    const text = encodeSave(state);
    const restored = decodeSave(text);

    expect(restored).not.toBeNull();
    expect(restored).toEqual(state);
    // 序列化逐字节一致:导出文件再导入不改变任何字段
    expect(JSON.stringify(restored)).toBe(JSON.stringify(state));
  });

  it('封皮带版本号与种类标记(验收标准 3 的格式面)', () => {
    const { state } = snapshotState();
    const file = JSON.parse(encodeSave(state)) as { kind: string; version: number };
    expect(file.kind).toBe(SAVE_KIND);
    expect(file.version).toBe(SAVE_VERSION);
    expect(SAVE_VERSION).toBeGreaterThanOrEqual(4);
  });

  it('恢复后的进度继续推进,与原线产生相同状态与日志(另一实例导入恢复)', () => {
    const { state } = snapshotState();
    // 原线:直接继续玩
    const original = new SimulationFacade(SEED, undefined, structuredClone(state));
    const originalEvents = playContinuation(original);
    // 导入线:编码成文本 → 另一门面解码恢复 → 玩同样内容
    const imported = new SimulationFacade(0, undefined, decodeSave(encodeSave(state))!);
    const importedEvents = playContinuation(imported);

    expect(JSON.stringify(imported.state)).toBe(JSON.stringify(original.state));
    expect(importedEvents).toEqual(originalEvents);
    expect(gameWeek(imported.state.clockGameMinutes)).toBeGreaterThan(1); // 确实推进了
  });
});

describe('版本迁移:旧版本存档可读(验收标准 3)', () => {
  it('v1 旧档(T4 及以前,团员无经验维度)迁移后可读、可继续推进', () => {
    const { state } = snapshotState();
    // 剥掉经验字段,还原 v1 时代的真实存档形状(JSON replacer 返回 undefined 即删键)
    const legacyState = JSON.parse(
      JSON.stringify(state, (key, value) => (key === 'experience' ? undefined : value)),
    );
    const v1File = JSON.stringify({ version: 1, state: legacyState });

    const migrated = decodeSave(v1File);
    expect(migrated).not.toBeNull();
    // 经验维度补 0;其余字段原样保留
    expect(migrated!.members.every((member) => member.experience === 0)).toBe(true);
    expect(migrated!.members.map((m) => m.id)).toEqual(state.members.map((m) => m.id));
    expect(migrated!.squads).toEqual(state.squads);
    expect(migrated!.clockGameMinutes).toBe(state.clockGameMinutes);

    // 迁移后的状态直接可玩:推进一日,时钟前进且不抛错
    const facade = new SimulationFacade(0, undefined, migrated!);
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(facade.state.clockGameMinutes).toBe(state.clockGameMinutes + GAME_MINUTES_PER_DAY);
  });

  it('v2 旧档(lastDungeonRun 可缺省)与 v3 旧档(无 kind 封皮)均可读', () => {
    const { state } = snapshotState();
    // v2 形状:无 lastDungeonRun 键(undefined 序列化时自然缺席)
    const v2File = JSON.stringify({ version: 2, state });
    expect(decodeSave(v2File)).toEqual(state);
    // v3 形状:本机旧档没有 kind 封皮
    const v3File = JSON.stringify({ version: 3, state });
    expect(decodeSave(v3File)).toEqual(state);
  });

  it('损坏、伪造与未知版本的文件一律拒绝(返回 null,不猜)', () => {
    const { state } = snapshotState();
    const good = encodeSave(state);

    expect(decodeSave('不是 JSON')).toBeNull();
    expect(decodeSave('null')).toBeNull();
    expect(decodeSave('"文本"')).toBeNull();
    expect(decodeSave('{}')).toBeNull(); // 缺 version/state
    expect(decodeSave('{"kind":"wowidle-save","version":4}')).toBeNull(); // 缺 state
    expect(decodeSave('{"kind":"别的游戏","version":4,"state":{}}')).toBeNull(); // 非本游戏文件
    expect(decodeSave('{"version":0,"state":{}}')).toBeNull(); // 非法版本
    expect(decodeSave('{"version":8,"state":{}}')).toBeNull(); // 未来版本
    expect(decodeSave('{"version":1.5,"state":{}}')).toBeNull(); // 非整数版本
    // 版本正确但结构不完整:关键字段缺失视为损坏
    expect(decodeSave('{"kind":"wowidle-save","version":4,"state":{"members":1}}')).toBeNull();
    expect(decodeSave(JSON.stringify({ kind: SAVE_KIND, version: 4, state: { ...state, members: 1 } }))).toBeNull();
    // 对照:同内容的正确文件可读
    expect(decodeSave(good)).not.toBeNull();
  });
});

describe('离线结算幂等:同一起止时间重复推进状态一致(验收标准 4)', () => {
  /** 大跳变总量:3 游戏周 + 2 游戏日 + 137 分钟(离线数周的典型量级)。 */
  const BIG_JUMP = GAME_MINUTES_PER_WEEK * 3 + GAME_MINUTES_PER_DAY * 2 + 137;

  it('一次大跳变与逐日分步推进(同一起止时间)结果完全一致', () => {
    const { state } = snapshotState();
    // 路径 A:一次推进到收束时间
    const oneShot = new SimulationFacade(0, undefined, structuredClone(state));
    const oneShotEvents = oneShot.dispatch({ deltaGameMinutes: BIG_JUMP }).events;
    // 路径 B:逐日推进 + 尾段分钟,总增量相同
    const chunked = new SimulationFacade(0, undefined, structuredClone(state));
    const chunkedEvents: SimEvent[] = [];
    for (let day = 0; day < 3 * 7 + 2; day++) {
      chunkedEvents.push(...chunked.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY }).events);
    }
    chunkedEvents.push(...chunked.dispatch({ deltaGameMinutes: 137 }).events);

    expect(chunked.state.clockGameMinutes).toBe(oneShot.state.clockGameMinutes);
    expect(JSON.stringify(chunked.state)).toBe(JSON.stringify(oneShot.state));
    // 事件流也一致:同样的边界、同样的序号与文本,只是到达方式不同
    expect(chunkedEvents).toEqual(oneShotEvents);
  });

  it('从同一快照出发,重复推进同一起止时间结果一致(重放不漂移)', () => {
    const { state } = snapshotState();
    const first = new SimulationFacade(0, undefined, structuredClone(state));
    const second = new SimulationFacade(0, undefined, structuredClone(state));
    const firstEvents = first.dispatch({ deltaGameMinutes: BIG_JUMP }).events;
    const secondEvents = second.dispatch({ deltaGameMinutes: BIG_JUMP }).events;

    expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state));
    expect(secondEvents).toEqual(firstEvents);
  });

  it('存档 round-trip 后的离线结算与原线一致(恢复后再离线,结果不漂移)', () => {
    const { state } = snapshotState();
    const direct = new SimulationFacade(0, undefined, structuredClone(state));
    const restored = new SimulationFacade(0, undefined, decodeSave(encodeSave(state))!);
    direct.dispatch({ deltaGameMinutes: BIG_JUMP });
    restored.dispatch({ deltaGameMinutes: BIG_JUMP });
    expect(JSON.stringify(restored.state)).toBe(JSON.stringify(direct.state));
  });

  it('零增量推进是空操作:状态不变、无事件(重复推送不重复结算)', () => {
    const { state } = snapshotState();
    const facade = new SimulationFacade(0, undefined, structuredClone(state));
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    const settled = structuredClone(facade.state);

    const noop = facade.dispatch({ deltaGameMinutes: 0 });
    expect(noop.events).toEqual([]);
    expect(facade.state).toEqual(settled);
  });
});
