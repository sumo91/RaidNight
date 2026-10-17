import { describe, expect, it } from 'vitest';
import { ATTENDANCE_STYLES } from '../content/attendance';
import { CLASSES, CLASS_BY_ID } from '../content/classes';
import { GEAR_SLOTS } from '../content/gear';
import { FAMILY_NAME_POOL, GIVEN_NAME_POOL } from '../content/names';
import { ROSTER_GEN } from '../content/roster-gen';
import { SKILL_TIERS } from '../content/skill-tiers';
import { TRAIT_POOL, TRAIT_BY_ID } from '../content/traits';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from './clock';
import { SimulationFacade, step } from './facade';
import { averageItemLevel } from './roster';
import type { Member } from './state';

/**
 * T2 门面测试:团员生成与名册(含会长角色)。
 * 与全项目一致只打门面接缝:构造/驱动 SimulationFacade,断言状态快照。
 */

const VALID_NAMES = new Set(FAMILY_NAME_POOL.flatMap((family) => GIVEN_NAME_POOL.map((given) => family + given)));

describe('建会名册:规模与会长角色(验收标准 3)', () => {
  const facade = new SimulationFacade(20261018, '星盾公会');
  const members = facade.state.members;

  it('建会即入册:会长角色 + 配置数量的初始团员', () => {
    expect(members).toHaveLength(1 + ROSTER_GEN.foundingMemberCount);
    expect(members[0]?.isChairman).toBe(true); // 会长最先入册
    expect(members.filter((m) => m.isChairman)).toHaveLength(1); // 唯一
  });

  it('会长角色按配置生成:等级、忠诚、出勤风格', () => {
    const chairman = members.find((m) => m.isChairman);
    expect(chairman).toBeDefined();
    expect(chairman?.level).toBe(ROSTER_GEN.chairman.level);
    expect(chairman?.loyalty).toBe(100); // 自己的公会
    expect(chairman?.attendance.styleId).toBe(ROSTER_GEN.chairman.attendanceStyleId);
    const [lo, hi] = ROSTER_GEN.chairman.attendanceRateRange;
    expect(chairman?.attendance.baseRate).toBeGreaterThanOrEqual(lo);
    expect(chairman?.attendance.baseRate).toBeLessThanOrEqual(hi);
  });

  it('团员 id 唯一且连续;同批姓名不重复', () => {
    expect(new Set(members.map((m) => m.id)).size).toBe(members.length);
    expect(members.map((m) => m.id)).toEqual(members.map((_, i) => i + 1));
    expect(new Set(members.map((m) => m.name)).size).toBe(members.length);
    expect(facade.state.nextMemberId).toBe(members.length + 1);
  });
});

describe('团员维度完整性(验收标准 2 的数据面)', () => {
  // 多种子抽样:结构约束对任意生成都成立
  const samples: Member[] = [];
  for (let seed = 1; seed <= 25; seed++) {
    samples.push(...new SimulationFacade(seed).state.members);
  }

  it('职业为 9 职业之一,专精属于该职业', () => {
    for (const m of samples) {
      const cls = CLASS_BY_ID.get(m.classId);
      expect(cls).toBeDefined();
      expect(CLASSES.some((c) => c.id === m.classId)).toBe(true);
      expect(cls!.specs.some((s) => s.id === m.specId)).toBe(true);
    }
  });

  it('等级落在配置区间(会长固定值)', () => {
    for (const m of samples) {
      if (m.isChairman) {
        expect(m.level).toBe(ROSTER_GEN.chairman.level);
      } else {
        const [lo, hi] = ROSTER_GEN.member.levelRange;
        expect(m.level).toBeGreaterThanOrEqual(lo);
        expect(m.level).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('装备:8 部位各一件,装等与品质规则相符', () => {
    for (const m of samples) {
      expect(m.gear.map((g) => g.slot)).toEqual([...GEAR_SLOTS]);
      for (const item of m.gear) {
        expect(item.itemLevel).toBeGreaterThanOrEqual(1);
        // 装等上界:等级 + 最高品质加成 + 扰动
        expect(item.itemLevel).toBeLessThanOrEqual(m.level + 3 + ROSTER_GEN.itemLevelJitter);
      }
    }
  });

  it('三维状态在 0-100 且落在配置区间', () => {
    for (const m of samples) {
      for (const value of [m.mood, m.loyalty, m.fatigue]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
      const moodRange = m.isChairman ? ROSTER_GEN.chairman.moodRange : ROSTER_GEN.member.moodRange;
      const fatigueRange = m.isChairman ? ROSTER_GEN.chairman.fatigueRange : ROSTER_GEN.member.fatigueRange;
      expect(m.mood).toBeGreaterThanOrEqual(moodRange[0]);
      expect(m.mood).toBeLessThanOrEqual(moodRange[1]);
      expect(m.fatigue).toBeGreaterThanOrEqual(fatigueRange[0]);
      expect(m.fatigue).toBeLessThanOrEqual(fatigueRange[1]);
      if (!m.isChairman) {
        const [lo, hi] = ROSTER_GEN.member.loyaltyRange;
        expect(m.loyalty).toBeGreaterThanOrEqual(lo);
        expect(m.loyalty).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('出勤画像:风格来自池,基础出勤率落在风格区间', () => {
    const stylesById = new Map(ATTENDANCE_STYLES.map((s) => [s.id, s]));
    for (const m of samples) {
      const style = stylesById.get(m.attendance.styleId);
      expect(style).toBeDefined();
      expect(m.attendance.baseRate).toBeGreaterThanOrEqual(style!.baseRateRange[0]);
      expect(m.attendance.baseRate).toBeLessThanOrEqual(style!.baseRateRange[1]);
    }
  });

  it('性格标签 1–2 个、来自池且不重复', () => {
    for (const m of samples) {
      expect(m.traits.length).toBeGreaterThanOrEqual(1);
      expect(m.traits.length).toBeLessThanOrEqual(2);
      expect(new Set(m.traits).size).toBe(m.traits.length);
      for (const id of m.traits) {
        expect(TRAIT_BY_ID.has(id)).toBe(true);
      }
    }
  });

  it('技艺评级来自档位表', () => {
    const tierIds = new Set(SKILL_TIERS.map((t) => t.id));
    for (const m of samples) {
      expect(tierIds.has(m.skillTierId)).toBe(true);
    }
  });

  it('姓名来自姓名表的姓 × 名组合(数据驱动)', () => {
    for (const m of samples) {
      expect(VALID_NAMES.has(m.name)).toBe(true);
    }
  });
});

describe('生成可复现(验收标准 4)', () => {
  it('同一种子生成同一批团员(状态级一致)', () => {
    const a = new SimulationFacade(20261018, '星盾公会').state;
    const b = new SimulationFacade(20261018, '星盾公会').state;
    expect(b.members).toEqual(a.members);
    expect(JSON.stringify(b.members)).toBe(JSON.stringify(a.members));
    expect(b.rngState).toBe(a.rngState); // 生成后的随机链状态也一致
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('不同种子生成不同的名册', () => {
    const a = new SimulationFacade(101, '星盾公会').state;
    const b = new SimulationFacade(202, '星盾公会').state;
    expect(JSON.stringify(b.members)).not.toBe(JSON.stringify(a.members));
  });

  it('生成走种子随机链:初始 rngState 不等于种子(链被消费并存回)', () => {
    const facade = new SimulationFacade(77, '星盾公会');
    expect(facade.state.rngState).not.toBe(77);
    expect(facade.state.seed).toBe(77);
  });

  it('名册生成与时间推进复合后仍可复现', () => {
    const run = (seed: number) => {
      const facade = new SimulationFacade(seed, '星盾公会');
      facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK });
      facade.dispatch({ command: { type: 'renameGuild', name: '暮光酒馆' }, deltaGameMinutes: 0 });
      facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK * 2 });
      return JSON.stringify(facade.state);
    };
    expect(run(314159)).toBe(run(314159));
  });
});

describe('生成规则数据驱动(验收标准 5)', () => {
  it('职业分布权重生效:多种子抽样覆盖全部 9 职业', () => {
    const seen = new Set<string>();
    // 25 种子 × 6 人 = 150 样本(上面 samples);再补足到 200 种子
    for (let seed = 1; seed <= 200; seed++) {
      for (const m of new SimulationFacade(seed).state.members) {
        seen.add(m.classId);
      }
    }
    expect([...seen].sort()).toEqual(CLASSES.map((c) => c.id).sort());
  });

  it('内容表结构可配置:职业带权重、姓名表非空、性格池够抽 2 个不重复', () => {
    expect(CLASSES).toHaveLength(9);
    for (const cls of CLASSES) {
      expect(cls.weight).toBeGreaterThan(0);
      expect(cls.specs.length).toBeGreaterThanOrEqual(2);
    }
    expect(FAMILY_NAME_POOL.length).toBeGreaterThan(0);
    expect(GIVEN_NAME_POOL.length).toBeGreaterThan(0);
    expect(TRAIT_POOL.length).toBeGreaterThanOrEqual(2);
  });
});

describe('门面推进对名册的作用(T5 起:无练级安排时仅休整恢复疲劳)', () => {
  it('时间推进与指令均不改名册的其余维度;疲劳只会因休整下降', () => {
    const facade = new SimulationFacade(88, '星盾公会');
    const before = structuredClone(facade.state.members);
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    for (const member of facade.state.members) {
      const old = before.find((m) => m.id === member.id)!;
      expect({ ...member, fatigue: 0 }).toEqual({ ...old, fatigue: 0 }); // 除疲劳外一切不变
      expect(member.fatigue).toBeLessThanOrEqual(old.fatigue); // 休整只降疲劳
    }
    const beforeRename = structuredClone(facade.state.members);
    facade.dispatch({ command: { type: 'renameGuild', name: '新名字' }, deltaGameMinutes: 0 });
    expect(facade.state.members).toEqual(beforeRename); // 指令路径不触名册
  });

  it('纯函数 step:同状态 + 同输入对名册的输出确定', () => {
    const facade = new SimulationFacade(88, '星盾公会');
    const output = step(facade.state, { deltaGameMinutes: GAME_MINUTES_PER_DAY });
    const again = step(facade.state, { deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(again.state.members).toEqual(output.state.members);
  });
});

describe('装等摘要(派生量)', () => {
  it('averageItemLevel = 8 部位装等四舍五入平均', () => {
    const member = new SimulationFacade(20261018).state.members[0]!;
    const manual = Math.round(member.gear.reduce((s, g) => s + g.itemLevel, 0) / member.gear.length);
    expect(averageItemLevel(member)).toBe(manual);
    expect(averageItemLevel({ ...member, gear: [] })).toBe(0); // 防御:无装备为 0
  });

  it('每个团员的装等摘要为正数', () => {
    for (let seed = 1; seed <= 10; seed++) {
      for (const m of new SimulationFacade(seed).state.members) {
        expect(averageItemLevel(m)).toBeGreaterThan(0);
      }
    }
  });
});
