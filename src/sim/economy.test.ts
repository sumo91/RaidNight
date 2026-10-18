import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_ACTIVITY_BY_ID,
  LOOT_SYSTEM_BY_ID,
  VAULT,
  type LootSystemId,
} from '../content/economy';
import { GEAR_SLOTS } from '../content/gear';
import { RAID_BY_ID, RAID_SETTLEMENT, type RaidDef } from '../content/raids';
import { MILESTONES, RENOWN_SOURCES } from '../content/reputation';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from './clock';
import { SimulationFacade, decodeSave, encodeSave, step } from './facade';
import type { GameState, GearItem, Member, RaidNightReport, Squad } from './state';

/**
 * T11 门面测试:经济与分配制度 —— 双钱包 + 三制度 + 自肥。
 * 与全项目一致只打门面接缝:驱动 SimulationFacade / 纯函数 step 断言状态快照
 * 与事件日志;40 人团本场景超出指令可达规模(名册上限 6),按 T10 先例用
 * 合成状态(step 的 prev 入参)驱动。数值断言全部用内容常量独立重算
 * (不复用结算实现的代码路径)。
 *
 * 场景基线:装等 67 的 40 人团队开团「熔渊窟」—— 首两名首领必胜区间内
 * (掉落装等 73+ 全员可提升),第三名首领装等硬门槛 68 未达 ⇒ 团灭;
 * 金库余额置 0(团灭修理金实付 0),制度间的金币流向互不掺杂。
 */

const SEED = 20261018;
const RAID = RAID_BY_ID.get('molten-abyss') as RaidDef;
const DKP = LOOT_SYSTEM_BY_ID.get('dkp')!;
const GKP = LOOT_SYSTEM_BY_ID.get('gkp')!;
const DISCRETION = LOOT_SYSTEM_BY_ID.get('chairman')!;
const CARRY = EXTERNAL_ACTIVITY_BY_ID.get('carry')!;
const WILD = EXTERNAL_ACTIVITY_BY_ID.get('wildRaid')!;

/** 合成团员:只填经济与团本结算涉及的维度。 */
function synthMember(
  id: number,
  classId: string,
  specId: string,
  itemLevel: number,
  options?: {
    level?: number;
    mood?: number;
    name?: string;
    isChairman?: boolean;
    personalGold?: number;
    dkp?: number;
  },
): Member {
  return {
    id,
    isChairman: options?.isChairman ?? false,
    joinedAtGameMinutes: 0,
    benchDays: 0,
    name: options?.name ?? `合成团员${id}`,
    classId,
    specId,
    level: options?.level ?? 60,
    experience: 0,
    gear: GEAR_SLOTS.map((slot) => ({ slot, quality: '蓝' as const, itemLevel })) as GearItem[],
    mood: options?.mood ?? 80,
    loyalty: 80,
    fatigue: 0,
    personalGold: options?.personalGold ?? 0,
    dkp: options?.dkp ?? 0,
    attendance: { styleId: 'iron', baseRate: 95 },
    traits: [],
    skillTierId: 'skilled',
    bossKills: 0,
    rareLootWon: 0,
  };
}

/** 标准小队:1 坦(战士·铁壁)+ 1 奶(牧师·圣言)+ 3 输出(法师三系)。 */
function standardSquadMembers(startId: number, itemLevel: number, personalGold = 0, dkp = 0): Member[] {
  const make = (id: number, classId: string, specId: string) =>
    synthMember(id, classId, specId, itemLevel, { personalGold, dkp });
  return [
    make(startId, 'warrior', 'warrior-guard'),
    make(startId + 1, 'priest', 'priest-light'),
    make(startId + 2, 'mage', 'mage-arcane'),
    make(startId + 3, 'mage', 'mage-flame'),
    make(startId + 4, 'mage', 'mage-frost'),
  ];
}

/** 团本就绪的合成状态:8 支满员标准小队 + 会长角色(默认不在小队)+ 已开团。 */
function econRaidState(
  options?: {
    seed?: number;
    itemLevel?: number;
    /** 会长角色编入第 1 小队第 5 位(自肥须在阵中;默认场下) */
    chairmanInTeam?: boolean;
    /** 会长角色全身装等(编入时可用低装等保证件件可提升) */
    chairmanItemLevel?: number;
    personalGold?: number;
    dkp?: number;
    system?: LootSystemId;
    selfDealing?: boolean;
    vaultGold?: number;
    renownPoints?: number;
  },
): GameState {
  const base = new SimulationFacade(options?.seed ?? SEED, '经济测试公会').state;
  const itemLevel = options?.itemLevel ?? 34;
  const gold = options?.personalGold ?? 0;
  const dkp = options?.dkp ?? 0;
  const members: Member[] = [];
  const squads: Squad[] = [];
  for (let squadIndex = 0; squadIndex < 8; squadIndex++) {
    const squadMembers = standardSquadMembers(squadIndex * 5 + 1, itemLevel, gold, dkp);
    // 自肥场景:第 1 小队第 5 位换成长会角色(输出职能,编成仍齐整)
    if (squadIndex === 0 && options?.chairmanInTeam) {
      squadMembers[4] = synthMember(41, 'rogue', 'rogue-venom', options.chairmanItemLevel ?? itemLevel, {
        name: '会长角色',
        isChairman: true,
        personalGold: gold,
        dkp,
      });
    }
    members.push(...squadMembers);
    squads.push({ id: squadIndex + 1, memberIds: squadMembers.map((member) => member.id) });
  }
  if (!options?.chairmanInTeam) {
    members.push(
      synthMember(41, 'rogue', 'rogue-venom', itemLevel, {
        name: '会长角色',
        isChairman: true,
        personalGold: gold,
        dkp,
      }),
    );
  }
  return {
    ...base,
    members,
    nextMemberId: 42,
    squads,
    nextSquadId: 9,
    clockGameMinutes: GAME_MINUTES_PER_WEEK - 60, // 团本夜(周边界)前 60 分钟
    vault: { gold: options?.vaultGold ?? 0, repairSpent: 0, incomeTotal: 0 },
    economy: {
      system: options?.system ?? DISCRETION.id,
      systemSinceGameMinutes: 0,
      selfDealing: options?.selfDealing ?? false,
      selfDealtCount: 0,
      selfDealReputationPaid: 0,
    },
    renownPoints: options?.renownPoints ?? 50,
    raidPlan: { raidId: RAID.id, openedAtGameMinutes: GAME_MINUTES_PER_WEEK - 120 },
  };
}

/** 跑一个团本夜(跨过周边界 60 分钟),返回终态与全部事件。 */
function runNight(state: GameState, seed = SEED): { state: GameState; events: string[]; report: RaidNightReport } {
  const facade = new SimulationFacade(seed, undefined, structuredClone(state));
  const output = facade.dispatch({ deltaGameMinutes: 60 });
  return {
    state: facade.state,
    events: output.events.map((event) => event.text),
    report: facade.state.lastRaidNight!,
  };
}

/** 单个小队小会状态(外快结算用):clock 0,一金库原样的建会底。 */
function smallState(itemLevel = 60, level = 60): GameState {
  const base = new SimulationFacade(SEED, '经济小会').state;
  const squad = standardSquadMembers(1, itemLevel);
  return {
    ...base,
    members: [
      ...squad,
      synthMember(6, 'rogue', 'rogue-venom', itemLevel, { level, name: '会长角色', isChairman: true }),
    ],
    nextMemberId: 7,
    squads: [{ id: 1, memberIds: squad.map((member) => member.id) }],
    nextSquadId: 2,
    clockGameMinutes: 0,
  };
}

describe('双钱包:收入流向(验收标准 1)', () => {
  it('G团打工:收入进个人金,金库分文不动', () => {
    const facade = new SimulationFacade(SEED, undefined, smallState());
    const assign = facade.dispatch({ command: { type: 'assignCarry', squadId: 1 }, deltaGameMinutes: 0 });
    expect(assign.events.map((event) => [event.kind, event.text])).toEqual([
      [
        '经济',
        `第 1 小队出坞G团打工:每人每日 +${CARRY.goldPerMemberPerDay} 金入个人金,疲劳 +${CARRY.fatiguePerMemberPerDay}。`,
      ],
    ]);

    const day = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(day.events.some((event) => event.kind === '经济' && event.text.includes('完成G团打工'))).toBe(true);
    // 流向:队员个人金 +30;会长角色(未随队)与金库不动
    expect(facade.state.members.filter((member) => member.id <= 5).every((member) => member.personalGold === CARRY.goldPerMemberPerDay)).toBe(true);
    expect(facade.state.members.find((member) => member.isChairman)!.personalGold).toBe(0);
    expect(facade.state.vault).toEqual({ gold: VAULT.startingGold, repairSpent: 0, incomeTotal: 0 });
  });

  it('野团:收入同样归个人金(金库不动)', () => {
    const facade = new SimulationFacade(SEED, undefined, smallState());
    facade.dispatch({ command: { type: 'assignWildRaid', squadId: 1 }, deltaGameMinutes: 0 });
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(facade.state.members.filter((member) => member.id <= 5).every((member) => member.personalGold === WILD.goldPerMemberPerDay)).toBe(true);
    expect(facade.state.vault.gold).toBe(VAULT.startingGold);
    expect(facade.state.vault.incomeTotal).toBe(0);
  });

  it('编成不齐:外快暂停、无收入(可观察、可恢复)', () => {
    const facade = new SimulationFacade(SEED, undefined, smallState());
    facade.dispatch({ command: { type: 'assignCarry', squadId: 1 }, deltaGameMinutes: 0 });
    facade.dispatch({ command: { type: 'removeFromSquad', memberId: 5 }, deltaGameMinutes: 0 });
    const day = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(
      day.events.some((event) => event.kind === '经济' && event.text.includes('第 1 小队的G团打工暂停:未满员')),
    ).toBe(true);
    expect(facade.state.members.every((member) => member.personalGold === 0)).toBe(true);
  });

  it('未解锁:低等级公会的外快安排被门面忽略(状态不变、无事件)', () => {
    const state = smallState(12, 12); // 平均等级 12 < 野团门槛 30 < 打工门槛 40
    const output = step(state, { command: { type: 'assignCarry', squadId: 1 }, deltaGameMinutes: 0 });
    expect(output.events).toEqual([]);
    expect(output.state.squads[0]!.activity).toBeUndefined();
  });

  it('团本产出按制度流向金库/个人:见下文三制度对比(制度面在本文件下半部逐条断言)', () => {
    // 占位说明:金币从个人金流入金库的唯一路径是 GKP 制(下文断言),
    // DKP 制与会长裁量制下团本金币不流动。
    expect(GKP.gkpVaultCutPercent).toBeGreaterThan(0);
  });
});

describe('同一掉落,三种制度的金币与忠诚流向对比(验收标准 2 与 5)', () => {
  /** 同一 40 人团队、同一种子,分别在三种制度下过同一个团本夜。 */
  function compareNights() {
    return {
      dkp: runNight(econRaidState({ system: 'dkp', personalGold: 400, dkp: 20 })),
      gkp: runNight(econRaidState({ system: 'gkp', personalGold: 400, dkp: 20 })),
      chairman: runNight(econRaidState({ system: 'chairman', personalGold: 400, dkp: 20 })),
    };
  }

  /** 掉落序列(部位|品质|装等):制度只影响归属,不影响掉落掷取。 */
  const dropSequence = (report: RaidNightReport): string[] =>
    report.bosses.flatMap((boss) => boss.drops.map((drop) => `${drop.slot}|${drop.quality}|${drop.itemLevel}`));

  it('三种制度掷出完全相同的掉落(随机链不受制度影响)', () => {
    const nights = compareNights();
    const sequence = dropSequence(nights.dkp.report);
    expect(sequence.length).toBeGreaterThanOrEqual(3); // 至少首领先掉落(必胜区间)
    expect(dropSequence(nights.gkp.report)).toEqual(sequence);
    expect(dropSequence(nights.chairman.report)).toEqual(sequence);
    // 战斗结果也一致(制度不掺和胜负)
    const kills = nights.dkp.report.bosses.map((boss) => boss.killed);
    expect(nights.gkp.report.bosses.map((boss) => boss.killed)).toEqual(kills);
    expect(nights.chairman.report.bosses.map((boss) => boss.killed)).toEqual(kills);
  });

  it('DKP 制:金币不流动;忠诚/心情上涨;赢家照品质价目扣分', () => {
    const { state, report, events } = compareNights().dkp;
    const kills = report.bosses.filter((boss) => boss.killed).length;
    const equipped = report.bosses.flatMap((boss) => boss.drops).filter((drop) => drop.equipped);

    // 金币流向:金库与全员个人金都分文不动
    expect(state.vault).toEqual({ gold: 0, repairSpent: 0, incomeTotal: 0 });
    expect(state.members.every((member) => member.personalGold === 400)).toBe(true);

    // 忠诚/心情:出席 40 人 +4 / 团灭 −10 后 +2;会长角色(场下)不受波及
    expect(state.members.filter((member) => member.id <= 40).every((member) => member.loyalty === 80 + DKP.attendeeLoyaltyPerNight)).toBe(true);
    expect(state.members.find((member) => member.isChairman)!.loyalty).toBe(80); // 合成夹具值,制度不波及场下会长
    expect(state.members.filter((member) => member.id <= 40).every((member) => member.mood === 80 - RAID_SETTLEMENT.wipeMoodHit + DKP.attendeeMoodPerNight)).toBe(true);

    // 扣分:每件已穿掉落的 DKP 价 = 品质价目;每人终值 = 起始 + 击杀记分 − 自己拿装扣分
    expect(equipped.length).toBeGreaterThan(0);
    for (const drop of equipped) {
      expect(drop.dkpPaid).toBe(DKP.dkpPriceByQuality![drop.quality]);
      expect(drop.system).toBe('dkp');
    }
    const paidByName = new Map<string, number>();
    for (const drop of equipped) {
      paidByName.set(drop.assignedTo!, (paidByName.get(drop.assignedTo!) ?? 0) + drop.dkpPaid!);
    }
    for (const member of state.members.filter((entry) => entry.id <= 40)) {
      expect(member.dkp).toBe(20 + kills * DKP.dkpPerBossKill! - (paidByName.get(member.name) ?? 0));
    }
    expect(events.some((text) => text.includes('本夜分配:「DKP 制」'))).toBe(true);
    expect(report.loot).toMatchObject({
      system: 'dkp',
      vaultGoldIn: 0,
      personalGoldOut: 0,
      selfDealtCount: 0,
      attendeeLoyaltyPerNight: DKP.attendeeLoyaltyPerNight,
    });
  });

  it('GKP 制:成交价从赢家个人金流出 → 金库抽成 + 全团均分(守恒);忠诚不动、心情上涨', () => {
    const { state, report } = compareNights().gkp;
    const equipped = report.bosses.flatMap((boss) => boss.drops).filter((drop) => drop.equipped);
    const teamSize = 40;

    // 独立重算:每件成交价的拆分与每人的收支(只用内容常量)
    let vaultInExpected = 0;
    let sharesPerMember = 0;
    const paidByName = new Map<string, number>();
    for (const drop of equipped) {
      const price = GKP.gkpPriceByQuality![drop.quality];
      expect(drop.goldPaid).toBe(price);
      expect(drop.system).toBe('gkp');
      const vaultCut = Math.floor((price * GKP.gkpVaultCutPercent!) / 100);
      const pot = price - vaultCut;
      const share = Math.floor(pot / teamSize);
      vaultInExpected += vaultCut + (pot - share * teamSize);
      sharesPerMember += share;
      paidByName.set(drop.assignedTo!, (paidByName.get(drop.assignedTo!) ?? 0) + price);
    }
    expect(equipped.length).toBeGreaterThan(0);

    // 金币流向:个人金 → 金库抽成 + 全团均分(总量守恒);
    // 金库余额 = 收入 − 团灭修理金(全部掉落先于团灭结算,修理金按届时余额封顶)
    expect(state.vault.incomeTotal).toBe(vaultInExpected);
    const repair = Math.min(vaultInExpected, RAID_SETTLEMENT.wipeRepairGoldPerRaider * 40);
    expect(state.vault.gold).toBe(vaultInExpected - repair);
    expect(state.vault.repairSpent).toBe(repair);
    for (const member of state.members.filter((entry) => entry.id <= 40)) {
      expect(member.personalGold).toBe(400 + sharesPerMember - (paidByName.get(member.name) ?? 0));
    }
    expect(report.loot).toMatchObject({
      system: 'gkp',
      vaultGoldIn: vaultInExpected,
      personalGoldOut: [...paidByName.values()].reduce((sum, value) => sum + value, 0),
    });

    // 忠诚/心情:雇佣兵心态 —— 忠诚不涨,心情看涨
    expect(state.members.filter((member) => member.id <= 40).every((member) => member.loyalty === 80)).toBe(true);
    expect(state.members.filter((member) => member.id <= 40).every((member) => member.mood === 80 - RAID_SETTLEMENT.wipeMoodHit + GKP.attendeeMoodPerNight)).toBe(true);
  });

  it('会长裁量(不自肥):金币不流动;人治微损忠诚', () => {
    const { state, report } = compareNights().chairman;
    expect(state.vault).toEqual({ gold: 0, repairSpent: 0, incomeTotal: 0 });
    expect(state.members.every((member) => member.personalGold === 400)).toBe(true);
    expect(state.members.filter((member) => member.id <= 40).every((member) => member.loyalty === 80 + DISCRETION.attendeeLoyaltyPerNight)).toBe(true);
    expect(state.members.filter((member) => member.id <= 40).every((member) => member.mood === 80 - RAID_SETTLEMENT.wipeMoodHit)).toBe(true);
    for (const drop of report.bosses.flatMap((boss) => boss.drops)) {
      expect(drop.system).toBe('chairman');
      expect(drop.selfDealt).toBeUndefined();
      expect(drop.goldPaid).toBeUndefined();
      expect(drop.dkpPaid).toBeUndefined();
    }
  });

  it('三制度对照:忠诚/心情/金库入账三向差异可观察', () => {
    const nights = compareNights();
    const attendeeLoyalty = (run: ReturnType<typeof runNight>): number =>
      run.state.members.find((member) => member.id === 1)!.loyalty;
    const attendeeMood = (run: ReturnType<typeof runNight>): number =>
      run.state.members.find((member) => member.id === 1)!.mood;

    // 忠诚:DKP 涨 > GKP 平 > 裁量降(三种制度三档,互不相同)
    const loyalties = [attendeeLoyalty(nights.dkp), attendeeLoyalty(nights.gkp), attendeeLoyalty(nights.chairman)];
    expect(new Set(loyalties).size).toBe(3);
    expect(loyalties[0]!).toBeGreaterThan(loyalties[1]!);
    expect(loyalties[1]!).toBeGreaterThan(loyalties[2]!);
    // 心情:三档互不相同(GKP 分红最振,DKP 公平次之,裁量平平)
    const moods = [attendeeMood(nights.dkp), attendeeMood(nights.gkp), attendeeMood(nights.chairman)];
    expect(new Set(moods).size).toBe(3);
    // 金库入账:只有 GKP 让金库进钱
    expect(nights.dkp.state.vault.incomeTotal).toBe(0);
    expect(nights.gkp.state.vault.incomeTotal).toBeGreaterThan(0);
    expect(nights.chairman.state.vault.incomeTotal).toBe(0);
  });

  it('GKP 流拍:无人出得起全价 → 掉落分解(个人金为 0 的团队)', () => {
    const { state, report } = runNight(econRaidState({ system: 'gkp', personalGold: 0 }));
    const drops = report.bosses.flatMap((boss) => boss.drops);
    expect(drops.length).toBeGreaterThan(0);
    for (const drop of drops) {
      expect(drop.equipped).toBe(false);
      expect(drop.unequippedReason).toBe('流拍');
    }
    expect(state.vault.incomeTotal).toBe(0);
    expect(state.members.every((member) => member.personalGold === 0)).toBe(true);
  });
});

describe('制度更换与转换成本(验收标准 3)', () => {
  it('换制成立:金库扣立规费、全员忠诚摩擦、安排与事件入账', () => {
    const state = econRaidState({ system: 'chairman', personalGold: 400, vaultGold: 500 });
    const output = step(state, { command: { type: 'setLootSystem', system: 'gkp' }, deltaGameMinutes: 0 });
    const gkp = LOOT_SYSTEM_BY_ID.get('gkp')!;

    expect(output.state.economy.system).toBe('gkp');
    expect(output.state.economy.systemSinceGameMinutes).toBe(state.clockGameMinutes);
    expect(output.state.vault.gold).toBe(500 - gkp.switchCostGold);
    // 忠诚摩擦:全员(会长角色除外)−switchLoyaltyHit
    expect(output.state.members.filter((member) => member.id <= 40).every((member) => member.loyalty === 80 - gkp.switchLoyaltyHit)).toBe(true);
    expect(output.state.members.find((member) => member.isChairman)!.loyalty).toBe(80); // 合成夹具值;换制摩擦不波及会长角色
    expect(output.events.map((event) => [event.kind, event.text])).toEqual([
      [
        '经济',
        `分配制度改为「GKP 制」:立规支出 ${gkp.switchCostGold} 金(金库余 ${500 - gkp.switchCostGold}),全员忠诚 −${gkp.switchLoyaltyHit}。`,
      ],
    ]);
  });

  it('金库付不起立规费:换制被拒(状态不变、无事件)', () => {
    const state = econRaidState({ system: 'chairman', vaultGold: 50 });
    const output = step(state, { command: { type: 'setLootSystem', system: 'dkp' }, deltaGameMinutes: 0 });
    expect(output.events).toEqual([]);
    expect(output.state.economy.system).toBe('chairman');
    expect(output.state.vault.gold).toBe(50);
  });

  it('换成现行制度:忽略;换入 DKP:积分清零重记', () => {
    const dkpState = econRaidState({ system: 'dkp', dkp: 20 });
    expect(step(dkpState, { command: { type: 'setLootSystem', system: 'dkp' }, deltaGameMinutes: 0 }).events).toEqual([]);

    const switched = step(
      econRaidState({ system: 'chairman', dkp: 20, vaultGold: 500 }),
      { command: { type: 'setLootSystem', system: 'dkp' }, deltaGameMinutes: 0 },
    );
    expect(switched.state.economy.system).toBe('dkp');
    expect(switched.state.members.every((member) => member.dkp === 0)).toBe(true);
    expect(switched.events[0]!.text).toContain('DKP 清零重记');
  });

  it('自肥开关只在会长裁量制下生效;换出裁量制时自动收手', () => {
    const gkpState = econRaidState({ system: 'gkp' });
    const rejected = step(gkpState, { command: { type: 'setSelfDealing', enabled: true }, deltaGameMinutes: 0 });
    expect(rejected.events).toEqual([]);
    expect(rejected.state.economy.selfDealing).toBe(false);

    const chairState = econRaidState({ system: 'chairman', selfDealing: true, vaultGold: 500 });
    const away = step(chairState, { command: { type: 'setLootSystem', system: 'gkp' }, deltaGameMinutes: 0 });
    expect(away.state.economy.selfDealing).toBe(false); // 自肥随裁量制一起结束
  });
});

describe('自肥:决策可执行、代价累积可见(验收标准 4)', () => {
  /** 自肥就绪状态:裁量制 + 自肥开 + 会长角色(装等 60)编入第 1 小队 —— 件件掉落都容得下他。 */
  function selfDealState(): GameState {
    return econRaidState({
      system: 'chairman',
      selfDealing: true,
      chairmanInTeam: true,
      chairmanItemLevel: 60,
      renownPoints: 50,
    });
  }

  /**
   * 独立重算:当前状态因公会成就赚得的声望(T12 起声望为真值,自肥扣减之外
   * 还有首杀/里程碑加分;只用内容常量,不复用结算实现的代码路径)。
   */
  const earnedRenownOf = (state: GameState): number =>
    state.honorWall.firstKills.length * RENOWN_SOURCES.firstKillPointsByRaidTier[RAID.tier - 1]! +
    state.honorWall.milestones.reduce(
      (sum, record) => sum + (MILESTONES.find((def) => def.id === record.milestoneId)?.points ?? 0),
      0,
    );

  it('开启自肥:掉落优先装进会长角色,每件付出忠诚与声望代价', () => {
    const { state, report, events } = runNight(selfDealState());
    const drops = report.bosses.flatMap((boss) => boss.drops).filter((drop) => drop.equipped);
    expect(drops.length).toBeGreaterThan(0);
    // 会长角色装等 60:绝大多数掉落都容得下他(同部位二次掉落除外,那时回落裁量)
    const selfDealt = drops.filter((drop) => drop.selfDealt);
    expect(selfDealt.length).toBeGreaterThan(0);
    for (const drop of selfDealt) {
      expect(drop.assignedTo).toBe('会长角色');
    }

    // 会长角色真的穿上了(装备总量上升)
    const chairman = state.members.find((member) => member.isChairman)!;
    const gearSum = chairman.gear.reduce((sum, item) => sum + item.itemLevel, 0);
    expect(gearSum).toBeGreaterThan(8 * 60);

    // 代价:出席者忠诚 = 80 − 裁量夜调整 − 每件自肥忠诚代价;声望按件扣减
    const count = selfDealt.length;
    expect(state.members.filter((member) => !member.isChairman && member.id <= 40).every((member) => member.loyalty === 80 + DISCRETION.attendeeLoyaltyPerNight - DISCRETION.selfDealLoyaltyCost! * count)).toBe(true);
    expect(chairman.loyalty).toBe(80); // 合成夹具值;自肥付的是团员的账,会长角色忠诚不波动
    expect(state.economy.selfDealtCount).toBe(count);
    expect(state.economy.selfDealReputationPaid).toBe(DISCRETION.selfDealReputationCost! * count);
    expect(state.renownPoints).toBe(50 - DISCRETION.selfDealReputationCost! * count + earnedRenownOf(state));
    expect(events.some((text) => text.includes('自肥') && text.includes('代价累积可见'))).toBe(true);
  });

  it('夜复一夜:自肥件数与声望代价精确累积(第二夜继续扣)', () => {
    const facade = new SimulationFacade(SEED, undefined, selfDealState());
    facade.dispatch({ deltaGameMinutes: 60 }); // 第一夜
    const afterNight1 = structuredClone(facade.state);
    const count1 = afterNight1.economy.selfDealtCount;
    expect(count1).toBeGreaterThan(0);

    // 重新开团再过一周:第二夜(开荒再战)
    facade.dispatch({ command: { type: 'openRaid', raidId: RAID.id }, deltaGameMinutes: 0 });
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    const afterNight2 = facade.state;
    const count2 = afterNight2.lastRaidNight!.loot!.selfDealtCount;
    const total = afterNight2.economy.selfDealtCount;

    // 累积可见:总件数 = 夜一夜二之和;声望代价与扣减后的声望同步累积
    expect(total).toBe(count1 + count2);
    expect(afterNight2.economy.selfDealReputationPaid).toBe(DISCRETION.selfDealReputationCost! * total);
    expect(afterNight2.renownPoints).toBe(50 - DISCRETION.selfDealReputationCost! * total + earnedRenownOf(afterNight2));
  });

  it('关闭自肥:掉落回到正常裁量,不再产生自肥代价', () => {
    const facade = new SimulationFacade(SEED, undefined, selfDealState());
    facade.dispatch({ deltaGameMinutes: 60 }); // 第一夜(自肥)
    const count1 = facade.state.economy.selfDealtCount;
    expect(count1).toBeGreaterThan(0);

    facade.dispatch({ command: { type: 'setSelfDealing', enabled: false }, deltaGameMinutes: 0 });
    expect(facade.state.economy.selfDealing).toBe(false);
    facade.dispatch({ command: { type: 'openRaid', raidId: RAID.id }, deltaGameMinutes: 0 });
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    const report = facade.state.lastRaidNight!;
    expect(report.bosses.flatMap((boss) => boss.drops).every((drop) => drop.selfDealt === undefined)).toBe(true);
    expect(facade.state.economy.selfDealtCount).toBe(count1); // 不再累积
    expect(facade.state.renownPoints).toBe(50 - DISCRETION.selfDealReputationCost! * count1 + earnedRenownOf(facade.state));
  });
});

describe('存档兼容:经济面随 v7 落盘', () => {
  it('v6 旧档(无个人金/DKP/经济)迁移后补默认,可直接继续玩', () => {
    const state = econRaidState({ system: 'gkp', personalGold: 400 });
    // 剥掉经济面字段,还原 v6 时代的真实存档形状
    const legacyState = JSON.parse(
      JSON.stringify(state, (key, value) =>
        key === 'economy' || key === 'personalGold' || key === 'dkp' || key === 'incomeTotal'
          ? undefined
          : value,
      ),
    );
    const v6File = JSON.stringify({ version: 6, state: legacyState });
    const migrated = decodeSave(v6File)!;

    expect(migrated.members.every((member) => member.personalGold === 0 && member.dkp === 0)).toBe(true);
    expect(migrated.vault).toEqual({ gold: 0, repairSpent: 0, incomeTotal: 0 });
    expect(migrated.economy).toEqual({
      system: 'chairman',
      systemSinceGameMinutes: state.clockGameMinutes,
      selfDealing: false,
      selfDealtCount: 0,
      selfDealReputationPaid: 0,
    });
    const facade = new SimulationFacade(0, undefined, migrated);
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(facade.state.clockGameMinutes).toBe(state.clockGameMinutes + GAME_MINUTES_PER_DAY);
  });

  it('经济面随状态 round-trip 逐字节一致;同种子重放不漂移', () => {
    const state = econRaidState({ system: 'gkp', personalGold: 400 });
    const restored = decodeSave(encodeSave(state))!;
    expect(JSON.stringify(restored)).toBe(JSON.stringify(state));

    const first = runNight(state);
    const second = runNight(state);
    expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state));
    expect(second.events).toEqual(first.events);
  });
});
