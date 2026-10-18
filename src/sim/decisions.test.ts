import { describe, expect, it } from 'vitest';
import { AURA_BY_CLASS, COMP } from '../content/comp';
import {
  CONSUMABLE_TIER_BY_ID,
  WORLD_BUFF_BY_ID,
  type ConsumableTierId,
  type RaidStanceId,
  type WorldBuffId,
} from '../content/raid-tactics';
import { DUNGEON_SETTLEMENT } from '../content/dungeons';
import { VAULT } from '../content/economy';
import { GEAR_SLOTS } from '../content/gear';
import { RAID_BY_ID, RAID_SETTLEMENT, type RaidDef } from '../content/raids';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from './clock';
import { SimulationFacade, decodeSave, encodeSave, SAVE_VERSION, step } from './facade';
import type { GameState, GearItem, Member, RaidTactics, Squad } from './state';

/**
 * T14 门面测试:开荒决策面 —— 消耗品预算 / 世界 Buff / 编成微调。
 * 验收标准:
 * 1. 三项决策赛前可设置且影响当夜结算;
 * 2. 消耗品/世界 Buff 花费走金库并有时效(指令时扣款,只对当夜生效);
 * 3. 决策收益幅度足以左右边际胜负;
 * 4. 同一编成不同决策组合的结果差异。
 * 与全项目一致只打门面接缝:驱动 SimulationFacade / 纯函数 step 断言状态快照
 * 与事件日志;40 人满编场景超出指令可达规模(名册上限 6),用合成状态
 * (step 的 prev 入参)驱动;数值断言全部用内容常量独立重算
 * (不复用结算实现的代码路径,式同 sim/encounter.ts 的文档公式)。
 */

const SEED = 20261018;
const RAID = RAID_BY_ID.get('molten-abyss') as RaidDef;
/** 第 5 首领(最高难度 116):边际胜负的判定基准。 */
const FINAL_BOSS = RAID.bosses[RAID.bosses.length - 1]!;
/** 第 4 首领(难度 112):悬念区间的判定基准。 */
const FOURTH_BOSS = RAID.bosses[3]!;

/** 合成团员:只填团本结算涉及的维度(同 raid.test.ts 的合成口径)。 */
function synthMember(
  id: number,
  classId: string,
  specId: string,
  itemLevel: number,
  options?: { level?: number; mood?: number; fatigue?: number; name?: string },
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
    mood: options?.mood ?? 80,
    loyalty: 80,
    personalGold: 0,
    dkp: 0,
    fatigue: options?.fatigue ?? 0,
    attendance: { styleId: 'iron', baseRate: 95 },
    traits: [],
    skillTierId: 'skilled',
    bossKills: 0,
    rareLootWon: 0,
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
 * 团本就绪状态:8 支满员标准小队(40 人,团队检查通过)+ 会长角色(不在小队)。
 * 缺省时钟 = 周边界前 60 分钟(跨一步即整夜结算);可调到本周更早
 * (世界 Buff 的筹备时长测试需要不同的启用提前量)。
 */
function raidTeamState(
  itemLevel: number,
  options?: {
    seed?: number;
    vaultGold?: number;
    /** 缺省 = 已开团;false = 未开团(指令忽略路径)。 */
    plan?: boolean;
    /** 缺省 = 周边界前 60 分钟;世界 Buff 筹备测试传入更早的时刻。 */
    clockGameMinutes?: number;
    /** 直接填入开团安排的赛前决策(结算路径测试);指令路径另有专测。 */
    tactics?: RaidTactics;
    /** 抽走第 8 小队一人:团队检查不通过(夜取消路径)。 */
    brokenSquad?: boolean;
  },
): GameState {
  const base = new SimulationFacade(options?.seed ?? SEED, '测试公会').state;
  const members: Member[] = [];
  const squads: Squad[] = [];
  for (let squadIndex = 0; squadIndex < COMP.teamCheck.requiredFullSquads; squadIndex++) {
    const squadMembers = standardSquadMembers(squadIndex * COMP.squadSize + 1, itemLevel);
    members.push(...squadMembers);
    squads.push({ id: squadIndex + 1, memberIds: squadMembers.map((m) => m.id) });
  }
  const chairman = synthMember(41, 'rogue', 'rogue-venom', itemLevel, { name: '会长角色' });
  members.push({ ...chairman, isChairman: true });
  const clock = options?.clockGameMinutes ?? GAME_MINUTES_PER_WEEK - 60;
  return {
    ...base,
    members,
    nextMemberId: 42,
    squads: options?.brokenSquad
      ? squads.map((squad, i) => (i === 7 ? { ...squad, memberIds: squad.memberIds.slice(0, 4) } : squad))
      : squads,
    nextSquadId: 9,
    clockGameMinutes: clock,
    vault: { gold: options?.vaultGold ?? VAULT.startingGold, repairSpent: 0, incomeTotal: 0 },
    raidPlan:
      options?.plan === false
        ? undefined
        : {
            raidId: RAID.id,
            openedAtGameMinutes: clock - 60,
            tactics: options?.tactics,
          },
  };
}

// ———— 独立重算(只用内容常量,式同统一结算引擎的文档公式)————

/** 标准编成的职能分:坦 2×3 + 奶 2×3 + 输出 3×5(封顶计入)。 */
const STANDARD_ROLE_SCORE =
  Math.min(8, DUNGEON_SETTLEMENT.roleScore.tankCap) * DUNGEON_SETTLEMENT.roleScore.perTank +
  Math.min(8, DUNGEON_SETTLEMENT.roleScore.healerCap) * DUNGEON_SETTLEMENT.roleScore.perHealer +
  Math.min(24, DUNGEON_SETTLEMENT.roleScore.dpsCap) * DUNGEON_SETTLEMENT.roleScore.perDps;
/** 标准编成的光环覆盖:战士 6 + 牧师 8 + 法师 5(每队同款,平均即每队值)。 */
const STANDARD_AURA_PERCENT = ['warrior', 'priest', 'mage'].reduce(
  (sum, classId) => sum + (AURA_BY_CLASS.get(classId)?.percent ?? 0),
  0,
);

/** 无决策时的团队战力:(装等 + 职能分) × (1 + 光环%)。 */
function expectedBasePower(itemLevel: number): number {
  return (itemLevel + STANDARD_ROLE_SCORE) * (1 + STANDARD_AURA_PERCENT / 100);
}

/** 三段式胜率:≤ 目标−failMargin 必败、≥ 目标+winMargin 必胜、之间线性。 */
function expectedChance(power: number, target: number): number {
  const lower = target - DUNGEON_SETTLEMENT.failMargin;
  const upper = target + DUNGEON_SETTLEMENT.winMargin;
  return Math.max(0, Math.min(1, (power - lower) / (upper - lower)));
}

/** 跑一个团本夜:从给定状态推进到(并跨过)下一个周边界。 */
function runNight(state: GameState, deltaGameMinutes?: number) {
  const facade = new SimulationFacade(state.seed, undefined, state);
  const output = facade.dispatch({
    deltaGameMinutes: deltaGameMinutes ?? GAME_MINUTES_PER_WEEK - state.clockGameMinutes,
  });
  return {
    state: facade.state,
    events: output.events,
    raidEvents: output.events.filter((e) => e.kind === '团本').map((e) => e.text),
  };
}

// ———— 验收标准 1 与 2:三项决策赛前可设置(指令裁决与金库扣款)————

describe('消耗品预算指令:拨款走金库(验收标准 1 与 2)', () => {
  it('开团后设定:金库扣款、决策入安排、事件入日志', () => {
    const state = raidTeamState(68);
    const tier = CONSUMABLE_TIER_BY_ID.get('standard')!;
    const output = step(state, {
      command: { type: 'setConsumableBudget', tier: 'standard' },
      deltaGameMinutes: 0,
    });
    expect(output.state.vault.gold).toBe(VAULT.startingGold - tier.costGold);
    expect(output.state.raidPlan?.tactics?.consumableTier).toBe('standard');
    expect(output.events.map((e) => [e.kind, e.text])).toEqual([
      [
        '团本',
        `开荒采购:金库拨款 ${tier.costGold} 金购入「${tier.name}」,当夜全团战力 +${tier.powerBonusPercent}%。`,
      ],
    ]);
  });

  it('未开团 / 未知档位 / 同档重复 / 金库不足:一律忽略(状态不变、无事件)', () => {
    const noPlan = step(raidTeamState(68, { plan: false }), {
      command: { type: 'setConsumableBudget', tier: 'standard' },
      deltaGameMinutes: 0,
    });
    expect(noPlan.events).toEqual([]);
    expect(noPlan.state.vault.gold).toBe(VAULT.startingGold);

    const unknown = step(raidTeamState(68), {
      command: { type: 'setConsumableBudget', tier: '不存在的档' as ConsumableTierId },
      deltaGameMinutes: 0,
    });
    expect(unknown.events).toEqual([]);

    const once = step(raidTeamState(68), {
      command: { type: 'setConsumableBudget', tier: 'frugal' },
      deltaGameMinutes: 0,
    });
    const again = step(once.state, {
      command: { type: 'setConsumableBudget', tier: 'frugal' },
      deltaGameMinutes: 0,
    });
    expect(again.events).toEqual([]); // 同档重复:不重复拨款
    expect(again.state.vault.gold).toBe(once.state.vault.gold);

    const broke = step(raidTeamState(68, { vaultGold: 100 }), {
      command: { type: 'setConsumableBudget', tier: 'lavish' }, // 300 金 > 余额 100
      deltaGameMinutes: 0,
    });
    expect(broke.events).toEqual([]);
    expect(broke.state.vault.gold).toBe(100);
  });

  it('换档再全额拨款、此前不退(事件注明作废)', () => {
    const state = raidTeamState(68);
    const frugal = CONSUMABLE_TIER_BY_ID.get('frugal')!;
    const lavish = CONSUMABLE_TIER_BY_ID.get('lavish')!;
    const first = step(state, { command: { type: 'setConsumableBudget', tier: 'frugal' }, deltaGameMinutes: 0 });
    const second = step(first.state, { command: { type: 'setConsumableBudget', tier: 'lavish' }, deltaGameMinutes: 0 });
    expect(second.state.vault.gold).toBe(VAULT.startingGold - frugal.costGold - lavish.costGold);
    expect(second.state.raidPlan?.tactics?.consumableTier).toBe('lavish');
    expect(second.events[0]?.text).toContain('此前拨款作废');
  });
});

describe('世界 Buff 指令:拨款 + 筹备时长(验收标准 1 与 2)', () => {
  it('开团后启用:金库扣款、记录启用时刻、事件入日志', () => {
    const state = raidTeamState(68);
    const def = WORLD_BUFF_BY_ID.get('war-drums')!;
    const output = step(state, {
      command: { type: 'armWorldBuff', buffId: 'war-drums' },
      deltaGameMinutes: 0,
    });
    expect(output.state.vault.gold).toBe(VAULT.startingGold - def.costGold);
    expect(output.state.raidPlan?.tactics?.worldBuffs).toEqual([
      { buffId: 'war-drums', armedAtGameMinutes: state.clockGameMinutes },
    ]);
    expect(output.events.map((e) => e.text)).toEqual([
      `世界Buff 启用:「${def.name}」—— 金库拨款 ${def.costGold} 金启程筹备,需 ${def.prepGameDays} 个游戏日;团本夜前备妥则当夜战力 +${def.powerBonusPercent}%。`,
    ]);
  });

  it('未开团 / 未知 Buff / 重复启用 / 金库不足:一律忽略', () => {
    const noPlan = step(raidTeamState(68, { plan: false }), {
      command: { type: 'armWorldBuff', buffId: 'dragon-hymn' },
      deltaGameMinutes: 0,
    });
    expect(noPlan.events).toEqual([]);

    const unknown = step(raidTeamState(68), {
      command: { type: 'armWorldBuff', buffId: '不存在的buff' as WorldBuffId },
      deltaGameMinutes: 0,
    });
    expect(unknown.events).toEqual([]);

    const once = step(raidTeamState(68), { command: { type: 'armWorldBuff', buffId: 'moonwell-blessing' }, deltaGameMinutes: 0 });
    const again = step(once.state, { command: { type: 'armWorldBuff', buffId: 'moonwell-blessing' }, deltaGameMinutes: 0 });
    expect(again.events).toEqual([]); // 重复启用:不重复拨款
    expect(again.state.vault.gold).toBe(once.state.vault.gold);

    const broke = step(raidTeamState(68, { vaultGold: 50 }), {
      command: { type: 'armWorldBuff', buffId: 'war-drums' },
      deltaGameMinutes: 0,
    });
    expect(broke.events).toEqual([]);
    expect(broke.state.vault.gold).toBe(50);
  });
});

describe('编成微调指令:阵形入安排(验收标准 1)', () => {
  it('开团后设定:阵形入安排、事件入日志', () => {
    const output = step(raidTeamState(68), {
      command: { type: 'setRaidStance', stance: 'aura-weave' },
      deltaGameMinutes: 0,
    });
    expect(output.state.raidPlan?.tactics?.stance).toBe('aura-weave');
    expect(output.events.map((e) => [e.kind, e.text])).toEqual([
      ['团本', '编成微调:团本夜改用「光环串联」—— 全团按光环重新落位,职能分工让一点,团队协同涨一截。'],
    ]);
  });

  it('未开团 / 未知阵形 / 同阵形重复:一律忽略', () => {
    const noPlan = step(raidTeamState(68, { plan: false }), {
      command: { type: 'setRaidStance', stance: 'spearhead' },
      deltaGameMinutes: 0,
    });
    expect(noPlan.events).toEqual([]);

    const unknown = step(raidTeamState(68), {
      command: { type: 'setRaidStance', stance: '不存在的阵形' as never },
      deltaGameMinutes: 0,
    });
    expect(unknown.events).toEqual([]);

    const once = step(raidTeamState(68), { command: { type: 'setRaidStance', stance: 'bulwark' }, deltaGameMinutes: 0 });
    const again = step(once.state, { command: { type: 'setRaidStance', stance: 'bulwark' }, deltaGameMinutes: 0 });
    expect(again.events).toEqual([]);
    expect(again.state.raidPlan?.tactics?.stance).toBe('bulwark');
  });
});

// ———— 验收标准 3 与 4:同一编成,不同决策组合 ⇒ 当夜结算结果差异 ————

/** 装等 68(硬门槛 68 达标):第 4/5 首领处悬念区间 —— 决策的边际胜负带。 */
const MARGINAL_ILVL = 36;

describe('消耗品预算:增益计入当夜结算(验收标准 3 与 4)', () => {
  it('无决策基线:第 4/5 首领的胜率 = 独立重算(悬念区间)', () => {
    const { state } = runNight(raidTeamState(MARGINAL_ILVL));
    const report = state.lastRaidNight!;
    const base = expectedBasePower(MARGINAL_ILVL);
    for (const boss of report.bosses) {
      expect(boss.power).toBeCloseTo(base, 5);
      expect(boss.successChance).toBeCloseTo(expectedChance(base, boss.target), 5);
    }
    expect(report.bosses[3]!.band).toBe('悬念');
    expect(report.tactics).toBeUndefined(); // 未做决策:报告无决策快照
  });

  it('同编成同种子:标配采买把全部首领推入必胜 ⇒ 当夜全通(结果差异)', () => {
    // 路线 A:无决策直接开打
    const bare = runNight(raidTeamState(MARGINAL_ILVL));
    // 路线 B:赛前拨款标配采买(+8%),再开打(指令与时间增量同一步:指令先生效)
    const stocked = new SimulationFacade(SEED, undefined, raidTeamState(MARGINAL_ILVL));
    stocked.dispatch({
      command: { type: 'setConsumableBudget', tier: 'standard' },
      deltaGameMinutes: 0,
    });
    stocked.dispatch({ deltaGameMinutes: 60 });
    const boosted = stocked.state.lastRaidNight!;

    // 数值面:战力 = 基线 × (1 + 8%),每个首领的胜率独立重算
    const boostedPower = expectedBasePower(MARGINAL_ILVL) * 1.08;
    for (const boss of boosted.bosses) {
      expect(boss.power).toBeCloseTo(boostedPower, 5);
      expect(boss.successChance).toBeCloseTo(expectedChance(boostedPower, boss.target), 5);
    }
    expect(boosted.tactics?.consumable?.bonusPercent).toBe(8);
    expect(boosted.tactics?.bonusPowerPercent).toBe(8);
    expect(boosted.bosses.every((boss) => boss.successChance === 1)).toBe(true);
    expect(boosted.cleared).toBe(true); // 全首领必胜 ⇒ 确定性全通

    // 结果差异(验收标准 4):无决策的当夜胜率明显更低,战果不同
    expect(bare.state.lastRaidNight!.bosses[3]!.successChance).toBeCloseTo(
      expectedChance(expectedBasePower(MARGINAL_ILVL), FOURTH_BOSS.difficultyTarget),
      5,
    );
    expect(bare.state.lastRaidNight!.bosses[3]!.successChance).toBeLessThan(1);
    expect(bare.state.lastRaidNight!.cleared).toBe(false); // 同种子下,边际区间无决策 ⇒ 止步
    expect(stocked.state.vault.gold).toBe(VAULT.startingGold - CONSUMABLE_TIER_BY_ID.get('standard')!.costGold);
  });

  it('决策收益幅度:一档拨款足以把悬念首领翻成必胜(左右边际胜负)', () => {
    // 省着用(+4%)也足以把第 4 首领(胜率 0.605)推入必胜(≥ 目标+5)
    const { state } = runNight(
      raidTeamState(MARGINAL_ILVL, { tactics: { consumableTier: 'frugal' } }),
    );
    const frugalPower = expectedBasePower(MARGINAL_ILVL) * 1.04;
    expect(state.lastRaidNight!.bosses[3]!.power).toBeCloseTo(frugalPower, 5);
    expect(state.lastRaidNight!.bosses[3]!.successChance).toBe(1);
    expect(state.lastRaidNight!.bosses[3]!.band).toBe('必胜');
  });
});

describe('编成微调:四种阵形的取舍各有方向(验收标准 1、3 与 4)', () => {
  it('同编成换阵形:战力 = 各阵形系数的独立重算,方向符合取舍', () => {
    const cases: readonly { stance: RaidStanceId | undefined }[] = [
      { stance: undefined },
      { stance: 'spearhead' },
      { stance: 'bulwark' },
      { stance: 'aura-weave' },
    ];
    const powers = cases.map((entry) => {
      const { state } = runNight(
        raidTeamState(MARGINAL_ILVL, {
          tactics: entry.stance === undefined ? undefined : { stance: entry.stance },
        }),
      );
      return state.lastRaidNight!.bosses[0]!.power;
    });

    // 独立重算:标准编成(坦 6 分 / 奶 6 分 / 输出 15 分,光环 19%)
    const role = DUNGEON_SETTLEMENT.roleScore;
    const tankScore = Math.min(8, role.tankCap) * role.perTank;
    const healerScore = Math.min(8, role.healerCap) * role.perHealer;
    const dpsScore = Math.min(24, role.dpsCap) * role.perDps;
    const expected = {
      balanced: expectedBasePower(MARGINAL_ILVL),
      spearhead:
        (MARGINAL_ILVL + tankScore + healerScore * 0.6 + dpsScore * 1.35) * (1 + STANDARD_AURA_PERCENT / 100),
      bulwark:
        (MARGINAL_ILVL + tankScore * 1.3 + healerScore * 1.25 + dpsScore * 0.75) * (1 + STANDARD_AURA_PERCENT / 100),
      auraWeave:
        (MARGINAL_ILVL + (tankScore + healerScore + dpsScore) * 0.85) *
        (1 + (STANDARD_AURA_PERCENT * 1.6) / 100),
    };
    expect(powers[0]).toBeCloseTo(expected.balanced, 5);
    expect(powers[1]).toBeCloseTo(expected.spearhead, 5);
    expect(powers[2]).toBeCloseTo(expected.bulwark, 5);
    expect(powers[3]).toBeCloseTo(expected.auraWeave, 5);

    // 取舍方向(标准输出编成):串联 > 锋矢 > 常规 > 铁壁 —— 有得必有失,没有全赢的阵
    expect(expected.auraWeave).toBeGreaterThan(expected.balanced);
    expect(expected.spearhead).toBeGreaterThan(expected.balanced);
    expect(expected.bulwark).toBeLessThan(expected.balanced);
    // 报告快照记录当夜阵形
    const weave = runNight(raidTeamState(MARGINAL_ILVL, { tactics: { stance: 'aura-weave' } }));
    expect(weave.state.lastRaidNight!.tactics?.stance.name).toBe('光环串联');
    expect(weave.raidEvents.some((t) => t.includes('赛前决策生效:阵形「光环串联」'))).toBe(true);
  });
});

// ———— 验收标准 2:时效 —— 就绪判定与当夜清空 ————

describe('世界 Buff 的时效:筹备时长判定(验收标准 2)', () => {
  it('提前 5 个游戏日启用龙裔战歌(需 5 日):备妥生效,增益计入当夜', () => {
    const clock = GAME_MINUTES_PER_WEEK - 5 * GAME_MINUTES_PER_DAY;
    const state = raidTeamState(MARGINAL_ILVL, { clockGameMinutes: clock });
    const facade = new SimulationFacade(state.seed, undefined, state);
    facade.dispatch({ command: { type: 'armWorldBuff', buffId: 'dragon-hymn' }, deltaGameMinutes: 0 });
    const output = facade.dispatch({ deltaGameMinutes: 5 * GAME_MINUTES_PER_DAY });
    const report = facade.state.lastRaidNight!;

    expect(report.tactics?.worldBuffs).toHaveLength(1);
    expect(report.tactics?.worldBuffs[0]?.ready).toBe(true); // 恰好 5 日 ≥ 5 日
    expect(report.tactics?.bonusPowerPercent).toBe(WORLD_BUFF_BY_ID.get('dragon-hymn')!.powerBonusPercent);
    const hymnPower = expectedBasePower(MARGINAL_ILVL) * 1.1;
    expect(report.bosses[4]!.power).toBeCloseTo(hymnPower, 5);
    expect(report.bosses[4]!.successChance).toBeCloseTo(
      expectedChance(hymnPower, FINAL_BOSS.difficultyTarget),
      5,
    );
    expect(report.cleared).toBe(true); // +10% ⇒ 全首领必胜,确定性全通
    expect(facade.state.vault.gold).toBe(VAULT.startingGold - WORLD_BUFF_BY_ID.get('dragon-hymn')!.costGold);
    expect(
      output.events.some((e) => e.text.includes('赛前决策生效:世界Buff「龙裔战歌」+10%;当夜战力增益合计 +10%。')),
    ).toBe(true);
  });

  it('临夜 1 日才启用龙裔战歌:未及备妥,当夜无效但金库已扣(时效成本)', () => {
    const clock = GAME_MINUTES_PER_WEEK - GAME_MINUTES_PER_DAY;
    const state = raidTeamState(MARGINAL_ILVL, { clockGameMinutes: clock });
    const facade = new SimulationFacade(state.seed, undefined, state);
    facade.dispatch({ command: { type: 'armWorldBuff', buffId: 'dragon-hymn' }, deltaGameMinutes: 0 });
    const output = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    const report = facade.state.lastRaidNight!;

    expect(report.tactics?.worldBuffs[0]?.ready).toBe(false);
    expect(report.tactics?.worldBuffs[0]?.bonusPercent).toBe(0);
    expect(report.tactics?.bonusPowerPercent).toBe(0);
    // 战力回到基线(增益未生效):本夜出战的每个首领都是基线战力与基线胜率
    // (止步于第几个首领取决于掷点,不据此断言)
    const base = expectedBasePower(MARGINAL_ILVL);
    for (const boss of report.bosses) {
      expect(boss.power).toBeCloseTo(base, 5);
      expect(boss.successChance).toBeCloseTo(expectedChance(base, boss.target), 5);
    }
    // 金库照扣(启用金 + 本夜团灭修理金,若止步)+ 点名作废的事件
    const repair = report.cleared ? 0 : RAID_SETTLEMENT.wipeRepairGoldPerRaider * 40;
    expect(facade.state.vault.gold).toBe(
      VAULT.startingGold - WORLD_BUFF_BY_ID.get('dragon-hymn')!.costGold - repair,
    );
    const texts = output.events.filter((e) => e.kind === '团本').map((e) => e.text);
    expect(texts.some((t) => t.includes('赛前决策生效:无战力增益。'))).toBe(true);
    expect(texts.some((t) => t.includes('「龙裔战歌」未及备妥') && t.includes('拨款 260 金已花'))).toBe(true);
  });

  it('战鼓余音(需 1 日)临夜启用:恰好来得及,小额增益生效', () => {
    const clock = GAME_MINUTES_PER_WEEK - GAME_MINUTES_PER_DAY;
    const state = raidTeamState(MARGINAL_ILVL, { clockGameMinutes: clock });
    const facade = new SimulationFacade(state.seed, undefined, state);
    facade.dispatch({ command: { type: 'armWorldBuff', buffId: 'war-drums' }, deltaGameMinutes: 0 });
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    const report = facade.state.lastRaidNight!;
    expect(report.tactics?.worldBuffs[0]?.ready).toBe(true);
    expect(report.tactics?.bonusPowerPercent).toBe(WORLD_BUFF_BY_ID.get('war-drums')!.powerBonusPercent);
  });
});

describe('决策的时效:随团本夜清空,次周重新决策(验收标准 2)', () => {
  it('第一夜带决策全通后,次周未重新决策 ⇒ 战力回基线、报告无决策快照', () => {
    const state = raidTeamState(MARGINAL_ILVL);
    const facade = new SimulationFacade(state.seed, undefined, state);
    facade.dispatch({
      command: { type: 'setConsumableBudget', tier: 'standard' },
      deltaGameMinutes: 0,
    });
    facade.dispatch({ deltaGameMinutes: 60 });
    expect(facade.state.lastRaidNight!.cleared).toBe(true);
    expect(facade.state.raidPlan).toBeUndefined(); // 夜结束安排即清

    // 次周:重新开团但不做任何决策
    facade.dispatch({ command: { type: 'openRaid', raidId: RAID.id }, deltaGameMinutes: 0 });
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    const second = facade.state.lastRaidNight!;
    // 第一夜的掉落已穿在身上:次周团队装等高于合成基线(报告的阵容快照即当时真值)
    const week2Base = (second.teamItemLevel + STANDARD_ROLE_SCORE) * (1 + STANDARD_AURA_PERCENT / 100);
    expect(second.teamItemLevel).toBeGreaterThan(MARGINAL_ILVL);
    expect(second.tactics).toBeUndefined(); // 决策不跨周残留
    for (const boss of second.bosses) {
      expect(boss.power).toBeCloseTo(week2Base, 5);
    }
    expect(second.bosses[3]!.successChance).toBeCloseTo(
      expectedChance(week2Base, FOURTH_BOSS.difficultyTarget),
      5,
    );
  });

  it('取消开团:本周采购作废的事件可见,金库不退(浪费是决策成本)', () => {
    const state = raidTeamState(MARGINAL_ILVL);
    const facade = new SimulationFacade(state.seed, undefined, state);
    facade.dispatch({ command: { type: 'setConsumableBudget', tier: 'frugal' }, deltaGameMinutes: 0 });
    facade.dispatch({ command: { type: 'armWorldBuff', buffId: 'war-drums' }, deltaGameMinutes: 0 });
    const output = facade.dispatch({ command: { type: 'cancelRaid' }, deltaGameMinutes: 0 });

    const spent = CONSUMABLE_TIER_BY_ID.get('frugal')!.costGold + WORLD_BUFF_BY_ID.get('war-drums')!.costGold;
    expect(facade.state.vault.gold).toBe(VAULT.startingGold - spent); // 不退
    expect(facade.state.raidPlan).toBeUndefined();
    const texts = output.events.filter((e) => e.kind === '团本').map((e) => e.text);
    expect(texts).toContain('取消开团安排,本周不开团。');
    expect(texts.some((t) => t.includes(`本周赛前采购 ${spent} 金`) && t.includes('作废'))).toBe(true);

    // 重新开团:安排是全新的(无残留决策)
    facade.dispatch({ command: { type: 'openRaid', raidId: RAID.id }, deltaGameMinutes: 0 });
    expect(facade.state.raidPlan?.tactics).toBeUndefined();
  });

  it('开团后阵容散架:夜取消,本周采购作废(同上,取消路径的浪费提示)', () => {
    const spent = CONSUMABLE_TIER_BY_ID.get('frugal')!.costGold + WORLD_BUFF_BY_ID.get('war-drums')!.costGold;
    const state = raidTeamState(MARGINAL_ILVL, { brokenSquad: true });
    const facade = new SimulationFacade(state.seed, undefined, state);
    facade.dispatch({ command: { type: 'setConsumableBudget', tier: 'frugal' }, deltaGameMinutes: 0 });
    facade.dispatch({ command: { type: 'armWorldBuff', buffId: 'war-drums' }, deltaGameMinutes: 0 });
    const output = facade.dispatch({ deltaGameMinutes: 60 });

    expect(facade.state.lastRaidNight).toBeUndefined(); // 夜取消,无报告
    expect(facade.state.vault.gold).toBe(VAULT.startingGold - spent);
    const texts = output.events.filter((e) => e.kind === '团本').map((e) => e.text);
    expect(texts[0]).toContain('团本夜取消:团队检查未通过');
    expect(texts.some((t) => t.includes(`本周赛前采购 ${spent} 金随夜取消作废`))).toBe(true);
  });
});

// ———— 确定性与存档 ————

describe('确定性与存档:决策面随状态落盘(验收标准 2 的持久面)', () => {
  it('固定种子:同决策同输入 ⇒ 逐字节相同的状态与日志', () => {
    const build = () => raidTeamState(MARGINAL_ILVL, { tactics: { consumableTier: 'lavish', stance: 'spearhead' } });
    const first = runNight(build());
    const second = runNight(build());
    expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state));
    expect(second.raidEvents).toEqual(first.raidEvents);
  });

  it('存档 round-trip:赛前决策原样保留,恢复后当夜继续可结算', () => {
    const state = raidTeamState(MARGINAL_ILVL, {
      tactics: {
        consumableTier: 'standard',
        worldBuffs: [{ buffId: 'war-drums', armedAtGameMinutes: GAME_MINUTES_PER_WEEK - 3 * GAME_MINUTES_PER_DAY }],
        stance: 'aura-weave',
      },
    });
    const restored = decodeSave(encodeSave(state))!;
    expect(restored.raidPlan?.tactics).toEqual(state.raidPlan?.tactics);
    expect(JSON.parse(encodeSave(state)).version).toBe(SAVE_VERSION);
    const facade = new SimulationFacade(0, undefined, restored);
    facade.dispatch({ deltaGameMinutes: 60 });
    expect(facade.state.lastRaidNight!.tactics?.bonusPowerPercent).toBe(
      CONSUMABLE_TIER_BY_ID.get('standard')!.powerBonusPercent + WORLD_BUFF_BY_ID.get('war-drums')!.powerBonusPercent,
    );
  });

  it('v9 旧档(开团安排无决策字段):解码可用,视为未做决策', () => {
    const state = raidTeamState(MARGINAL_ILVL, { tactics: { consumableTier: 'lavish' } });
    // 还原 v9 时代的真实存档形状:raidPlan 无 tactics 字段
    const legacyState = JSON.parse(
      JSON.stringify(state, (key, value) => (key === 'tactics' ? undefined : value)),
    );
    const migrated = decodeSave(JSON.stringify({ version: 9, state: legacyState }))!;
    expect(migrated.raidPlan?.tactics).toBeUndefined();
    expect(migrated.raidPlan?.raidId).toBe(RAID.id);
    const facade = new SimulationFacade(0, undefined, migrated);
    facade.dispatch({ deltaGameMinutes: 60 });
    const base = expectedBasePower(MARGINAL_ILVL);
    expect(facade.state.lastRaidNight!.bosses[0]!.power).toBeCloseTo(base, 5); // 按无决策结算
  });
});

// ———— 数值面联动:决策不改变分配制度与团灭代价的原有语义 ————

describe('决策夜的制度与代价面不受污染(回归护栏)', () => {
  it('带决策的团灭夜:修理金照内容表按人头计,分配小结仍是最后一条团本事件', () => {
    // 装等 68 + 省着用(+4%):第 4 首领必胜、第 5 首领胜率 0.657(悬念)
    const { state, raidEvents } = runNight(
      raidTeamState(MARGINAL_ILVL, { tactics: { consumableTier: 'frugal' } }),
    );
    const report = state.lastRaidNight!;
    // 若本夜团灭:修理金 = 每人 3 金 × 40 人(金库足额),与 T10 语义一致
    if (!report.cleared) {
      expect(report.wipe?.repairGold).toBe(3 * 40);
      expect(state.vault.repairSpent).toBe(3 * 40);
    }
    // 夜末分配小结(制度心态)始终收尾,决策宣告只出现在开夜阶段
    expect(raidEvents.at(-1)).toContain('本夜分配:');
    expect(report.loot?.system).toBe('chairman');
  });

  it('未达硬门槛的编成:决策增益救不了装等门槛(硬门槛语义不被决策绕过)', () => {
    // 装等 34(硬门槛 36 未达)+ 全力开荒 +14%:战力足够,仍必败于硬门槛首领
    const { state } = runNight(
      raidTeamState(34, { tactics: { consumableTier: 'lavish' } }),
    );
    const report = state.lastRaidNight!;
    const gateIndex = RAID.bosses.findIndex((boss) => boss.hardGateItemLevel !== undefined)!;
    const gate = report.bosses[gateIndex]!;
    expect(gate.hardGateMet).toBe(false);
    expect(gate.killed).toBe(false);
    expect(gate.successChance).toBe(0);
    expect(report.cleared).toBe(false);
  });
});
