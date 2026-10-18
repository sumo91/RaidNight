import { describe, expect, it } from 'vitest';
import { GEAR_SLOTS } from '../content/gear';
import { LEVELING } from '../content/maps';
import { RAID_BY_ID, type RaidDef } from '../content/raids';
import {
  DESTINATION_POOLS,
  FAREWELL_LINES,
  MILESTONES,
  RENOWN_SOURCES,
  RENOWN_TIERS,
  RESIGNATION,
} from '../content/reputation';
import { RECRUIT } from '../content/recruit';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from './clock';
import { SimulationFacade } from './facade';
import { poolSpecForRung } from './recruit';
import { renownRung, rosterCapForRung, rungThreshold } from './reputation';
import type { GameState, GearItem, Member, Squad } from './state';

/**
 * T12 门面测试:声望(7 档 × 3 星)+ 荣誉墙 + 自动退会 + 名人堂。
 * 与全项目一致只打门面接缝:驱动 SimulationFacade / 纯函数 step 断言状态快照
 * 与事件日志;renownRung / poolSpecForRung 等为 sim 纯派生函数,按 T2 先例
 * 直接断言。40 人满编场景超出指令可达规模(起步名册上限 6),用合成状态
 * (SimulationFacade 的 resumeState 入参)驱动;数值断言全部用内容常量独立重算。
 */

const SEED = 20261018;
const RAID = RAID_BY_ID.get('molten-abyss') as RaidDef;
/** 第 7 档(服务器传奇)与满阶常量:7 档 × 3 星。 */
const TOP_TIER = RENOWN_TIERS[RENOWN_TIERS.length - 1]!;
const MAX_RUNG = RENOWN_TIERS.length * 3;

/** 合成团员:只填团本结算与功绩统计涉及的维度。 */
function synthMember(
  id: number,
  classId: string,
  specId: string,
  itemLevel: number,
  options?: { name?: string; level?: number; loyalty?: number },
): Member {
  return {
    id,
    isChairman: false,
    joinedAtGameMinutes: 0,
    benchDays: 0,
    name: options?.name ?? `合成团员${id}`,
    classId,
    specId,
    level: options?.level ?? 60,
    experience: 0,
    gear: GEAR_SLOTS.map((slot) => ({ slot, quality: '蓝' as const, itemLevel })) as GearItem[],
    mood: 80,
    loyalty: options?.loyalty ?? 80,
    personalGold: 0,
    dkp: 0,
    fatigue: 0,
    bossKills: 0,
    rareLootWon: 0,
    attendance: { styleId: 'iron', baseRate: 95 },
    traits: [],
    skillTierId: 'skilled',
  };
}

/** 标准小队:1 坦(战士·铁壁)+ 1 奶(牧师·圣言)+ 3 输出(法师三系)。 */
function standardSquadMembers(startId: number, itemLevel: number): Member[] {
  return [
    synthMember(startId, 'warrior', 'warrior-guard', itemLevel),
    synthMember(startId + 1, 'priest', 'priest-light', itemLevel),
    synthMember(startId + 2, 'mage', 'mage-arcane', itemLevel),
    synthMember(startId + 3, 'mage', 'mage-flame', itemLevel),
    synthMember(startId + 4, 'mage', 'mage-frost', itemLevel),
  ];
}

/**
 * 团本就绪状态(声望起点 = 0):8 支满员标准小队 + 会长角色(不在小队)+
 * 已开团;装等 80 ⇒ 全部首领处于必胜区间(含硬门槛 68),一夜全通确定。
 */
function raidNightState(itemLevel = 80): GameState {
  const base = new SimulationFacade(SEED, '声望测试公会').state;
  const members: Member[] = [];
  const squads: Squad[] = [];
  for (let squadIndex = 0; squadIndex < 8; squadIndex++) {
    const squadMembers = standardSquadMembers(squadIndex * 5 + 1, itemLevel);
    members.push(...squadMembers);
    squads.push({ id: squadIndex + 1, memberIds: squadMembers.map((member) => member.id) });
  }
  members.push(
    synthMember(41, 'rogue', 'rogue-venom', itemLevel, { name: '会长角色', level: 60 }),
  );
  const chairman = members.at(-1)!;
  members[members.length - 1] = { ...chairman, isChairman: true };
  return {
    ...base,
    members,
    nextMemberId: 42,
    squads,
    nextSquadId: 9,
    clockGameMinutes: GAME_MINUTES_PER_WEEK - 60, // 团本夜(周边界)前 60 分钟
    renownPoints: 0,
    raidPlan: { raidId: RAID.id, openedAtGameMinutes: GAME_MINUTES_PER_WEEK - 120 },
  };
}

describe('声望阶位:7 档 × 3 星(纯函数,数据面)', () => {
  it('档位表:7 档,阶位门槛严格单调,名册上限按档递增至 40(整编团队)', () => {
    expect(RENOWN_TIERS).toHaveLength(7);
    expect(MAX_RUNG).toBe(21);
    for (let rung = 1; rung <= MAX_RUNG; rung++) {
      expect(rungThreshold(rung)).toBeGreaterThan(rungThreshold(rung - 1));
    }
    // 声望值 → 阶位:负数归 0、超出封顶满阶
    expect(renownRung(-100)).toBe(0);
    expect(renownRung(rungThreshold(MAX_RUNG))).toBe(MAX_RUNG);
    expect(renownRung(10_000)).toBe(MAX_RUNG);
    // 名册上限联动:起步 6 人小会,满阶 40 人(团队 = 8 小队 × 5)
    expect(rosterCapForRung(0)).toBe(RECRUIT.baseRosterCap);
    expect(rosterCapForRung(MAX_RUNG)).toBe(40);
  });
});

describe('团本夜 → 声望与荣誉墙:首杀/里程碑/稀有驱动(验收标准 1 与 3)', () => {
  /** 跑一个全通夜(跨过周边界 60 分钟)。 */
  function runLegendaryNight(): { facade: SimulationFacade; output: ReturnType<SimulationFacade['dispatch']> } {
    const facade = new SimulationFacade(SEED, undefined, raidNightState());
    const output = facade.dispatch({ deltaGameMinutes: 60 });
    return { facade, output };
  }

  /** 独立重算:荣誉墙当前记录对应的声望加分(只用内容常量)。 */
  const earnedPointsOf = (state: GameState): number =>
    state.honorWall.firstKills.length * (RENOWN_SOURCES.firstKillPointsByRaidTier[RAID.tier - 1] ?? 0) +
    state.honorWall.milestones.reduce(
      (sum, record) => sum + (MILESTONES.find((def) => def.id === record.milestoneId)?.points ?? 0),
      0,
    );

  it('全通夜:每名首领留下首杀徽章(带日期),声望按内容表精确累加', () => {
    const { facade, output } = runLegendaryNight();
    const state = facade.state;
    expect(state.lastRaidNight!.cleared).toBe(true);

    // 首杀徽章:按结算顺序逐名入墙,带团本名与达成时刻(周边界)
    expect(state.honorWall.firstKills.map((badge) => badge.bossId)).toEqual(
      RAID.bosses.map((boss) => boss.id),
    );
    for (const badge of state.honorWall.firstKills) {
      expect(badge.raidName).toBe(RAID.name);
      expect(badge.bossName.length).toBeGreaterThan(0);
      expect(badge.atGameMinutes).toBe(GAME_MINUTES_PER_WEEK);
    }

    // 声望值 = 首杀加分 + 里程碑加分(独立重算;里程碑集合随掉落内容微变,按实得记录核算)
    expect(state.renownPoints).toBe(earnedPointsOf(state));
    const certain = ['avg-level-55', 'roster-40', 'first-max-level', 'first-raid-clear'];
    const earnedIds = state.honorWall.milestones.map((record) => record.milestoneId);
    for (const id of certain) {
      expect(earnedIds).toContain(id); // 60 级 41 人全通 ⇒ 这四项必达成
    }
    for (const record of state.honorWall.milestones) {
      expect(record.atGameMinutes).toBe(GAME_MINUTES_PER_WEEK); // 日期可追溯
    }

    // 事件面:首杀逐条公告、里程碑逐条公告、升档公告(含档名与名册上限)
    const renownEvents = output.events.filter((event) => event.kind === '声望');
    expect(renownEvents.filter((event) => event.text.includes('首杀!'))).toHaveLength(RAID.bosses.length);
    expect(renownEvents.some((event) => event.text.includes('里程碑达成:「首通团本」'))).toBe(true);
    expect(
      renownEvents.some((event) => event.text.includes('声望提升') && event.text.includes(TOP_TIER.name)),
    ).toBe(true);
  });

  it('档位与星级可见 + 名册上限联动:一夜全通直抵满阶,上限 6 → 40', () => {
    const { facade } = runLegendaryNight();
    const state = facade.state;
    expect(renownRung(state.renownPoints)).toBe(MAX_RUNG); // 满阶 = 第 7 档 3 星
    expect(state.rosterCap).toBe(rosterCapForRung(MAX_RUNG)); // 40(声望档位联动)
    expect(state.rosterCap).toBe(40);
  });

  it('稀有陈列:报告中穿上的紫装逐件入墙,持有人/来源/日期可追溯', () => {
    const { facade } = runLegendaryNight();
    const state = facade.state;
    const equippedPurples = state
      .lastRaidNight!.bosses.flatMap((boss) => boss.drops)
      .filter((drop) => drop.quality === '紫' && drop.equipped);
    expect(state.honorWall.rareDrops).toHaveLength(equippedPurples.length);
    for (const record of state.honorWall.rareDrops) {
      expect(record.quality).toBe('紫');
      expect(record.holder).toBe(equippedPurples.find((drop) => drop.slot === record.slot)?.assignedTo);
      expect(record.source).toBe(RAID.name);
      expect(record.atGameMinutes).toBe(GAME_MINUTES_PER_WEEK);
    }
    // 功绩联动:穿上紫装的团员 rareLootWon 计数与墙上一致(换装唯一入口计数)
    const purpleHolders = new Set(equippedPurples.map((drop) => drop.assignedTo));
    for (const member of state.members) {
      expect(member.rareLootWon).toBe(purpleHolders.has(member.name) ? 1 : 0);
    }
  });

  it('第二夜再战:首杀不重复入墙、不重复加分;击杀功绩继续累计', () => {
    const { facade } = runLegendaryNight();
    const renownAfterFirst = facade.state.renownPoints;
    const killsAfterFirst = RAID.bosses.length;

    facade.dispatch({ command: { type: 'openRaid', raidId: RAID.id }, deltaGameMinutes: 0 });
    const second = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    expect(facade.state.lastRaidNight!.cleared).toBe(true);

    expect(facade.state.honorWall.firstKills).toHaveLength(killsAfterFirst); // 徽章不重复
    expect(second.events.filter((event) => event.kind === '声望' && event.text.includes('首杀!'))).toHaveLength(0);
    expect(facade.state.renownPoints).toBe(renownAfterFirst); // 无新首杀/新里程碑:声望不变
    // 功绩统计:出席者每人参与击杀数翻倍(会长角色场下仍为 0)
    expect(facade.state.members.filter((member) => member.id <= 40).every((member) => member.bossKills === killsAfterFirst * 2)).toBe(true);
    expect(facade.state.members.find((member) => member.isChairman)!.bossKills).toBe(0);
  });
});

describe('申请池:声望阶位真值替换桩值(验收标准 2)', () => {
  it('建会(0 阶)与传奇夜后(满阶):池子数量与等级区间随阶位上台阶', () => {
    // 建会:0 阶规格(基础份数、基础等级区间)
    const fresh = new SimulationFacade(SEED, '星盾公会').state;
    const spec0 = poolSpecForRung(renownRung(fresh.renownPoints));
    expect(spec0.count).toBe(RECRUIT.poolCount.baseCount);
    expect(fresh.applicants).toHaveLength(spec0.count);
    expect(fresh.applicants.every((a) => a.profile.level >= spec0.levelRange[0])).toBe(true);

    // 传奇夜(周边界当天的池子用的还是夜前阶位)→ 次日按满阶规格刷新
    const facade = new SimulationFacade(SEED, undefined, raidNightState());
    const nightPool = facade.dispatch({ deltaGameMinutes: 60 }).state.applicants;
    expect(nightPool).toHaveLength(spec0.count); // 夜内结算的池子仍按 0 阶生成

    const nextDay = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    const specTop = poolSpecForRung(renownRung(facade.state.renownPoints));
    expect(renownRung(facade.state.renownPoints)).toBe(MAX_RUNG);
    expect(specTop.count).toBe(RECRUIT.poolCount.maxCount); // 份数到顶
    expect(specTop.count).toBeGreaterThan(spec0.count);
    expect(specTop.levelRange[0]).toBeGreaterThan(spec0.levelRange[0]); // 等级区间上移
    expect(facade.state.applicants).toHaveLength(specTop.count);
    expect(
      facade.state.applicants.every((a) => a.profile.level >= specTop.levelRange[0]),
    ).toBe(true);
    expect(nextDay.events.some((event) => event.kind === '招募' && event.text.includes(`${specTop.count} 名冒险者`))).toBe(true);
  });

  it('技艺档随阶位倾斜:满阶池的高技艺档权重高于 0 阶池(纯函数,见 recruit.test 详测)', () => {
    const top = poolSpecForRung(MAX_RUNG).skillTiers.find((tier) => tier.id === 'top')!;
    const base = poolSpecForRung(0).skillTiers.find((tier) => tier.id === 'top')!;
    expect(top.weight).toBeGreaterThan(base.weight);
  });
});

describe('里程碑:状态刻度达成即加分,且只达成一次(验收标准 1)', () => {
  it('公会平均等级达到 20:首日达成、次日不重复(声望精确等于内容表分值)', () => {
    const base = new SimulationFacade(SEED, '星盾公会').state;
    const members = base.members.map((member) => ({ ...member, level: 25 }));
    const facade = new SimulationFacade(SEED, undefined, { ...base, members });

    const first = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    const record = facade.state.honorWall.milestones.find((r) => r.milestoneId === 'avg-level-20');
    expect(record).toBeDefined();
    expect(record!.atGameMinutes).toBe(GAME_MINUTES_PER_DAY);
    expect(first.events.some((event) => event.kind === '声望' && event.text.includes('初具规模'))).toBe(true);
    // 本场景只有这一项达成(名册 6 人 < 10、无人满级、无下本/团本/紫装/金库收入)
    expect(facade.state.renownPoints).toBe(MILESTONES.find((def) => def.id === 'avg-level-20')!.points);

    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(facade.state.honorWall.milestones.filter((r) => r.milestoneId === 'avg-level-20')).toHaveLength(1);
    expect(facade.state.renownPoints).toBe(MILESTONES.find((def) => def.id === 'avg-level-20')!.points);
  });

  it('满级团员里程碑:等级达到 LEVELING.maxLevel 即达成', () => {
    const base = new SimulationFacade(SEED, '星盾公会').state;
    const members = base.members.map((member) => ({ ...member, level: LEVELING.maxLevel }));
    const facade = new SimulationFacade(SEED, undefined, { ...base, members });
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(facade.state.honorWall.milestones.map((r) => r.milestoneId)).toContain('first-max-level');
    // (同场景平均等级 60 ⇒ 三档等级里程碑一并达成,分值合计独立重算)
    const expected = ['avg-level-20', 'avg-level-40', 'avg-level-55', 'first-max-level'].reduce(
      (sum, id) => sum + MILESTONES.find((def) => def.id === id)!.points,
      0,
    );
    expect(facade.state.renownPoints).toBe(expected);
  });
});

describe('自动退会:长期冷板凳(验收标准 4)', () => {
  /** 建会后:会长角色 + 前 5 人编入唯一小队,第 6 人坐板凳。 */
  function benchSetup(): { facade: SimulationFacade; benched: Member } {
    const facade = new SimulationFacade(SEED, '星盾公会');
    facade.dispatch({ command: { type: 'createSquad' }, deltaGameMinutes: 0 });
    for (const member of facade.state.members.slice(0, 5)) {
      facade.dispatch({ command: { type: 'assignToSquad', memberId: member.id, squadId: 1 }, deltaGameMinutes: 0 });
    }
    const benched = facade.state.members.find((member) => member.id === 6)!;
    return { facade, benched };
  }

  it('阈值前一日仍在会;满 7 个待命游戏日自动退会,留台词与去向,入名人堂', () => {
    const { facade, benched } = benchSetup();

    // 第 6 个游戏日:计数 6 < 7,仍在会、无退会事件
    const before = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY * (RESIGNATION.benchDaysThreshold - 1) });
    expect(facade.state.members.some((member) => member.id === benched.id)).toBe(true);
    expect(facade.state.members.find((member) => member.id === benched.id)!.benchDays).toBe(
      RESIGNATION.benchDaysThreshold - 1,
    );
    expect(before.events.filter((event) => event.kind === '退会')).toHaveLength(0);

    // 第 7 个游戏日:自动退会(事件带台词与去向)
    const resigned = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    const events = resigned.events.filter((event) => event.kind === '退会');
    expect(events).toHaveLength(1);
    expect(events[0]!.atGameMinutes).toBe(GAME_MINUTES_PER_DAY * RESIGNATION.benchDaysThreshold);
    expect(events[0]!.text).toContain(`「${benched.name}」自动退会(长期冷板凳)`);
    expect(facade.state.members.some((member) => member.id === benched.id)).toBe(false);

    // 名人堂:去向与功绩留档(台词/去向来自内容池,确定性可复算)
    const entry = facade.state.hallOfFame.at(-1)!;
    expect(entry.memberId).toBe(benched.id);
    expect(entry.reason).toBe('长期冷板凳');
    expect(FAREWELL_LINES['长期冷板凳']).toContain(entry.farewell);
    expect(DESTINATION_POOLS).toContain(entry.destination);
    expect(events[0]!.text).toContain(entry.farewell);
    expect(events[0]!.text).toContain(entry.destination);
    expect(entry.bossKills).toBe(0);
    expect(entry.rareLootWon).toBe(0);
    expect(entry.joinedAtGameMinutes).toBe(0); // 建会元老
    expect(entry.leftAtGameMinutes).toBe(GAME_MINUTES_PER_DAY * RESIGNATION.benchDaysThreshold);
  });

  it('编入小队即清零计数:轮换上场不误伤', () => {
    const { facade } = benchSetup();
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY * (RESIGNATION.benchDaysThreshold - 1) });
    // 第 6 日把第 6 人编入小队(先腾位:调离一名队员到板凳)
    facade.dispatch({ command: { type: 'removeFromSquad', memberId: 5 }, deltaGameMinutes: 0 });
    facade.dispatch({ command: { type: 'assignToSquad', memberId: 6, squadId: 1 }, deltaGameMinutes: 0 });

    // 计数在日界结算时清零(指令时刻不回改历史计数)
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(facade.state.members.find((member) => member.id === 6)!.benchDays).toBe(0);

    // 再过一周:原第 6 人安然在会,顶替他坐板凳的第 5 人自动退会
    const week = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    const resignedIds = facade.state.hallOfFame.map((entry) => entry.memberId);
    expect(facade.state.members.some((member) => member.id === 6)).toBe(true);
    expect(resignedIds).toContain(5);
    expect(week.events.filter((event) => event.kind === '退会')).toHaveLength(1);
  });

  it('尚无小队的新会不计数:全员待命是常态,不触发退会', () => {
    const facade = new SimulationFacade(SEED, '星盾公会');
    const output = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY * (RESIGNATION.benchDaysThreshold + 3) });
    expect(output.events.filter((event) => event.kind === '退会')).toHaveLength(0);
    expect(facade.state.members).toHaveLength(6);
    expect(facade.state.members.every((member) => member.benchDays === 0)).toBe(true);
  });
});

describe('自动退会:忠诚不足(验收标准 4)', () => {
  it('忠诚 ≤ 阈值在日界退会;阈值之上不退;会长角色永不自动退会', () => {
    const base = new SimulationFacade(SEED, '星盾公会').state;
    // 会长角色压到 1(证明豁免)、第 2 人压到阈值、其余在阈值之上 1 点
    const members = base.members.map((member, index) => ({
      ...member,
      loyalty: member.isChairman ? 1 : index === 1 ? RESIGNATION.loyaltyThreshold : RESIGNATION.loyaltyThreshold + 1,
    }));
    const facade = new SimulationFacade(SEED, undefined, { ...base, members });
    const output = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });

    const events = output.events.filter((event) => event.kind === '退会');
    expect(events).toHaveLength(1); // 只有压到阈值的那名
    const entry = facade.state.hallOfFame.at(-1)!;
    expect(entry.reason).toBe('忠诚不足');
    expect(FAREWELL_LINES['忠诚不足']).toContain(entry.farewell);
    expect(DESTINATION_POOLS).toContain(entry.destination);
    // 会长角色(忠诚 1)仍在会:那是玩家自己的角色
    expect(facade.state.members.some((member) => member.isChairman)).toBe(true);
    // 阈值之上 1 点的团员不退会
    expect(facade.state.members.length).toBe(base.members.length - 1);
  });
});

describe('名人堂:离会即入堂(验收标准 4)', () => {
  it('会长淘汰的团员同样留档:去向、功绩与入会时长', () => {
    const facade = new SimulationFacade(SEED, '星盾公会');
    const target = facade.state.members.find((member) => !member.isChairman)!;
    facade.dispatch({ command: { type: 'dismissMember', memberId: target.id }, deltaGameMinutes: 0 });

    expect(facade.state.hallOfFame).toHaveLength(1);
    const entry = facade.state.hallOfFame[0]!;
    expect(entry.reason).toBe('会长淘汰');
    expect(entry.name).toBe(target.name);
    expect(entry.level).toBe(target.level);
    expect(FAREWELL_LINES['会长淘汰']).toContain(entry.farewell);
    expect(DESTINATION_POOLS).toContain(entry.destination);
    expect(entry.joinedAtGameMinutes).toBe(0);
    expect(entry.leftAtGameMinutes).toBe(0); // 建会当刻淘汰
  });

  it('招募入册的团员:入册时刻随档,离会时「在会时长」可追溯', () => {
    const facade = new SimulationFacade(SEED, '星盾公会');
    facade.dispatch({ command: { type: 'dismissMember', memberId: 2 }, deltaGameMinutes: 0 }); // 腾名额
    const applicant = facade.state.applicants[0]!;
    facade.dispatch({ command: { type: 'recruitApplicant', applicationId: applicant.applicationId }, deltaGameMinutes: 0 });
    const joined = facade.state.members.find((member) => member.name === applicant.profile.name)!;
    expect(joined.joinedAtGameMinutes).toBe(0);

    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY * 3 });
    facade.dispatch({ command: { type: 'dismissMember', memberId: joined.id }, deltaGameMinutes: 0 });
    const entry = facade.state.hallOfFame.at(-1)!;
    expect(entry.joinedAtGameMinutes).toBe(0);
    expect(entry.leftAtGameMinutes).toBe(GAME_MINUTES_PER_DAY * 3);
  });
});

describe('存档兼容:声望面随 v8 落盘(验收标准 3 的持久面)', () => {
  it('荣誉墙与名人堂随状态 round-trip;v7 旧档(桩值声望)迁移后补默认', async () => {
    const { decodeSave, encodeSave } = await import('./facade');
    const { facade } = (() => {
      const f = new SimulationFacade(SEED, undefined, raidNightState());
      f.dispatch({ deltaGameMinutes: 60 });
      return { facade: f };
    })();
    const state = facade.state;
    expect(state.honorWall.firstKills.length).toBeGreaterThan(0);

    const restored = decodeSave(encodeSave(state))!;
    expect(restored.honorWall).toEqual(state.honorWall);
    expect(restored.hallOfFame).toEqual(state.hallOfFame);
    expect(restored.renownPoints).toBe(state.renownPoints);

    // v7 旧档:剥掉声望面字段,还原 v7 时代的真实存档形状(桩值 reputation)
    const legacyState = JSON.parse(
      JSON.stringify(state, (key, value) =>
        key === 'honorWall' || key === 'hallOfFame' || key === 'renownPoints' || key === 'bossKills' ||
        key === 'rareLootWon' || key === 'joinedAtGameMinutes' || key === 'benchDays'
          ? undefined
          : value,
      ),
    );
    legacyState.reputation = 0; // v7 桩值(只减不涨,真实档恒为 0)
    const v7File = JSON.stringify({ version: 7, state: legacyState });
    const migrated = decodeSave(v7File)!;
    expect(migrated.renownPoints).toBe(0);
    expect(migrated.honorWall).toEqual({ firstKills: [], milestones: [], rareDrops: [] });
    expect(migrated.hallOfFame).toEqual([]);
    expect(migrated.members.every((member) => member.bossKills === 0 && member.rareLootWon === 0 && member.joinedAtGameMinutes === 0 && member.benchDays === 0)).toBe(true);
    // 迁移后直接可玩
    const resumed = new SimulationFacade(0, undefined, migrated);
    resumed.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(resumed.state.clockGameMinutes).toBe(state.clockGameMinutes + GAME_MINUTES_PER_DAY);
  });
});
