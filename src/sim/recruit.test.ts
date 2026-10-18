import { describe, expect, it } from 'vitest';
import { RECRUIT } from '../content/recruit';
import { CLASS_BY_ID } from '../content/classes';
import { GEAR_SLOTS } from '../content/gear';
import { FAMILY_NAME_POOL, GIVEN_NAME_POOL } from '../content/names';
import { ROSTER_GEN } from '../content/roster-gen';
import { SKILL_TIER_BY_ID } from '../content/skill-tiers';
import { GAME_MINUTES_PER_DAY } from './clock';
import { SimulationFacade, step } from './facade';
import { poolSpecForRung } from './recruit';
import { renownRung } from './reputation';
import type { GameState, Member } from './state';

/**
 * T3 门面测试:招募循环 —— 申请池 + 招募/淘汰。
 * 与全项目一致只打门面接缝:构造/驱动 SimulationFacade,断言状态快照与事件日志;
 * poolSpecForRung 与 averageItemLevel 同为 sim 纯派生函数,按 T2 先例直接断言。
 * T12 起声望为真值:规格由声望阶位(rung = 档序 × 3 + 星)驱动,不再有桩值。
 */

const VALID_NAMES = new Set(FAMILY_NAME_POOL.flatMap((family) => GIVEN_NAME_POOL.map((given) => family + given)));

/** 状态当前的声望阶位(派生量,sim/reputation 纯函数)。 */
function rungOf(state: GameState): number {
  return renownRung(state.renownPoints);
}

/** 取初始申请池中第 n 份申请的编号(1 起)。 */
function applicationIdAt(state: GameState, n: number): number {
  const applicant = state.applicants[n - 1];
  if (applicant === undefined) {
    throw new Error(`申请池中不存在第 ${n} 份申请`);
  }
  return applicant.applicationId;
}

describe('申请池:建会初始池与规格(验收标准 1)', () => {
  it('建会当日即有申请池:份数与规格由声望阶位驱动(新会 = 0 阶)', () => {
    const facade = new SimulationFacade(20261018, '星盾公会');
    const state = facade.state;
    expect(state.renownPoints).toBe(0); // 新会声望从 0 起步(T12 真值)
    expect(rungOf(state)).toBe(0);
    expect(state.rosterCap).toBe(RECRUIT.baseRosterCap);
    const spec = poolSpecForRung(rungOf(state));
    expect(state.applicants).toHaveLength(spec.count);
    // 申请编号独立空间:从 1 连续递增
    expect(state.applicants.map((a) => a.applicationId)).toEqual(
      Array.from({ length: spec.count }, (_, i) => i + 1),
    );
    expect(state.nextApplicationId).toBe(spec.count + 1);
  });

  it('申请人按池子规格生成:等级区间来自规格,其余维度与在册团员同规', () => {
    // 多种子抽样:结构约束对任意池子成立
    for (let seed = 1; seed <= 25; seed++) {
      const state = new SimulationFacade(seed).state;
      const spec = poolSpecForRung(rungOf(state));
      const memberNames = new Set(state.members.map((m) => m.name));
      const batchNames = new Set<string>();
      for (const applicant of state.applicants) {
        const profile = applicant.profile;
        // 规格:等级区间
        expect(profile.level).toBeGreaterThanOrEqual(spec.levelRange[0]);
        expect(profile.level).toBeLessThanOrEqual(spec.levelRange[1]);
        // 与在册团员同一套维度规则
        const cls = CLASS_BY_ID.get(profile.classId);
        expect(cls).toBeDefined();
        expect(cls!.specs.some((s) => s.id === profile.specId)).toBe(true);
        expect(profile.gear.map((g) => g.slot)).toEqual([...GEAR_SLOTS]);
        expect(SKILL_TIER_BY_ID.has(profile.skillTierId)).toBe(true);
        expect(profile.traits.length).toBeGreaterThanOrEqual(1);
        expect(profile.traits.length).toBeLessThanOrEqual(2);
        expect(new Set(profile.traits).size).toBe(profile.traits.length);
        const [lo, hi] = ROSTER_GEN.member.loyaltyRange;
        expect(profile.loyalty).toBeGreaterThanOrEqual(lo);
        expect(profile.loyalty).toBeLessThanOrEqual(hi);
        expect(VALID_NAMES.has(profile.name)).toBe(true);
        // 姓名不与在册团员、同批申请重复
        expect(memberNames.has(profile.name)).toBe(false);
        expect(batchNames.has(profile.name)).toBe(false);
        batchNames.add(profile.name);
      }
    }
  });
});

describe('申请池:每游戏日刷新(验收标准 1)', () => {
  it('不跨日推进,池子保持不变;跨过日界整池换新', () => {
    const facade = new SimulationFacade(20261018, '星盾公会');
    const day1 = facade.state;

    // 日内推进(未跨日界):申请池不变
    const within = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY - 1 });
    expect(within.state.applicants).toEqual(day1.applicants);

    // 跨过第 2 日边界:整池换新(旧申请全部作废),编号接续递增
    const crossing = facade.dispatch({ deltaGameMinutes: 1 });
    expect(gameDayOf(crossing.state)).toBe(2);
    const refreshed = crossing.state.applicants;
    expect(refreshed).toHaveLength(poolSpecForRung(rungOf(crossing.state)).count);
    const oldIds = new Set(day1.applicants.map((a) => a.applicationId));
    expect(refreshed.every((a) => !oldIds.has(a.applicationId))).toBe(true);
    expect(refreshed.map((a) => a.applicationId)).toEqual(
      Array.from({ length: refreshed.length }, (_, i) => day1.nextApplicationId + i),
    );
    expect(crossing.state.nextApplicationId).toBe(day1.nextApplicationId + refreshed.length);
    // 刷新事件:每个日界一条
    expect(crossing.events.filter((e) => e.kind === '招募')).toHaveLength(1);
    expect(crossing.events.at(-1)?.text).toBe(`申请池刷新:${refreshed.length} 名冒险者递来了申请。`);
  });

  it('一次跨多日:逐日刷新,事件数 = 跨过的日界数', () => {
    const facade = new SimulationFacade(7, '星盾公会');
    const output = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY * 7 });
    expect(output.events.filter((e) => e.kind === '招募')).toHaveLength(7);
    expect(facade.state.applicants).toHaveLength(poolSpecForRung(rungOf(facade.state)).count);
  });

  it('昨日未处理的申请次日不复存在(拒绝过的与剩下的都被新池覆盖)', () => {
    const facade = new SimulationFacade(11, '星盾公会');
    const rejectedId = applicationIdAt(facade.state, 1);
    facade.dispatch({ command: { type: 'rejectApplicant', applicationId: rejectedId }, deltaGameMinutes: 0 });
    expect(facade.state.applicants).toHaveLength(poolSpecForRung(rungOf(facade.state)).count - 1);

    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    // 新池为满份数,且不含任何旧申请
    expect(facade.state.applicants).toHaveLength(poolSpecForRung(rungOf(facade.state)).count);
    expect(facade.state.applicants.some((a) => a.applicationId === rejectedId)).toBe(false);
  });
});

describe('招募指令:招入/拒绝/淘汰均经门面(验收标准 2)', () => {
  it('招入申请:画像原样转正入册,申请移出池子,记「招募」事件', () => {
    const facade = new SimulationFacade(20261018, '星盾公会');
    // 建会即 6/6 满员,先淘汰一人腾出名额(下一组用例再细测上限)
    facade.dispatch({ command: { type: 'dismissMember', memberId: 2 }, deltaGameMinutes: 0 });

    const applicant = facade.state.applicants[0]!;
    const before = facade.state;
    const output = facade.dispatch({
      command: { type: 'recruitApplicant', applicationId: applicant.applicationId },
      deltaGameMinutes: 0,
    });

    expect(output.state.members).toHaveLength(before.members.length + 1);
    const joined = output.state.members.at(-1) as Member;
    expect(joined.id).toBe(before.nextMemberId); // 团员 id 从 nextMemberId 起编
    expect(joined.isChairman).toBe(false);
    // 画像原样转正(入册时刻与冷板凳计数是转正新增的管理维度,T12)
    expect({ ...joined, id: 0, isChairman: false, joinedAtGameMinutes: 0, benchDays: 0 }).toEqual({
      ...applicant.profile,
      id: 0,
      isChairman: false,
      joinedAtGameMinutes: 0,
      benchDays: 0,
    });
    expect(joined.joinedAtGameMinutes).toBe(before.clockGameMinutes);
    expect(joined.benchDays).toBe(0);
    expect(output.state.nextMemberId).toBe(before.nextMemberId + 1);
    expect(output.state.applicants).toHaveLength(before.applicants.length - 1);
    expect(output.state.applicants.some((a) => a.applicationId === applicant.applicationId)).toBe(false);
    expect(output.events).toHaveLength(1);
    expect(output.events[0]?.kind).toBe('招募');
    expect(output.events[0]?.text).toBe(`「${applicant.profile.name}」通过申请,正式入册。`);
  });

  it('拒绝申请:移出池子,名册不变,记「招募」事件', () => {
    const facade = new SimulationFacade(20261018, '星盾公会');
    const before = facade.state;
    const applicant = before.applicants[1]!;
    const output = facade.dispatch({
      command: { type: 'rejectApplicant', applicationId: applicant.applicationId },
      deltaGameMinutes: 0,
    });
    expect(output.state.members).toBe(before.members); // 名册连引用都未动
    expect(output.state.applicants).toHaveLength(before.applicants.length - 1);
    expect(output.events.map((e) => e.text)).toEqual([`婉拒了「${applicant.profile.name}」的申请。`]);
  });

  it('淘汰在册团员:移出名册,记「招募」事件;会长角色不可淘汰', () => {
    const facade = new SimulationFacade(20261018, '星盾公会');
    const before = facade.state;
    const target = before.members.find((m) => !m.isChairman)!;
    const output = facade.dispatch({ command: { type: 'dismissMember', memberId: target.id }, deltaGameMinutes: 0 });
    expect(output.state.members).toHaveLength(before.members.length - 1);
    expect(output.state.members.some((m) => m.id === target.id)).toBe(false);
    expect(output.events.map((e) => e.text)).toEqual([`「${target.name}」被淘汰出会。`]);

    // 会长角色(id 1)不可淘汰:状态不变、无事件
    const blocked = facade.dispatch({ command: { type: 'dismissMember', memberId: 1 }, deltaGameMinutes: 0 });
    expect(blocked.events).toEqual([]);
    expect(blocked.state.members).toBe(facade.state.members);
  });

  it('指令与时间增量同一步:指令在步起始时刻生效,之后跨日刷新不吞掉指令结果', () => {
    const facade = new SimulationFacade(20261018, '星盾公会');
    facade.dispatch({ command: { type: 'dismissMember', memberId: 2 }, deltaGameMinutes: 0 });
    const output = facade.dispatch({
      command: { type: 'recruitApplicant', applicationId: applicationIdAt(facade.state, 1) },
      deltaGameMinutes: GAME_MINUTES_PER_DAY,
    });
    // 招入事件在时刻 0,刷新事件在日界
    expect(output.events[0]?.kind).toBe('招募');
    expect(output.events[0]?.atGameMinutes).toBe(0);
    expect(output.events.at(-1)?.kind).toBe('招募');
    expect(output.events.at(-1)?.atGameMinutes).toBe(GAME_MINUTES_PER_DAY);
    expect(facade.state.members).toHaveLength(facade.state.rosterCap);
  });
});

describe('名册上限:满员不可再招(验收标准 3)', () => {
  it('建会名册即达上限:招入被门面拒绝(状态不变、无事件)', () => {
    const facade = new SimulationFacade(20261018, '星盾公会');
    expect(facade.state.members).toHaveLength(facade.state.rosterCap); // 6 人小会 = 起步上限

    const before = structuredClone(facade.state);
    for (const applicant of facade.state.applicants) {
      const output = facade.dispatch({
        command: { type: 'recruitApplicant', applicationId: applicant.applicationId },
        deltaGameMinutes: 0,
      });
      expect(output.events).toEqual([]);
    }
    expect(facade.state).toEqual(before); // 池子、名册、随机链全部原样
  });

  it('满员不影响拒绝申请;淘汰腾出名额后可再招,再满则再次拒绝', () => {
    const facade = new SimulationFacade(20261018, '星盾公会');

    // 满员时拒绝照常生效(拒绝不是入册)
    facade.dispatch({ command: { type: 'rejectApplicant', applicationId: applicationIdAt(facade.state, 1) }, deltaGameMinutes: 0 });
    expect(facade.state.applicants).toHaveLength(poolSpecForRung(rungOf(facade.state)).count - 1);

    // 淘汰一人 → 5/6,招入成功 → 6/6
    facade.dispatch({ command: { type: 'dismissMember', memberId: 3 }, deltaGameMinutes: 0 });
    const ok = facade.dispatch({
      command: { type: 'recruitApplicant', applicationId: applicationIdAt(facade.state, 1) },
      deltaGameMinutes: 0,
    });
    expect(ok.state.members).toHaveLength(facade.state.rosterCap);
    expect(ok.events.map((e) => e.kind)).toEqual(['招募']);

    // 再次满员:剩余申请一律招不进
    const blocked = facade.dispatch({
      command: { type: 'recruitApplicant', applicationId: applicationIdAt(facade.state, 1) },
      deltaGameMinutes: 0,
    });
    expect(blocked.events).toEqual([]);
    expect(blocked.state.members).toHaveLength(facade.state.rosterCap);
  });
});

describe('非法与边界指令', () => {
  it('不存在的申请编号 / 团员编号:状态不变、无事件', () => {
    const facade = new SimulationFacade(20261018, '星盾公会');
    const before = structuredClone(facade.state);
    expect(facade.dispatch({ command: { type: 'recruitApplicant', applicationId: 9999 }, deltaGameMinutes: 0 }).events).toEqual([]);
    expect(facade.dispatch({ command: { type: 'rejectApplicant', applicationId: 9999 }, deltaGameMinutes: 0 }).events).toEqual([]);
    expect(facade.dispatch({ command: { type: 'dismissMember', memberId: 9999 }, deltaGameMinutes: 0 }).events).toEqual([]);
    expect(facade.state).toEqual(before);
  });

  it('同一申请不可被处理两次(第二次按不存在忽略)', () => {
    const facade = new SimulationFacade(20261018, '星盾公会');
    facade.dispatch({ command: { type: 'dismissMember', memberId: 2 }, deltaGameMinutes: 0 });
    const id = applicationIdAt(facade.state, 1);
    facade.dispatch({ command: { type: 'recruitApplicant', applicationId: id }, deltaGameMinutes: 0 });
    const again = facade.dispatch({ command: { type: 'recruitApplicant', applicationId: id }, deltaGameMinutes: 0 });
    expect(again.events).toEqual([]);
    expect(again.state.members).toHaveLength(facade.state.members.length);
  });
});

describe('招募循环:确定性(验收标准 4)', () => {
  const runRecruitScript = (seed: number): string => {
    const facade = new SimulationFacade(seed, '星盾公会');
    facade.dispatch({ command: { type: 'dismissMember', memberId: 2 }, deltaGameMinutes: 0 });
    facade.dispatch({ command: { type: 'recruitApplicant', applicationId: applicationIdAt(facade.state, 1) }, deltaGameMinutes: 0 });
    facade.dispatch({ command: { type: 'rejectApplicant', applicationId: applicationIdAt(facade.state, 1) }, deltaGameMinutes: 0 });
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY * 3 });
    facade.dispatch({ command: { type: 'dismissMember', memberId: 4 }, deltaGameMinutes: 0 });
    facade.dispatch({ command: { type: 'recruitApplicant', applicationId: applicationIdAt(facade.state, 2) }, deltaGameMinutes: 0 });
    return JSON.stringify({ state: facade.state });
  };

  it('同一种子 + 同一「指令 + 时间跳变」脚本 ⇒ 同状态', () => {
    expect(runRecruitScript(20261018)).toBe(runRecruitScript(20261018));
  });

  it('不同种子 ⇒ 不同申请池与名册', () => {
    expect(runRecruitScript(101)).not.toBe(runRecruitScript(202));
  });

  it('纯函数 step 不原地修改输入状态(招募指令路径)', () => {
    const facade = new SimulationFacade(88, '星盾公会');
    facade.dispatch({ command: { type: 'dismissMember', memberId: 2 }, deltaGameMinutes: 0 });
    const before = structuredClone(facade.state);
    const output = step(facade.state, {
      command: { type: 'recruitApplicant', applicationId: applicationIdAt(facade.state, 1) },
      deltaGameMinutes: GAME_MINUTES_PER_DAY,
    });
    expect(facade.state).toEqual(before); // 原状态未被改动
    // 同状态 + 同输入 ⇒ 同输出
    const again = step(facade.state, {
      command: { type: 'recruitApplicant', applicationId: applicationIdAt(facade.state, 1) },
      deltaGameMinutes: GAME_MINUTES_PER_DAY,
    });
    expect(again).toEqual(output);
  });
});

describe('申请池规格:声望阶位驱动(纯函数,T12 真值)', () => {
  it('0 阶(无名小会):基础份数、基础等级区间、技艺档基础权重', () => {
    const spec = poolSpecForRung(0);
    expect(spec.count).toBe(RECRUIT.poolCount.baseCount);
    expect(spec.levelRange).toEqual([...RECRUIT.poolQuality.baseLevelRange]);
    for (const tier of spec.skillTiers) {
      expect(tier.weight).toBe(SKILL_TIER_BY_ID.get(tier.id)!.weight); // 偏置 1× 的档位不变
    }
  });

  it('阶位升高:份数增多(有上限)、等级上移(有上限)、技艺向高档倾斜', () => {
    const low = poolSpecForRung(0);
    const mid = poolSpecForRung(10);
    const high = poolSpecForRung(21); // 满阶 = 7 档 × 3 星
    expect(mid.count).toBeGreaterThan(low.count);
    expect(high.count).toBe(RECRUIT.poolCount.maxCount);
    expect(mid.levelRange[0]).toBeGreaterThan(low.levelRange[0]);
    expect(high.levelRange[0] - low.levelRange[0]).toBe(RECRUIT.poolQuality.levelBonusCap);

    const topAt = (spec: typeof low) => spec.skillTiers.find((t) => t.id === 'top')!.weight;
    const rookieAt = (spec: typeof low) => spec.skillTiers.find((t) => t.id === 'rookie')!.weight;
    expect(topAt(high)).toBeGreaterThan(topAt(low));
    expect(rookieAt(high)).toBeLessThan(rookieAt(low));
  });

  it('阶位越界被钳制到 0..21,浮点向下取整', () => {
    expect(poolSpecForRung(-5)).toEqual(poolSpecForRung(0));
    expect(poolSpecForRung(999)).toEqual(poolSpecForRung(21));
    expect(poolSpecForRung(2.9).count).toBe(RECRUIT.poolCount.baseCount);
  });
});

/** 当前游戏日(1 起)。 */
function gameDayOf(state: GameState): number {
  return Math.floor(state.clockGameMinutes / GAME_MINUTES_PER_DAY) + 1;
}
