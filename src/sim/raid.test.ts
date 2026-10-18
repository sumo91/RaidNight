import { describe, expect, it } from 'vitest';
import { AURA_BY_CLASS, COMP } from '../content/comp';
import { DUNGEON_SETTLEMENT } from '../content/dungeons';
import { LOOT_SYSTEM_BY_ID, VAULT } from '../content/economy';
import { GEAR_SLOTS } from '../content/gear';
import { RAID_BY_ID, RAID_SETTLEMENT, RAIDS, type RaidDef } from '../content/raids';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from './clock';
import { SimulationFacade, decodeSave, encodeSave, step } from './facade';
import type { GameState, GearItem, Member, Squad } from './state';

/**
 * T10 门面测试:团本夜 —— 直播演出数据面 + 首领结算 + 团灭代价。
 * 与全项目一致只打门面接缝:驱动 SimulationFacade / 纔函数 step 断言状态快照
 * 与事件日志;settleRaidNight 等为 sim 纯函数,按 T2–T9 先例直接断言。
 * 40 人满编场景超出指令可达规模(名册上限 6),用合成状态(step 的 prev 入参)
 * 驱动;数值断言全部用内容常量独立重算(不复用结算实现的代码路径)。
 */

const SEED = 20261018;
const RAID = RAID_BY_ID.get('molten-abyss') as RaidDef;

/** 合成团员:只填团本结算涉及的维度(职业/专精给职能与光环,装备给战力)。 */
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
    level: options?.level ?? 60, // 等级只影响解锁刻度;结算战力只看装等
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

/** 团本就绪状态:8 支满员标准小队(40 人,团队检查通过)+ 会长角色(不在小队)。 */
function raidTeamState(
  itemLevel: number,
  options?: {
    seed?: number;
    mood?: number;
    fatigue?: number;
    vaultGold?: number;
    /** 缺省 = 已开团(直接填状态;开团指令路径另有专测)。 */
    plan?: boolean;
    planRaidId?: string;
  },
): GameState {
  const base = new SimulationFacade(options?.seed ?? SEED, '测试公会').state;
  const members: Member[] = [];
  const squads: Squad[] = [];
  for (let squadIndex = 0; squadIndex < COMP.teamCheck.requiredFullSquads; squadIndex++) {
    const squadMembers = standardSquadMembers(
      squadIndex * COMP.squadSize + 1,
      itemLevel,
    ).map((member) => ({
      ...member,
      mood: options?.mood ?? member.mood,
      fatigue: options?.fatigue ?? member.fatigue,
    }));
    members.push(...squadMembers);
    squads.push({ id: squadIndex + 1, memberIds: squadMembers.map((m) => m.id) });
  }
  // 会长角色不在任何小队:团本夜的一切结算不应波及
  const chairman = synthMember(41, 'rogue', 'rogue-venom', itemLevel, { name: '会长角色' });
  members.push({ ...chairman, isChairman: true });
  return {
    ...base,
    members,
    nextMemberId: 42,
    squads,
    nextSquadId: 9,
    clockGameMinutes: GAME_MINUTES_PER_WEEK - 60, // 团本夜(周边界)前 60 分钟
    vault: { gold: options?.vaultGold ?? VAULT.startingGold, repairSpent: 0, incomeTotal: 0 },
    raidPlan:
      options?.plan === false
        ? undefined
        : {
            raidId: options?.planRaidId ?? RAID.id,
            openedAtGameMinutes: GAME_MINUTES_PER_WEEK - 120,
          },
  };
}

/** 独立重算:标准编成的职能分(封顶计入)与光环覆盖(各队光环合计的平均)。 */
const STANDARD_ROLE_SCORE =
  Math.min(8, DUNGEON_SETTLEMENT.roleScore.tankCap) * DUNGEON_SETTLEMENT.roleScore.perTank +
  Math.min(8, DUNGEON_SETTLEMENT.roleScore.healerCap) * DUNGEON_SETTLEMENT.roleScore.perHealer +
  Math.min(24, DUNGEON_SETTLEMENT.roleScore.dpsCap) * DUNGEON_SETTLEMENT.roleScore.perDps;
const STANDARD_AURA_PERCENT = ['warrior', 'priest', 'mage'].reduce(
  (sum, classId) => sum + (AURA_BY_CLASS.get(classId)?.percent ?? 0),
  0,
);

/** 独立重算:全团同装等下的团队战力(统一结算引擎公式,只用内容常量)。 */
function expectedPower(itemLevel: number): number {
  return (itemLevel + STANDARD_ROLE_SCORE) * (1 + STANDARD_AURA_PERCENT / 100);
}

describe('团本内容表:数据驱动(硬门槛首领存在,验收标准 3 的数据面)', () => {
  it('首批团本在表:首领按顺序、数值为正、id 唯一', () => {
    expect(RAIDS.length).toBeGreaterThanOrEqual(1);
    expect(RAID.bosses.length).toBeGreaterThanOrEqual(2);
    const ids = new Set<string>();
    for (const boss of RAID.bosses) {
      expect(ids.has(boss.id)).toBe(false);
      ids.add(boss.id);
      expect(boss.difficultyTarget).toBeGreaterThan(0);
      expect(boss.dropsPerKill).toBeGreaterThan(0);
      expect(boss.dropItemLevel).toBeGreaterThan(0);
    }
    // 首领难度按顺序不下降(按首领顺序结算的阶梯意义)
    for (let i = 0; i + 1 < RAID.bosses.length; i++) {
      expect(RAID.bosses[i + 1]!.difficultyTarget).toBeGreaterThanOrEqual(
        RAID.bosses[i]!.difficultyTarget,
      );
    }
  });

  it('存在装等硬门槛首领(hardGateItemLevel)', () => {
    const gated = RAID.bosses.filter((boss) => boss.hardGateItemLevel !== undefined);
    expect(gated.length).toBeGreaterThanOrEqual(1);
    for (const boss of gated) {
      expect(boss.hardGateItemLevel!).toBeGreaterThan(RAID.unlock.averageItemLevel);  // 硬门槛高于解锁装等刻度
    }
  });
});

describe('开团指令:门槛裁决(验收标准 1)', () => {
  /** 命令可用状态:团队检查通过且内容门槛达标(装等 67 ≥ 40)。 */
  function commandReadyState(): GameState {
    return raidTeamState(67, { plan: false });
  }

  it('团队检查通过且已解锁:开团成立,安排进状态、事件入日志', () => {
    const state = commandReadyState();
    const output = step(state, {
      command: { type: 'openRaid', raidId: RAID.id },
      deltaGameMinutes: 0,
    });
    expect(output.state.raidPlan).toEqual({
      raidId: RAID.id,
      openedAtGameMinutes: state.clockGameMinutes,
    });
    expect(output.events.map((e) => [e.kind, e.text])).toEqual([
      ['团本', `已开团:「${RAID.name}」—— 团本夜定于周边界打响,按首领顺序逐个结算。`],
    ]);
  });

  it('团队检查未通过:不可开团(状态不变、无事件)', () => {
    const state = commandReadyState();
    // 第 8 小队抽走一人:满编不足,团队检查不通过
    const broken: GameState = {
      ...state,
      squads: state.squads.map((squad, i) =>
        i === 7 ? { ...squad, memberIds: squad.memberIds.slice(0, 4) } : squad,
      ),
    };
    const output = step(broken, { command: { type: 'openRaid', raidId: RAID.id }, deltaGameMinutes: 0 });
    expect(output.events).toEqual([]);
    expect(output.state.raidPlan).toBeUndefined();
  });

  it('内容阶梯未解锁(装等未达):不可开团;未知团本 id:忽略', () => {
    const lowGear = raidTeamState(20, { plan: false }); // 团本门槛装等 25
    const blocked = step(lowGear, { command: { type: 'openRaid', raidId: RAID.id }, deltaGameMinutes: 0 });
    expect(blocked.events).toEqual([]);
    expect(blocked.state.raidPlan).toBeUndefined();

    const unknown = step(commandReadyState(), {
      command: { type: 'openRaid', raidId: '不存在的团本' },
      deltaGameMinutes: 0,
    });
    expect(unknown.events).toEqual([]);
    expect(unknown.state.raidPlan).toBeUndefined();
  });

  it('重复开同一团本:无变化、无事件;取消开团清空安排', () => {
    const planned = raidTeamState(67); // 已带安排
    const again = step(planned, { command: { type: 'openRaid', raidId: RAID.id }, deltaGameMinutes: 0 });
    expect(again.events).toEqual([]);
    expect(again.state.raidPlan).toEqual(planned.raidPlan);

    const cancelled = step(planned, { command: { type: 'cancelRaid' }, deltaGameMinutes: 0 });
    expect(cancelled.state.raidPlan).toBeUndefined();
    expect(cancelled.events.map((e) => e.text)).toEqual(['取消开团安排,本周不开团。']);
    // 无安排时再取消:忽略
    expect(step(cancelled.state, { command: { type: 'cancelRaid' }, deltaGameMinutes: 0 }).events).toEqual([]);
  });
});

describe('团本夜:整夜结算的确定性与首领顺序(验收标准 1 与 6)', () => {
  /** 跨过周边界,触发一次团本夜(装等 55 ⇒ (55+27)×1.19 ≈ 98 ≥ 86+5:全通且掉落可穿戴)。 */
  function runNight(seed: number): { state: GameState; raidEvents: string[] } {
    const facade = new SimulationFacade(seed, undefined, raidTeamState(55, { seed }));
    const output = facade.dispatch({ deltaGameMinutes: 60 });
    return {
      state: facade.state,
      raidEvents: output.events.filter((e) => e.kind === '团本').map((e) => e.text),
    };
  }

  it('固定种子下,整夜结算产生完全相同的状态与日志(逐字节)', () => {
    const first = runNight(SEED);
    const second = runNight(SEED);
    expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state));
    expect(second.raidEvents).toEqual(first.raidEvents);
  });

  it('一次跨边界与分段推进等价:团本夜在周边界整夜结算,切分不改变结果', () => {
    const oneShot = new SimulationFacade(SEED, undefined, raidTeamState(55));
    const oneShotEvents = oneShot.dispatch({ deltaGameMinutes: 60 }).events;
    const chunked = new SimulationFacade(SEED, undefined, raidTeamState(55));
    const chunkedEvents = [
      ...chunked.dispatch({ deltaGameMinutes: 20 }).events,
      ...chunked.dispatch({ deltaGameMinutes: 20 }).events,
      ...chunked.dispatch({ deltaGameMinutes: 20 }).events,
    ];
    expect(JSON.stringify(chunked.state)).toBe(JSON.stringify(oneShot.state));
    expect(chunkedEvents).toEqual(oneShotEvents);
  });

  it('按首领顺序逐个结算:日志顺序 = 内容表首领顺序,周更在团本夜之后', () => {
    const facade = new SimulationFacade(SEED, undefined, raidTeamState(55));
    const output = facade.dispatch({ deltaGameMinutes: 60 });
    const texts = output.events.filter((e) => e.kind === '团本').map((e) => e.text);
    expect(texts[0]).toContain(`团本夜开始:「${RAID.name}」`);
    // 每名首领恰好一条击杀日志,且按内容表顺序出现
    const killLines = texts.filter((text) => text.includes('被击杀'));
    expect(killLines.map((text) => RAID.bosses.findIndex((b) => text.includes(`「${b.name}」`)))).toEqual(
      RAID.bosses.map((_, index) => index),
    );
    expect(texts.filter((text) => text.includes('全通'))).toHaveLength(1);
    // 收夜尾巴(T11):全通后的本夜分配小结是最后一条团本事件
    expect(texts.at(-1)).toContain('本夜分配:「会长裁量」');
    // 周更事件在全部团本事件之后(同一边界:夜结束 → 新一周 CD 重置)
    const kinds = output.events.filter((e) => e.kind === '团本' || e.kind === '周更').map((e) => e.kind);
    expect(kinds.indexOf('周更')).toBe(kinds.length - 1);
  });

  it('全通夜:报告结构完整(40 人阵容 + 逐首领结果),金库不动、士气小涨', () => {
    const { state } = runNight(SEED);
    const report = state.lastRaidNight!;
    expect(report.raidId).toBe(RAID.id);
    expect(report.cleared).toBe(true);
    expect(report.wipe).toBeUndefined();
    expect(report.repairGold).toBe(0);
    expect(report.lineup).toHaveLength(40); // 40 人点阵的数据面
    expect(report.lineup.filter((m) => m.role === '坦克')).toHaveLength(8);
    expect(report.lineup.filter((m) => m.role === '治疗')).toHaveLength(8);
    expect(report.teamItemLevel).toBe(55);
    expect(report.bosses.map((b) => b.killed)).toEqual(RAID.bosses.map(() => true));
    expect(state.vault).toEqual({ gold: VAULT.startingGold, repairSpent: 0, incomeTotal: 0 }); // 全通无修理支出;默认裁量制金币不流动
    // 全员:每次首领战积劳 8 × 5 次;士气 +clearMoodBoost;会长角色不受影响
    const raiders = state.members.filter((m) => m.id <= 40);
    for (const member of raiders) {
      expect(member.fatigue).toBe(RAID_SETTLEMENT.attemptFatiguePerBoss * RAID.bosses.length);
      expect(member.mood).toBe(80 + RAID_SETTLEMENT.clearMoodBoost);
    }
    const chairman = state.members.find((m) => m.isChairman)!;
    expect(chairman.fatigue).toBe(0);
    expect(chairman.mood).toBe(80);
    // 夜结束即清安排(CD = 游戏周,下周重新开团)
    expect(state.raidPlan).toBeUndefined();
  });

  it('胜者掉落本 tier 装备:全团择优穿戴,装等总量精确增长', () => {
    const { state } = runNight(SEED);
    const report = state.lastRaidNight!;
    const expectedDrops = RAID.bosses.reduce((sum, boss) => sum + boss.dropsPerKill, 0);
    const allDrops = report.bosses.flatMap((b) => b.drops);
    expect(allDrops.length).toBe(expectedDrops); // 件数 = 内容表配置
    const equipped = allDrops.filter((d) => d.equipped);
    expect(equipped.length).toBeGreaterThan(0);
    for (const drop of equipped) {
      expect(drop.assignedTo).toBeDefined();
      expect(drop.upgradeDelta!).toBeGreaterThan(0);
      expect(drop.itemLevel).toBeGreaterThanOrEqual(
        Math.min(...RAID.bosses.map((b) => b.dropItemLevel)) - 1,
      ); // 掉落装等来自本 tier 基准
    }
    // 装等总量独立重算:基础 40 人 × 8 部位 × 80 + 全部换装提升之和
    const gearSum = (members: readonly Member[]) =>
      members.reduce((sum, m) => sum + m.gear.reduce((s, item) => s + item.itemLevel, 0), 0);
    const before = 40 * 8 * 55;
    const delta = equipped.reduce((sum, d) => sum + d.upgradeDelta!, 0);
    expect(gearSum(state.members.filter((m) => m.id <= 40))).toBe(before + delta);
    // 换上装备的团员装备总量确实高于起始(逐件装等和,不受展示取整影响)
    const upgraded = state.members.filter(
      (m) => m.id <= 40 && m.gear.reduce((s, item) => s + item.itemLevel, 0) > 8 * 55,
    );
    expect(upgraded.length).toBeGreaterThan(0);
    expect(new Set(equipped.map((d) => d.assignedTo)).size).toBe(upgraded.length); // 去向人数一致
  });
});

describe('硬门槛首领:装等不达标必败,无论战力(验收标准 3)', () => {
  /** 装等 34:战力对第 3 首领本有胜算,但硬门槛 36 未达 ⇒ 必败团灭。 */
  function wipeNight(): { state: GameState; raidEvents: string[] } {
    const facade = new SimulationFacade(SEED, undefined, raidTeamState(34));
    const output = facade.dispatch({ deltaGameMinutes: 60 });
    return {
      state: facade.state,
      raidEvents: output.events.filter((e) => e.kind === '团本').map((e) => e.text),
    };
  }

  it('硬门槛首领:战力未入必败区间,胜率却被硬门槛压为 0 ⇒ 团灭', () => {
    const { state, raidEvents } = wipeNight();
    const report = state.lastRaidNight!;
    const gateBossIndex = RAID.bosses.findIndex((b) => b.hardGateItemLevel !== undefined)!;
    const gateBoss = RAID.bosses[gateBossIndex]!;

    // 前排首领按顺序击杀(必胜区间,确定)
    for (let i = 0; i < gateBossIndex; i++) {
      expect(report.bosses[i]!.killed).toBe(true);
    }
    const gate = report.bosses[gateBossIndex]!;
    expect(gate.killed).toBe(false);
    expect(gate.hardGateMet).toBe(false);
    expect(gate.successChance).toBe(0);
    expect(gate.band).toBe('必败');
    // 战力本有胜算(未入「必败」区间):胜率归零只能来自硬门槛
    expect(gate.power).toBeCloseTo(expectedPower(34), 5);
    expect(gate.power).toBeGreaterThan(gate.target - DUNGEON_SETTLEMENT.failMargin);
    expect(gate.drops).toEqual([]); // 团灭无掉落
    expect(gate.fallen).toBe(40); // 团灭 = 全员倒下(点阵数据)

    // 报告与日志的止步信息一致
    expect(report.cleared).toBe(false);
    expect(report.wipe).toEqual({
      bossIndex: gateBossIndex + 1,
      bossName: gateBoss.name,
      repairGold: RAID_SETTLEMENT.wipeRepairGoldPerRaider * 40,
      fatigue: RAID_SETTLEMENT.wipeFatigue,
      moodHit: RAID_SETTLEMENT.wipeMoodHit,
    });
    expect(raidEvents.some((t) => t.includes(`团灭于「${gateBoss.name}」`) && t.includes('硬门槛'))).toBe(true);
  });

  it('装等达标后硬门槛放行:同一首领被击杀(开荒推进)', () => {
    // 装等 42:第 3、4 首领必胜区间(战力 (42+27)×1.19 ≈ 82 ≥ 75),硬门槛 36 已达
    const facade = new SimulationFacade(SEED, undefined, raidTeamState(42));
    facade.dispatch({ deltaGameMinutes: 60 });
    const report = facade.state.lastRaidNight!;
    const gateBossIndex = RAID.bosses.findIndex((b) => b.hardGateItemLevel !== undefined)!;
    expect(report.bosses[gateBossIndex]!.hardGateMet).toBe(true);
    expect(report.bosses[gateBossIndex]!.killed).toBe(true);
  });
});

describe('团灭代价与最小金库(验收标准 4 与 5)', () => {
  it('团灭付出修理金/疲劳/士气,数值精确等于内容表配置', () => {
    const facade = new SimulationFacade(SEED, undefined, raidTeamState(34));
    facade.dispatch({ deltaGameMinutes: 60 });
    const state = facade.state;
    const attempts = 3; // 击杀 2 名首领 + 第 3 名团灭那次尝试

    // 最小金库:余额扣修理金,修理支出累计
    const repair = RAID_SETTLEMENT.wipeRepairGoldPerRaider * 40;
    expect(state.vault).toEqual({ gold: VAULT.startingGold - repair, repairSpent: repair, incomeTotal: 0 });
    expect(state.lastRaidNight!.repairGold).toBe(repair);

    // 疲劳 = 每次首领战 × 尝试次数 + 团灭额外;士气 = 打击值(会长角色不受影响)
    for (const member of state.members.filter((m) => m.id <= 40)) {
      expect(member.fatigue).toBe(
        RAID_SETTLEMENT.attemptFatiguePerBoss * attempts + RAID_SETTLEMENT.wipeFatigue,
      );
      expect(member.mood).toBe(80 - RAID_SETTLEMENT.wipeMoodHit);
    }
    const chairman = state.members.find((m) => m.isChairman)!;
    expect(chairman.fatigue).toBe(0);
    expect(chairman.mood).toBe(80);
  });

  it('无永久损失:名册不动、忠诚只按制度微调、装备只增不减', () => {
    const before = raidTeamState(34);
    const facade = new SimulationFacade(SEED, undefined, structuredClone(before));
    facade.dispatch({ deltaGameMinutes: 60 });
    const after = facade.state;

    // 默认制度 = 会长裁量(T11):出席者忠诚每夜 −2(内容表),会长角色不波动
    const discretionDelta = LOOT_SYSTEM_BY_ID.get('chairman')!.attendeeLoyaltyPerNight;
    expect(after.members.map((m) => m.loyalty)).toEqual(
      before.members.map((m) => (m.isChairman ? m.loyalty : m.loyalty + discretionDelta)),
    );
    expect(after.members.map((m) => m.id)).toEqual(before.members.map((m) => m.id)); // 无人退会
    expect(after.members.map((m) => m.personalGold)).toEqual(before.members.map(() => 0)); // 裁量制金币不流动
    expect(after.members.map((m) => m.level)).toEqual(before.members.map((m) => m.level));
    expect(after.members.map((m) => m.experience)).toEqual(before.members.map((m) => m.experience));
    for (const member of after.members) {
      expect(member.gear).toHaveLength(8); // 8 部位一件不少
      for (const item of member.gear) {
        expect(item.itemLevel).toBeGreaterThanOrEqual(34); // 装备只被更好的替换,从不丢失
      }
    }
  });

  it('金库余额不足:修理金按余额封顶实付(不清零为负)', () => {
    const facade = new SimulationFacade(SEED, undefined, raidTeamState(34, { vaultGold: 50 }));
    facade.dispatch({ deltaGameMinutes: 60 });
    expect(facade.state.vault).toEqual({ gold: 0, repairSpent: 50, incomeTotal: 0 });
    expect(facade.state.lastRaidNight!.wipe!.repairGold).toBe(50); // 报告记实付
  });

  it('金库见底:团灭照样发生,实付 0(代价面保留疲劳与士气)', () => {
    const facade = new SimulationFacade(SEED, undefined, raidTeamState(34, { vaultGold: 0 }));
    facade.dispatch({ deltaGameMinutes: 60 });
    expect(facade.state.vault).toEqual({ gold: 0, repairSpent: 0, incomeTotal: 0 });
    expect(facade.state.lastRaidNight!.cleared).toBe(false);
    expect(facade.state.members[0]!.mood).toBe(80 - RAID_SETTLEMENT.wipeMoodHit);
  });
});

describe('团本 CD 与夜取消(验收标准 1 与 6)', () => {
  it('开团指令与时间增量同一步输入:指令先生效,当步跨边界即整夜结算', () => {
    const facade = new SimulationFacade(SEED, undefined, raidTeamState(55, { plan: false }));
    const output = facade.dispatch({
      command: { type: 'openRaid', raidId: RAID.id },
      deltaGameMinutes: 60,
    });
    expect(facade.state.lastRaidNight!.cleared).toBe(true);
    expect(facade.state.raidPlan).toBeUndefined(); // 夜结束安排即清
    expect(output.events.filter((e) => e.kind === '团本').length).toBeGreaterThan(3);
  });

  it('团本 CD = 游戏周:夜结束后,未重新开团则下一周边界无团本事件', () => {
    const facade = new SimulationFacade(SEED, undefined, raidTeamState(55));
    facade.dispatch({ deltaGameMinutes: 60 }); // 第 1 夜(全通)
    const nextWeek = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    expect(nextWeek.events.filter((e) => e.kind === '团本')).toEqual([]);
    expect(facade.state.lastRaidNight!.cleared).toBe(true); // 报告保留为最近一夜
    // 重新开团后,下一个周边界再度开打(开荒/伐木循环)
    facade.dispatch({ command: { type: 'openRaid', raidId: RAID.id }, deltaGameMinutes: 0 });
    const secondNight = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    expect(secondNight.events.filter((e) => e.kind === '团本').length).toBeGreaterThan(3);
  });

  it('开团后阵容散架:夜取消(不算团灭、不付代价、不消费额外随机)', () => {
    const broken = raidTeamState(55);
    const squads = broken.squads.map((squad, i) =>
      i === 7 ? { ...squad, memberIds: squad.memberIds.slice(0, 4) } : squad,
    );
    const facade = new SimulationFacade(SEED, undefined, { ...broken, squads });
    const output = facade.dispatch({ deltaGameMinutes: 60 });
    const texts = output.events.filter((e) => e.kind === '团本').map((e) => e.text);
    expect(texts).toEqual([
      `团本夜取消:团队检查未通过(满员小队不足:7/${COMP.teamCheck.requiredFullSquads} 支),补齐编成后下周再战。`,
    ]);
    expect(facade.state.lastRaidNight).toBeUndefined(); // 未开打,无报告
    expect(facade.state.vault).toEqual({ gold: VAULT.startingGold, repairSpent: 0, incomeTotal: 0 }); // 不付代价
    expect(facade.state.members.every((m) => m.mood === 80 && m.fatigue === 0)).toBe(true);
    expect(facade.state.raidPlan).toBeUndefined(); // 安排随夜清空
  });

  it('开团后名册回落到门槛之下:夜取消并说明未达标项', () => {
    // 直接构造:装等 20 < 团本门槛 25 的已开团状态(夜结算时的门槛复核)
    const facade = new SimulationFacade(SEED, undefined, raidTeamState(20));
    const output = facade.dispatch({ deltaGameMinutes: 60 });
    const texts = output.events.filter((e) => e.kind === '团本').map((e) => e.text);
    expect(texts[0]).toContain(`团本夜取消:「${RAID.name}」门槛未达`);
    expect(texts[0]).toContain('公会平均装等 25');
    expect(facade.state.lastRaidNight).toBeUndefined();
    expect(facade.state.vault.gold).toBe(VAULT.startingGold);
  });
});

describe('存档兼容:最小金库随 v6 落盘(验收标准 5 的持久面)', () => {
  it('金库与开团安排随状态序列化;round-trip 后团本夜继续可结算', () => {
    const state = raidTeamState(55);
    const restored = decodeSave(encodeSave(state))!;
    expect(restored).toEqual(state);
    expect(restored.vault).toEqual({ gold: VAULT.startingGold, repairSpent: 0, incomeTotal: 0 });
    const facade = new SimulationFacade(0, undefined, restored);
    facade.dispatch({ deltaGameMinutes: 60 });
    expect(facade.state.lastRaidNight!.cleared).toBe(true);
  });

  it('v5 旧档(无金库)迁移后补建会起始余额,可直接继续玩', () => {
    const state = raidTeamState(55);
    // 剥掉金库,还原 v5 时代的真实存档形状
    const legacyState = JSON.parse(
      JSON.stringify(state, (key, value) => (key === 'vault' ? undefined : value)),
    );
    const v5File = JSON.stringify({ version: 5, state: legacyState });
    const migrated = decodeSave(v5File)!;
    expect(migrated.vault).toEqual({ gold: VAULT.startingGold, repairSpent: 0, incomeTotal: 0 });
    const facade = new SimulationFacade(0, undefined, migrated);
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY }); // 推进一日不抛错
    expect(facade.state.clockGameMinutes).toBe(state.clockGameMinutes + GAME_MINUTES_PER_DAY);
  });
});
