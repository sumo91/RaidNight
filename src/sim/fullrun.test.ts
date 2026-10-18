import { describe, expect, it } from 'vitest';
import { G_RUN, RAIDS, FINAL_RAID } from '../content/raids';
import { DUNGEONS } from '../content/dungeons';
import { GEAR_SLOTS } from '../content/gear';
import { VAULT } from '../content/economy';
import { LEVELING_MAPS } from '../content/maps';
import { activeSet, setBonusItemLevel } from './roster';
import { RoundBot, type RoundOutcome } from '../../scripts/round-bot';
import { GAME_MINUTES_PER_WEEK } from './clock';
import { SimulationFacade, step } from './facade';
import type { GameState, Member, Squad } from './state';

/**
 * T18 门面测试:内容补全与平衡 —— 完整一轮可玩 + 20 人本 + 套装 + G团。
 *
 * 「完整一轮」用一只贪心机器人(scripts/round-bot.ts,开发与节奏调参共用)
 * 真实地把游戏从建会玩到通关最终团本:只发会长指令 + 时间增量(全项目唯一
 * 测试接缝)。一轮耗时(第几游戏周通关最终团本)落在 6–8 周目标带即验收。
 */

const SEED = 20261018;

describe('T18 内容表:全量阶梯(验收标准 1)', () => {
  it('地图 12 张(6 阶段 × 两档)、5 人本 15 座(四档)、团本 6 本(4 档 40 人 + 2 个 20 人休闲)', () => {
    expect(LEVELING_MAPS).toHaveLength(12);
    expect(DUNGEONS).toHaveLength(15);
    expect(RAIDS).toHaveLength(6);
    expect(RAIDS.filter((raid) => raid.size === 40 && raid.casual !== true)).toHaveLength(4);
    const casual = RAIDS.filter((raid) => raid.size === 20 && raid.casual === true);
    expect(casual).toHaveLength(2);
    // 20 人休闲团本全部开放 G团接单(追赶与接单场景的内容面)
    expect(casual.every((raid) => raid.gRunAllowed === true)).toBe(true);
    expect(FINAL_RAID.id).toBe(RAIDS[RAIDS.length - 1]!.id);
  });

  it('每档主力团本都有 5 件套(2/5 件效果),套装部位不重复且加成为正', () => {
    const mainRaids = RAIDS.filter((raid) => raid.size === 40);
    expect(mainRaids).toHaveLength(4);
    const setIds: string[] = [];
    for (const raid of mainRaids) {
      expect(raid.set).toBeDefined();
      expect(raid.set!.slots).toHaveLength(5);
      expect(new Set(raid.set!.slots).size).toBe(5);
      expect(raid.set!.setBonusItemLevel).toBeGreaterThan(0);
      setIds.push(raid.set!.id);
      // 紫装权重不低于缺省表:tier 套装的掉落面真的出套
      const purple = raid.dropQuality?.find((rule) => rule.quality === '紫')?.weight ?? 0;
      expect(purple).toBeGreaterThanOrEqual(40);
    }
    expect(new Set(setIds).size).toBe(4); // 不同 tier 的套装不串套
  });

  it('20 人休闲本门槛低于同档主力本(装备追赶定位);团本门槛沿阶梯不跳级', () => {
    for (const tier of [1, 2]) {
      const main = RAIDS.find((raid) => raid.tier === tier && raid.casual !== true)!;
      const casual = RAIDS.find((raid) => raid.tier === tier && raid.casual === true)!;
      expect(casual.unlock.averageLevel).toBeLessThan(main.unlock.averageLevel);
      expect(casual.unlock.averageItemLevel).toBeLessThan(main.unlock.averageItemLevel);
    }
    const mains = RAIDS.filter((raid) => raid.casual !== true).sort((a, b) => a.tier - b.tier);
    for (let i = 0; i + 1 < mains.length; i++) {
      expect(mains[i + 1]!.unlock.averageLevel).toBeGreaterThanOrEqual(mains[i]!.unlock.averageLevel);
      expect(mains[i + 1]!.unlock.averageItemLevel).toBeGreaterThanOrEqual(mains[i]!.unlock.averageItemLevel);
    }
  });
});

describe('T18 完整一轮:贪心机器人从建会玩到通关最终团本(验收标准 2–4)', () => {
  const outcome: RoundOutcome = new RoundBot(SEED, '远征测试会').play(14);

  it('节奏时间线(粗调的可观察面;打印逐周快照)', () => {
    const lines = outcome.snapshots.map(
      (s) =>
        `W${s.week}: 等级${s.averageLevel} 装等${s.averageItemLevel} 金库${s.vaultGold} 名册${s.rosterSize}` +
        (s.raidNight === undefined ? '' : ` | ${s.raidNight}`) +
        (s.clearedFinal ? ' | ★通关最终团本' : ''),
    );
    console.log(
      `[一轮时间线 seed=${SEED} 通关周=${outcome.finalClearWeek ?? '未通关'} G团夜=${outcome.gRunNights} 事件=${outcome.eventCount}]\n${lines.join('\n')}`,
    );
    expect(outcome.snapshots.length).toBeGreaterThan(0);
  });

  it('完整一轮可通:最终团本在 6–8 游戏周目标带内通关(验收标准 4)', () => {
    expect(outcome.finalClearWeek).toBeDefined();
    expect(outcome.finalClearWeek!).toBeGreaterThanOrEqual(6);
    expect(outcome.finalClearWeek!).toBeLessThanOrEqual(8);
  });

  it('机器人没有陷入指令风暴:全程事件量在常规量级', () => {
    expect(outcome.eventCount).toBeLessThan(6000);
  });

  it('20 人本可打:两座休闲团本都留下本会首杀(4 支小队成团出战)', () => {
    const killedRaids = new Set(outcome.state.honorWall.firstKills.map((badge) => badge.raidId));
    for (const raid of RAIDS.filter((r) => r.casual === true)) {
      expect(killedRaids.has(raid.id)).toBe(true);
    }
  });

  it('套装 2/5 件效果生效:通关时有团员穿满同套装 ≥2 件并领到内容表加成', () => {
    expect(outcome.setBonusMembers).toBeGreaterThan(0);
    const member = outcome.state.members.find((m) => setBonusItemLevel(m) > 0)!;
    const active = activeSet(member);
    expect(active).toBeDefined();
    expect(active!.pieces).toBeGreaterThanOrEqual(2);
    const raid = RAIDS.find((r) => r.set?.id === active!.id)!;
    expect(setBonusItemLevel(member)).toBe(raid.set!.setBonusItemLevel);
  });

  it('G团接单发生且金币流向正确:打工费入个人金、抽成入金库', () => {
    expect(outcome.gRunNights).toBeGreaterThan(0);
    expect(outcome.state.members.some((m) => m.personalGold > 0)).toBe(true);
  });
});

describe('T18 机制面:20 人团队检查与 G团夜结算(验收标准 2 的规则面)', () => {
  const CASUAL = RAIDS.find((raid) => raid.id === 'jade-shrine')!;
  const GRUN_RAID = RAIDS.find((raid) => raid.id === 'crystal-sand')!;

  /** 合成团员:只填团本结算涉及的维度(与 raid.test 同法)。 */
  function synthMember(id: number, classId: string, specId: string, itemLevel: number): Member {
    return {
      id,
      isChairman: false,
      joinedAtGameMinutes: 0,
      benchDays: 0,
      name: `机制团员${id}`,
      classId,
      specId,
      level: 60,
      experience: 0,
      gear: GEAR_SLOTS.map((slot) => ({ slot, quality: '蓝' as const, itemLevel })),
      mood: 80,
      loyalty: 80,
      personalGold: 0,
      dkp: 0,
      fatigue: 0,
      attendance: { styleId: 'iron', baseRate: 95 },
      traits: [],
      skillTierId: 'skilled',
      bossKills: 0,
      rareLootWon: 0,
    };
  }

  /** 标准小队(1 坦 1 奶 3 输出)×N 的合成状态,挂 G团开团安排。 */
  function gRunReadyState(squads: number, itemLevel: number, raidId: string): GameState {
    const base = new SimulationFacade(SEED, '机制测试公会').state;
    const members: Member[] = [];
    const squadList: Squad[] = [];
    for (let s = 0; s < squads; s++) {
      const ids = [s * 5 + 1, s * 5 + 2, s * 5 + 3, s * 5 + 4, s * 5 + 5];
      members.push(
        synthMember(ids[0]!, 'warrior', 'warrior-guard', itemLevel),
        synthMember(ids[1]!, 'priest', 'priest-light', itemLevel),
        synthMember(ids[2]!, 'mage', 'mage-arcane', itemLevel),
        synthMember(ids[3]!, 'mage', 'mage-flame', itemLevel),
        synthMember(ids[4]!, 'mage', 'mage-frost', itemLevel),
      );
      squadList.push({ id: s + 1, memberIds: ids });
    }
    return {
      ...base,
      members,
      nextMemberId: squads * 5 + 2,
      squads: squadList,
      nextSquadId: squads + 1,
      clockGameMinutes: GAME_MINUTES_PER_WEEK - 60,
      raidPlan: { raidId, openedAtGameMinutes: GAME_MINUTES_PER_WEEK - 120, mode: 'gRun' },
    };
  }

  it('20 人团队检查:4 支满员小队达标开团,3 支不足被拒(规模折算)', () => {
    const four = step(gRunReadyState(4, 30, CASUAL.id), { deltaGameMinutes: 0 });
    expect(four.state.raidPlan).toBeDefined(); // 安排已在(合成状态直填)
    // 3 支小队:20 人检查不通过 ⇒ 开团指令被门面忽略
    const three = step({ ...gRunReadyState(3, 30, CASUAL.id), raidPlan: undefined }, {
      command: { type: 'openRaid', raidId: CASUAL.id },
      deltaGameMinutes: 0,
    });
    expect(three.state.raidPlan).toBeUndefined();
    expect(three.events).toEqual([]);
    // 同样的 3 支小队对 40 人主力本同样不可开(8 支满员要求)
    const mainRaid = RAIDS.find((raid) => raid.casual !== true && raid.tier === 1)!;
    const forMain = step({ ...gRunReadyState(3, 30, mainRaid.id), raidPlan: undefined }, {
      command: { type: 'openRaid', raidId: mainRaid.id },
      deltaGameMinutes: 0,
    });
    expect(forMain.state.raidPlan).toBeUndefined();
  });

  it('G团夜:掉落整批卖出,金库抽成 + 打工费均分,数值精确(验收标准 2)', () => {
    // 晶沙王陵 3 首领,合成 20 人装等 70:全首领必胜区间,全通确定
    const facade = new SimulationFacade(SEED, undefined, gRunReadyState(4, 70, GRUN_RAID.id));
    const output = facade.dispatch({ deltaGameMinutes: 60 });
    const state = facade.state;
    const report = state.lastRaidNight!;

    expect(report.cleared).toBe(true);
    expect(report.gRun).toBeDefined();
    // 卖出件数 = 全部掉落;每件记售价、无人穿戴
    const drops = report.bosses.flatMap((boss) => boss.drops);
    expect(drops.length).toBe(GRUN_RAID.bosses.reduce((sum, boss) => sum + boss.dropsPerKill, 0));
    expect(drops.every((drop) => drop.equipped === false && drop.soldGold === G_RUN.priceByQuality[drop.quality])).toBe(true);
    // 金币守恒:总价 = 金库进账 + 20 人 × 打工费
    const pot = drops.reduce((sum, drop) => sum + drop.soldGold!, 0);
    expect(report.gRun!.vaultGoldIn + report.gRun!.goldPerRaider * 20).toBe(pot);
    expect(state.vault.incomeTotal).toBe(report.gRun!.vaultGoldIn);
    expect(state.vault.gold).toBe(VAULT.startingGold + report.gRun!.vaultGoldIn);
    for (const member of state.members) {
      expect(member.personalGold).toBe(report.gRun!.goldPerRaider);
    }
    // 公会团的制度结算不出现(G团是打工,不走分配制度)
    expect(output.events.some((event) => event.kind === '团本' && event.text.includes('G团成交'))).toBe(true);
    expect(report.loot).toBeUndefined();
    // 卖掉的紫装不进稀有陈列(墙上只挂穿在身上的战利品)
    expect(state.honorWall.rareDrops).toHaveLength(0);
  });
});
