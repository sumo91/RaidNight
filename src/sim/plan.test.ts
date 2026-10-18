import { describe, expect, it } from 'vitest';
import { COMP } from '../content/comp';
import { LOOT_SYSTEM_BY_ID, VAULT } from '../content/economy';
import { GEAR_SLOTS } from '../content/gear';
import {
  DEFAULT_WEEKLY_GOAL,
  WEEKLY_GOAL_BY_ID,
  WEEKLY_GOALS,
} from '../content/plan';
import { RAID_BY_ID, RAID_SETTLEMENT, type RaidDef } from '../content/raids';
import { GAME_MINUTES_PER_WEEK } from './clock';
import { distributeRaidDrop } from './economy';
import { SimulationFacade, decodeSave, encodeSave, step } from './facade';
import type { SimEvent } from './events';
import { nextRaidNight } from './schedule';
import type { GameState, GearItem, Member, Squad, WeeklyPlan } from './state';

/**
 * T15 门面测试:计划层 —— 每周开团安排与目标。
 * 与全项目一致只打门面接缝(会长指令 + 时间跳变 ⇒ 状态快照 + 事件日志);
 * 掉落分配的周目标钩子按 T2–T10 先例对 sim 纯函数直接断言。
 * 40 人满编场景超出指令可达规模(名册上限 6),用合成状态(step 的 prev 入参)驱动;
 * 装等取 90:标准编成战力 (90+27)×1.19 ≈ 139 ≥ 最难首领 116+5 ⇒ 三段式必胜,
 * 全通与掉落件数(3+3+3+3+4=16)完全确定,便于精确断言。
 */

const SEED = 20261018;
const RAID = RAID_BY_ID.get('molten-abyss') as RaidDef;
/** 全通一夜的掉落总件数(内容表:5 首领 3+3+3+3+4;必胜 ⇒ 确定)。 */
const DROPS_PER_FULL_CLEAR = RAID.bosses.reduce((sum, boss) => sum + boss.dropsPerKill, 0);

/** 合成团员:只填团本结算涉及的维度(职业/专精给职能与光环,装备给战力)。 */
function synthMember(
  id: number,
  classId: string,
  specId: string,
  gear: readonly GearItem[],
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
    gear,
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
  const gear = () => GEAR_SLOTS.map((slot) => ({ slot, quality: '蓝' as const, itemLevel })) as GearItem[];
  return [
    synthMember(startId, 'warrior', 'warrior-guard', gear()),
    synthMember(startId + 1, 'priest', 'priest-light', gear()),
    synthMember(startId + 2, 'mage', 'mage-arcane', gear()),
    synthMember(startId + 3, 'mage', 'mage-flame', gear()),
    synthMember(startId + 4, 'mage', 'mage-frost', gear()),
  ];
}

/**
 * 计划就绪状态:8 支满员标准小队(40 人,团队检查通过)+ 会长角色(不在小队),
 * 时钟停在第一个周边界前 60 分钟。缺省不带周计划与开团安排(各测试自行注入)。
 * breakTeamCheck:末队只编 4 人、缺的第五人恰好是会长角色 —— 团队检查不过,
 * 且补编用 assignToSquad 即可(会长角色不编队只积累冷板凳日,不会自动退会)。
 */
function planReadyState(
  options?: {
    seed?: number;
    itemLevel?: number;
    vaultGold?: number;
    weeklyPlan?: WeeklyPlan;
    raidPlan?: boolean;
    /** 末队缺一人(缺的是会长角色):团队检查不过(暂缓路径用)。 */
    breakTeamCheck?: boolean;
  },
): GameState {
  const base = new SimulationFacade(options?.seed ?? SEED, '测试公会').state;
  const itemLevel = options?.itemLevel ?? 90;
  const members: Member[] = [];
  const squads: Squad[] = [];
  const squadCount = COMP.teamCheck.requiredFullSquads;
  for (let squadIndex = 0; squadIndex < squadCount; squadIndex++) {
    const squadMembers = standardSquadMembers(squadIndex * COMP.squadSize + 1, itemLevel);
    members.push(...squadMembers);
    squads.push({
      id: squadIndex + 1,
      memberIds: squadMembers.map((m) => m.id),
      // 暂缓变体:末队抽走第五人(那是会长角色的位置)
      ...(options?.breakTeamCheck === true && squadIndex === squadCount - 1
        ? { memberIds: squadMembers.slice(0, 4).map((m) => m.id) }
        : {}),
    });
  }
  // 会长角色:不出战(不受团本夜波及);暂缓变体下他就是末队缺的那个人
  const chairmanGear = GEAR_SLOTS.map((slot) => ({ slot, quality: '蓝' as const, itemLevel })) as GearItem[];
  const chairman: Member = {
    ...synthMember(41, 'rogue', 'rogue-venom', chairmanGear, { name: '会长角色' }),
    isChairman: true,
    loyalty: 100, // 会长角色忠诚恒为 100(MemberProfile 约定)
  };
  members.push(chairman);
  return {
    ...base,
    members,
    nextMemberId: 42,
    squads,
    nextSquadId: 9,
    clockGameMinutes: GAME_MINUTES_PER_WEEK - 60, // 团本夜(周边界)前 60 分钟
    vault: { gold: options?.vaultGold ?? VAULT.startingGold, repairSpent: 0, incomeTotal: 0 },
    raidPlan: options?.raidPlan === true ? { raidId: RAID.id, openedAtGameMinutes: GAME_MINUTES_PER_WEEK - 120 } : undefined,
    weeklyPlan: options?.weeklyPlan,
  };
}

describe('周计划指令:设定与取消(验收标准 1)', () => {
  it('设定周计划写入状态,本周尚未开团时自动层立即照计划开团', () => {
    const state = planReadyState();
    const out = step(state, {
      command: { type: 'setWeeklyPlan', goal: 'progress', raidId: RAID.id },
      deltaGameMinutes: 0,
    });

    // 状态:常驻计划写入 + 本周安排立即排上(自动开团)
    expect(out.state.weeklyPlan).toEqual({
      goal: 'progress',
      raidId: RAID.id,
      setAtGameMinutes: state.clockGameMinutes,
    });
    expect(out.state.raidPlan).toEqual({
      raidId: RAID.id,
      openedAtGameMinutes: state.clockGameMinutes,
    });
    // 事件:设定 + 自动开团各一条
    expect(out.events.map((e) => e.kind)).toEqual(['团本', '团本']);
    expect(out.events[0]?.text).toContain('周计划设定');
    expect(out.events[0]?.text).toContain('推进');
    expect(out.events[1]?.text).toContain('自动层按周计划开团');
    expect(out.events[1]?.text).toContain(RAID.name);
  });

  it('同计划重复设定:无变化、无事件;未知目标或团本被忽略', () => {
    const armed = step(planReadyState(), {
      command: { type: 'setWeeklyPlan', goal: 'progress', raidId: RAID.id },
      deltaGameMinutes: 0,
    }).state;
    const again = step(armed, {
      command: { type: 'setWeeklyPlan', goal: 'progress', raidId: RAID.id },
      deltaGameMinutes: 0,
    });
    expect(again.events).toEqual([]);
    expect(again.state).toEqual(armed);

    const badGoal = step(planReadyState(), {
      command: { type: 'setWeeklyPlan', goal: 'nope' as WeeklyPlan['goal'], raidId: RAID.id },
      deltaGameMinutes: 0,
    });
    expect(badGoal.events).toEqual([]);
    expect(badGoal.state.weeklyPlan).toBeUndefined();
    const badRaid = step(planReadyState(), {
      command: { type: 'setWeeklyPlan', goal: 'progress', raidId: 'not-a-raid' },
      deltaGameMinutes: 0,
    });
    expect(badRaid.state.weeklyPlan).toBeUndefined();
  });

  it('取消周计划:模板移除,本周已开的团不受影响', () => {
    const armed = step(planReadyState(), {
      command: { type: 'setWeeklyPlan', goal: 'farm', raidId: RAID.id },
      deltaGameMinutes: 0,
    }).state;
    const cleared = step(armed, { command: { type: 'clearWeeklyPlan' }, deltaGameMinutes: 0 });
    expect(cleared.state.weeklyPlan).toBeUndefined();
    expect(cleared.state.raidPlan).toEqual(armed.raidPlan); // 本周安排保留
    expect(cleared.events).toHaveLength(1);
    expect(cleared.events[0]?.text).toContain('周计划已取消');
    // 再取消(本就没有):忽略
    const again = step(cleared.state, { command: { type: 'clearWeeklyPlan' }, deltaGameMinutes: 0 });
    expect(again.events).toEqual([]);
  });

  it('内容表:三种当周目标在表,数值钩子可调', () => {
    expect(WEEKLY_GOALS.map((goal) => goal.id)).toEqual(['progress', 'farm', 'mentor']);
    for (const goal of WEEKLY_GOALS) {
      expect(WEEKLY_GOAL_BY_ID.get(goal.id)).toBe(goal);
      expect(goal.name.length).toBeGreaterThan(0);
      expect(goal.lootTilt === 'none' || goal.lootTilt === 'lowestItemLevel').toBe(true);
    }
    // farm 才有卖店钩子;带新才有倾斜钩子(取向差异的数据面)
    expect(WEEKLY_GOAL_BY_ID.get('farm')!.salvageGoldPerDrop).toBeGreaterThan(0);
    expect(WEEKLY_GOAL_BY_ID.get('mentor')!.lootTilt).toBe('lowestItemLevel');
    expect(DEFAULT_WEEKLY_GOAL).toBe('progress');
  });
});

describe('自动层执行:跨周计划的执行轨迹(验收标准 2、4)', () => {
  /** 轨迹脚本:常驻计划就绪(本周尚未开团),此后零指令连推三周。 */
  function runThreeWeeks(goal: WeeklyPlan['goal']): { state: GameState; events: SimEvent[] } {
    let state = planReadyState({
      weeklyPlan: { goal, raidId: RAID.id, setAtGameMinutes: 0 },
    });
    const events: SimEvent[] = [];
    for (let week = 0; week < 3; week++) {
      const out = step(state, { deltaGameMinutes: GAME_MINUTES_PER_WEEK });
      state = out.state;
      events.push(...out.events);
    }
    return { state, events };
  }

  it('设定一次计划,连推三周:每周自动开团、夜结算、下周再排,无需逐场手动', () => {
    const { state, events } = runThreeWeeks('progress');

    // 轨迹:三个周边界各有一条自动开团;第 1 周尚无安排(计划直接注入,未及开团),
    // 第 2、3 周各打满一夜(周边界 2W、3W)
    const autoOpens = events.filter((e) => e.text.includes('自动层按周计划开团'));
    expect(autoOpens).toHaveLength(3);
    expect(autoOpens.map((e) => e.atGameMinutes)).toEqual([
      GAME_MINUTES_PER_WEEK,
      GAME_MINUTES_PER_WEEK * 2,
      GAME_MINUTES_PER_WEEK * 3,
    ]);
    const nightStarts = events.filter((e) => e.text.includes('团本夜开始'));
    expect(nightStarts.map((e) => e.atGameMinutes)).toEqual([
      GAME_MINUTES_PER_WEEK * 2,
      GAME_MINUTES_PER_WEEK * 3,
    ]);
    // 每夜全通(装等 90 ⇒ 必胜;「全通:」带冒号只匹配夜结算行,不误伤里程碑文案)
    expect(events.filter((e) => e.text.includes('全通:'))).toHaveLength(2);
    expect(state.lastRaidNight?.atGameMinutes).toBe(GAME_MINUTES_PER_WEEK * 3);
    expect(state.lastRaidNight?.cleared).toBe(true);
    expect(state.lastRaidNight?.goal).toEqual({ id: 'progress', name: '推进' });
    // 夜结束即重排:第 4 周的安排已在第 3 周边界上排好
    expect(state.raidPlan).toEqual({
      raidId: RAID.id,
      openedAtGameMinutes: GAME_MINUTES_PER_WEEK * 3,
    });
    // 出席轨迹:两夜全通,每名出战团员功绩 +10(5 首领 × 2 夜;会长角色不在小队不受影响)
    const attendee = state.members.find((m) => m.id === 1)!;
    expect(attendee.bossKills).toBe(10);
    const chairman = state.members.find((m) => m.isChairman)!;
    expect(chairman.bossKills).toBe(0);
  });

  it('推进目标的夜末心态:出席者忠诚与心情按内容表叠加(独立重算)', () => {
    const { state } = runThreeWeeks('progress');
    const goal = WEEKLY_GOAL_BY_ID.get('progress')!;
    const system = LOOT_SYSTEM_BY_ID.get('chairman')!; // 新会默认裁量制
    // 两夜全通后的期望:心情 = 基线 + (全通士气 + 制度心情 + 目标心情)×2;忠诚同式(制度 −2、目标 +2 抵消)
    const expectedMood = 80 + (RAID_SETTLEMENT.clearMoodBoost + system.attendeeMoodPerNight + goal.attendeeMoodPerNight) * 2;
    const expectedLoyalty = 80 + (system.attendeeLoyaltyPerNight + goal.attendeeLoyaltyPerNight) * 2;
    const attendee = state.members.find((m) => m.id === 1)!;
    expect(attendee.mood).toBe(expectedMood);
    expect(attendee.loyalty).toBe(expectedLoyalty);
    // 会长角色不出战:心态不动
    const chairman = state.members.find((m) => m.isChairman)!;
    expect(chairman.mood).toBe(80);
    expect(chairman.loyalty).toBe(100);
  });

  it('farm 目标的夜内钩子:无人可提升的掉落全部卖店,金库按件入账', () => {
    // 先用指令开计划(本周立即排上),再跨一个周边界 ⇒ 一夜全通
    let state = planReadyState({ vaultGold: 1000 });
    state = step(state, {
      command: { type: 'setWeeklyPlan', goal: 'farm', raidId: RAID.id },
      deltaGameMinutes: 0,
    }).state;
    const out = step(state, { deltaGameMinutes: GAME_MINUTES_PER_WEEK });

    const goal = WEEKLY_GOAL_BY_ID.get('farm')!;
    const salvageLines = out.events.filter((e) => e.text.includes('卖店'));
    expect(salvageLines).toHaveLength(DROPS_PER_FULL_CLEAR); // 装等 90 ⇒ 16 件全数无人可提升
    // 金库:起始 1000 + 卖店 8 金 × 16 件(全通无修理金;裁量制无金库抽成)
    expect(out.state.vault.gold).toBe(1000 + goal.salvageGoldPerDrop * DROPS_PER_FULL_CLEAR);
    expect(out.state.vault.incomeTotal).toBe(goal.salvageGoldPerDrop * DROPS_PER_FULL_CLEAR);
    expect(out.state.lastRaidNight?.goal).toEqual({ id: 'farm', name: 'farm' });
  });
});

describe('调整计划:即时生效与手动优先(验收标准 3)', () => {
  it('改目标即时写入状态,并对本周已排上的团本夜生效', () => {
    // 开计划(推进,本周排上)→ 跨界前改 farm:本周这一夜按 farm 结算
    let state = planReadyState({ vaultGold: 1000 });
    state = step(state, {
      command: { type: 'setWeeklyPlan', goal: 'progress', raidId: RAID.id },
      deltaGameMinutes: 0,
    }).state;
    const adjusted = step(state, {
      command: { type: 'setWeeklyPlan', goal: 'farm', raidId: RAID.id },
      deltaGameMinutes: 0,
    });
    // 即时:计划目标已换;本周安排不动(手动/既有安排优先,不重复开团)
    expect(adjusted.state.weeklyPlan?.goal).toBe('farm');
    expect(adjusted.state.raidPlan?.raidId).toBe(RAID.id);
    expect(adjusted.events).toHaveLength(1); // 只有设定事件,没有第二次自动开团
    // 当夜按新目标结算
    const night = step(adjusted.state, { deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    expect(night.state.lastRaidNight?.goal?.id).toBe('farm');
    expect(night.events.some((e) => e.text.includes('卖店'))).toBe(true);
  });

  it('会长手动取消本周开团:本周不打,下周照计划自动恢复', () => {
    let state = planReadyState();
    state = step(state, {
      command: { type: 'setWeeklyPlan', goal: 'progress', raidId: RAID.id },
      deltaGameMinutes: 0,
    }).state;
    state = step(state, { command: { type: 'cancelRaid' }, deltaGameMinutes: 0 }).state;

    const week1 = step(state, { deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    // 本周夜取消:没有团本夜开始;边界上自动层照计划把下周排上
    expect(week1.events.some((e) => e.text.includes('团本夜开始'))).toBe(false);
    expect(week1.events.some((e) => e.text.includes('自动层按周计划开团'))).toBe(true);
    expect(week1.state.raidPlan?.openedAtGameMinutes).toBe(GAME_MINUTES_PER_WEEK);

    const week2 = step(week1.state, { deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    expect(week2.events.some((e) => e.text.includes('团本夜开始'))).toBe(true);
    expect(week2.state.lastRaidNight?.atGameMinutes).toBe(GAME_MINUTES_PER_WEEK * 2);
  });

  it('取消周计划后:周边界不再自动开团', () => {
    let state = planReadyState();
    state = step(state, {
      command: { type: 'setWeeklyPlan', goal: 'progress', raidId: RAID.id },
      deltaGameMinutes: 0,
    }).state;
    state = step(state, { command: { type: 'clearWeeklyPlan' }, deltaGameMinutes: 0 }).state;
    // 本周安排仍在(取消计划不撤当周团)⇒ 第一夜照打;此后无计划,不再自动开
    const week1 = step(state, { deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    expect(week1.events.some((e) => e.text.includes('团本夜开始'))).toBe(true);
    const week2 = step(week1.state, { deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    expect(week2.events.some((e) => e.text.includes('自动层按周计划开团'))).toBe(false);
    expect(week2.events.some((e) => e.text.includes('团本夜开始'))).toBe(false);
    expect(week2.state.raidPlan).toBeUndefined();
  });

  it('日程派生量随计划即时变化:nextRaidNight 指向周边界,计划未排上时为 undefined', () => {
    const bare = planReadyState();
    const armed = step(bare, {
      command: { type: 'setWeeklyPlan', goal: 'progress', raidId: RAID.id },
      deltaGameMinutes: 0,
    }).state;
    // 指令一步之内,日程页的数据面(派生量)即已排上团本夜
    expect(armed.raidPlan).toBeDefined();
    expect(nextRaidNight(armed)?.atGameMinutes).toBe(GAME_MINUTES_PER_WEEK);
    expect(nextRaidNight(bare)).toBeUndefined();
  });
});

describe('自动层暂缓:门槛与团队检查(验收标准 1、2 的边界)', () => {
  it('团队检查不过:计划保留、暂缓开团,每周边界重试而非硬开', () => {
    const state = planReadyState({ breakTeamCheck: true });
    const set = step(state, {
      command: { type: 'setWeeklyPlan', goal: 'progress', raidId: RAID.id },
      deltaGameMinutes: 0,
    });
    expect(set.state.weeklyPlan?.goal).toBe('progress'); // 计划保留
    expect(set.state.raidPlan).toBeUndefined(); // 本周未排上
    expect(set.events.some((e) => e.text.includes('自动层暂缓开团'))).toBe(true);
    expect(set.events.some((e) => e.text.includes('团队检查未通过'))).toBe(true);

    // 跨一个周边界:仍暂缓(每周一条事件,可见可恢复)
    const week1 = step(set.state, { deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    expect(week1.events.some((e) => e.text.includes('团本夜开始'))).toBe(false);
    expect(week1.events.filter((e) => e.text.includes('自动层暂缓开团'))).toHaveLength(1);
    expect(week1.state.raidPlan).toBeUndefined();
    expect(week1.state.weeklyPlan).toBeDefined();
  });

  it('补齐编成后:同一计划无需重设,下一周边界自动恢复开团', () => {
    // 暂缓变体:末队缺的第五人 = 会长角色(待命不退会,可随时补编)
    let state = planReadyState({ breakTeamCheck: true });
    state = step(state, {
      command: { type: 'setWeeklyPlan', goal: 'progress', raidId: RAID.id },
      deltaGameMinutes: 0,
    }).state;
    const week1 = step(state, { deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    // 把会长角色编回末队(指令修补编成),下周照计划自动开团
    const fixed = step(week1.state, {
      command: {
        type: 'assignToSquad',
        memberId: 41,
        squadId: week1.state.squads[week1.state.squads.length - 1]!.id,
      },
      deltaGameMinutes: 0,
    }).state;
    const week2 = step(fixed, { deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    expect(week2.events.some((e) => e.text.includes('自动层按周计划开团'))).toBe(true);
    expect(week2.state.raidPlan?.raidId).toBe(RAID.id);
  });

  it('未解锁的团本:计划可设(为将来准备),开团暂缓并给出未达标项', () => {
    // 装等 60 < 门槛 62:内容阶梯未达
    const state = planReadyState({ itemLevel: 60 });
    const set = step(state, {
      command: { type: 'setWeeklyPlan', goal: 'progress', raidId: RAID.id },
      deltaGameMinutes: 0,
    });
    expect(set.state.weeklyPlan).toBeDefined();
    expect(set.state.raidPlan).toBeUndefined();
    expect(set.events.some((e) => e.text.includes('自动层暂缓开团'))).toBe(true);
    expect(set.events.some((e) => e.text.includes('门槛未达'))).toBe(true);
  });
});

describe('周目标钩子:分配倾斜(带新)与卖店(farm)的纯函数面', () => {
  /** 合成装备:按部位逐件给装等。 */
  function gearOf(levels: readonly number[]): GearItem[] {
    if (levels.length !== GEAR_SLOTS.length) {
      throw new Error('装备件数须等于部位数');
    }
    return GEAR_SLOTS.map((slot, i) => ({ slot, quality: '蓝' as const, itemLevel: levels[i]! }));
  }

  // 甲:全身上下一律 50(平均 50,任意掉落提升 +24)
  // 乙:前四部位 80、后四部位 40(平均 60;80 部位不可提升,40 部位提升 +34)
  const memberA = synthMember(1, 'mage', 'mage-arcane', gearOf(GEAR_SLOTS.map(() => 50)), { name: '新人甲' });
  const memberB = synthMember(2, 'mage', 'mage-flame', gearOf(GEAR_SLOTS.map((_, i) => (i < 4 ? 80 : 40))), { name: '老人乙' });
  const dropOnLowSlot = {
    slot: GEAR_SLOTS[4]!,
    quality: '蓝' as const,
    itemLevel: 74, // 乙的低部位:甲 +24、乙 +34(择优应给乙)
  };

  it('带新倾斜:会长裁量制下,装等最低的可提升者优先(甲),不再取提升最大者(乙)', () => {
    const allocation = distributeRaidDrop({
      members: [memberA, memberB],
      team: [memberA, memberB],
      item: dropOnLowSlot,
      system: LOOT_SYSTEM_BY_ID.get('chairman')!,
      selfDealing: false,
      vault: { gold: 0, repairSpent: 0, incomeTotal: 0 },
      lootTilt: 'lowestItemLevel',
    });
    expect(allocation.outcome.assignedTo).toBe('新人甲');
    expect(allocation.line).toContain('带新');
    expect(allocation.outcome.upgradeDelta).toBe(24);
  });

  it('不倾斜(缺省/推进/farm):裁量制照旧择优 —— 提升最大者(乙)拿装', () => {
    const allocation = distributeRaidDrop({
      members: [memberA, memberB],
      team: [memberA, memberB],
      item: dropOnLowSlot,
      system: LOOT_SYSTEM_BY_ID.get('chairman')!,
      selfDealing: false,
      vault: { gold: 0, repairSpent: 0, incomeTotal: 0 },
    });
    expect(allocation.outcome.assignedTo).toBe('老人乙');
    expect(allocation.line).toContain('会长裁量');
  });

  it('farm 卖店:无人可提升的掉落收入进金库;缺省照旧分解不给钱', () => {
    const vault = { gold: 200, repairSpent: 0, incomeTotal: 0 };
    const fullyGeared = synthMember(1, 'mage', 'mage-arcane', gearOf(GEAR_SLOTS.map(() => 90)), { name: '满装丙' });
    const item = { slot: GEAR_SLOTS[0]!, quality: '蓝' as const, itemLevel: 74 };

    const sold = distributeRaidDrop({
      members: [fullyGeared],
      team: [fullyGeared],
      item,
      system: LOOT_SYSTEM_BY_ID.get('chairman')!,
      selfDealing: false,
      vault,
      salvageGoldPerDrop: 8,
    });
    expect(sold.vault).toEqual({ gold: 208, repairSpent: 0, incomeTotal: 8 });
    expect(sold.outcome.equipped).toBe(false);
    expect(sold.line).toContain('卖店 +8 金入金库');

    const dust = distributeRaidDrop({
      members: [fullyGeared],
      team: [fullyGeared],
      item,
      system: LOOT_SYSTEM_BY_ID.get('chairman')!,
      selfDealing: false,
      vault,
    });
    expect(dust.vault).toEqual(vault);
    expect(dust.line).toContain('随手分解');
  });
});

describe('存档:周计划随档落盘(v11)', () => {
  it('带周计划的状态编码解码往返一致;无计划的 v10 旧档(缺字段)解码后为 undefined', () => {
    const state = planReadyState({
      weeklyPlan: { goal: 'mentor', raidId: RAID.id, setAtGameMinutes: 123 },
    });
    const decoded = decodeSave(encodeSave(state));
    expect(decoded?.weeklyPlan).toEqual({ goal: 'mentor', raidId: RAID.id, setAtGameMinutes: 123 });

    const legacy = decodeSave(
      JSON.stringify({
        kind: 'wowidle-save',
        version: 10,
        state: { ...state, weeklyPlan: undefined },
      }),
    );
    expect(legacy?.weeklyPlan).toBeUndefined();
    expect(legacy?.members).toHaveLength(state.members.length); // 其余字段完整迁移
  });
});
