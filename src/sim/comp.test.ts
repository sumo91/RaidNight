import { describe, expect, it } from 'vitest';
import { AURAS, AURA_BY_CLASS, COMP, type AuraStat } from '../content/comp';
import { CLASSES, CLASS_BY_ID } from '../content/classes';
import { GAME_MINUTES_PER_DAY } from './clock';
import { SimulationFacade, step } from './facade';
import { squadCompositions, teamCheck, unassignedMembers } from './comp';
import type { GameState, Member, Squad } from './state';

/**
 * T4 门面测试:编成 —— 小队/职能/光环预览/团队检查。
 * 与全项目一致只打门面接缝:构造/驱动 SimulationFacade 或纯函数 step,
 * 断言状态快照与事件日志;squadCompositions / teamCheck 同为 sim 纯派生函数,
 * 按 T2/T3 先例直接断言。40 人满编场景超出指令可达规模(名册上限 6),
 * 用合成状态(step 的 prev 入参)驱动 —— 仍是门面接缝的输入侧。
 */

/** 合成团员:只填编成计算涉及的维度,其余取合法常量。 */
function synthMember(id: number, classId: string, specId: string): Member {
  return {
    id,
    isChairman: false,
    name: `合成团员${id}`,
    classId,
    specId,
    level: 60,
    experience: 0,
    gear: [],
    mood: 80,
    loyalty: 80,
    fatigue: 0,
    attendance: { styleId: 'iron', baseRate: 95 },
    traits: [],
    skillTierId: 'skilled',
  };
}

/** 以真实初始状态为底,替换名册与编成(其余字段保持合法)。 */
function stateWith(members: readonly Member[], squads: readonly Squad[]): GameState {
  const base = new SimulationFacade(1, '测试公会').state;
  const maxMemberId = members.reduce((max, m) => Math.max(max, m.id), 0);
  const maxSquadId = squads.reduce((max, s) => Math.max(max, s.id), 0);
  return {
    ...base,
    members,
    nextMemberId: maxMemberId + 1,
    squads,
    nextSquadId: maxSquadId + 1,
  };
}

describe('小队光环表:数据驱动(验收标准 2 的数据面)', () => {
  it('9 职业各有一个光环,一一对应且无重复', () => {
    expect(AURAS).toHaveLength(CLASSES.length);
    expect(new Set(AURAS.map((aura) => aura.classId)).size).toBe(CLASSES.length);
    expect(new Set(AURAS.map((aura) => aura.id)).size).toBe(AURAS.length);
    for (const cls of CLASSES) {
      expect(AURA_BY_CLASS.get(cls.id)).toBeDefined();
    }
  });

  it('光环加成为正整数百分比,类别为伤害/生存/治疗之一', () => {
    for (const aura of AURAS) {
      expect(Number.isInteger(aura.percent)).toBe(true);
      expect(aura.percent).toBeGreaterThan(0);
      expect(['伤害', '生存', '治疗']).toContain(aura.stat);
      expect(aura.name).not.toHaveLength(0);
    }
  });

  it('光环名不与任何专精名撞车(展示可区分)', () => {
    const specNames = new Set(CLASSES.flatMap((cls) => cls.specs.map((spec) => spec.name)));
    for (const aura of AURAS) {
      expect(specNames.has(aura.name)).toBe(false);
    }
  });
});

describe('编成指令:经门面裁决(验收标准 1 与 4 的状态面)', () => {
  it('新建小队:编入名册成员、调离、解散,状态与事件一一对应', () => {
    const facade = new SimulationFacade(20261018, '星盾公会');
    expect(facade.state.squads).toEqual([]); // 建会时无小队
    expect(facade.state.nextSquadId).toBe(1);

    const created = facade.dispatch({ command: { type: 'createSquad' }, deltaGameMinutes: 0 });
    expect(created.state.squads).toEqual([{ id: 1, memberIds: [] }]);
    expect(created.state.nextSquadId).toBe(2);
    expect(created.events.map((e) => [e.kind, e.text])).toEqual([['编成', '第 1 小队成立。']]);

    const member = facade.state.members[1]!; // 任取一名非会长团员
    const assigned = facade.dispatch({
      command: { type: 'assignToSquad', memberId: member.id, squadId: 1 },
      deltaGameMinutes: 0,
    });
    expect(assigned.state.squads).toEqual([{ id: 1, memberIds: [member.id] }]);
    expect(assigned.events.map((e) => e.text)).toEqual([`「${member.name}」编入第 1 小队。`]);
    expect(unassignedMembers(assigned.state).some((m) => m.id === member.id)).toBe(false);

    const removed = facade.dispatch({
      command: { type: 'removeFromSquad', memberId: member.id },
      deltaGameMinutes: 0,
    });
    expect(removed.state.squads).toEqual([{ id: 1, memberIds: [] }]);
    expect(removed.events.map((e) => e.text)).toEqual([`「${member.name}」调离第 1 小队。`]);
    expect(unassignedMembers(removed.state).some((m) => m.id === member.id)).toBe(true);

    const disbanded = facade.dispatch({ command: { type: 'disbandSquad', squadId: 1 }, deltaGameMinutes: 0 });
    expect(disbanded.state.squads).toEqual([]);
    expect(disbanded.events.map((e) => e.text)).toEqual(['第 1 小队解散。']);
  });

  it('小队数上限 8 支:第 9 支被门面拒绝(状态不变、无事件)', () => {
    const facade = new SimulationFacade(5, '星盾公会');
    for (let i = 0; i < COMP.maxSquads; i++) {
      facade.dispatch({ command: { type: 'createSquad' }, deltaGameMinutes: 0 });
    }
    expect(facade.state.squads).toHaveLength(COMP.maxSquads);
    const before = structuredClone(facade.state);
    const blocked = facade.dispatch({ command: { type: 'createSquad' }, deltaGameMinutes: 0 });
    expect(blocked.events).toEqual([]);
    expect(facade.state).toEqual(before);
  });

  it('小队满 5 人后不可再编入;编入他队等于转会(先调离再入队)', () => {
    const members = Array.from({ length: 6 }, (_, i) => synthMember(i + 1, 'mage', 'mage-arcane'));
    const squads: Squad[] = [
      { id: 1, memberIds: [1, 2, 3, 4, 5] }, // 已满
      { id: 2, memberIds: [] },
    ];
    const state = stateWith(members, squads);

    // 满员拒绝
    const blocked = step(state, { command: { type: 'assignToSquad', memberId: 6, squadId: 1 }, deltaGameMinutes: 0 });
    expect(blocked.events).toEqual([]);
    expect(blocked.state.squads[0]!.memberIds).toHaveLength(COMP.squadSize);

    // 转会:从队内调走到另一队,原队不再持有
    const moved = step(state, { command: { type: 'assignToSquad', memberId: 1, squadId: 2 }, deltaGameMinutes: 0 });
    expect(moved.state.squads).toEqual([
      { id: 1, memberIds: [2, 3, 4, 5] },
      { id: 2, memberIds: [1] },
    ]);
    expect(moved.events.map((e) => e.text)).toEqual([`「${moved.state.members[0]!.name}」编入第 2 小队。`]);
  });

  it('非法与边界指令:未知编号、已在队内、非空解散均被忽略', () => {
    const facade = new SimulationFacade(9, '星盾公会');
    facade.dispatch({ command: { type: 'createSquad' }, deltaGameMinutes: 0 });
    const member = facade.state.members[1]!;
    facade.dispatch({ command: { type: 'assignToSquad', memberId: member.id, squadId: 1 }, deltaGameMinutes: 0 });

    const before = structuredClone(facade.state);
    expect(facade.dispatch({ command: { type: 'assignToSquad', memberId: 999, squadId: 1 }, deltaGameMinutes: 0 }).events).toEqual([]);
    expect(facade.dispatch({ command: { type: 'assignToSquad', memberId: member.id, squadId: 999 }, deltaGameMinutes: 0 }).events).toEqual([]);
    // 已在该小队:无变化、无事件
    expect(facade.dispatch({ command: { type: 'assignToSquad', memberId: member.id, squadId: 1 }, deltaGameMinutes: 0 }).events).toEqual([]);
    // 非空小队不可解散
    expect(facade.dispatch({ command: { type: 'disbandSquad', squadId: 1 }, deltaGameMinutes: 0 }).events).toEqual([]);
    // 不在任何小队的团员不可调离
    expect(facade.dispatch({ command: { type: 'removeFromSquad', memberId: facade.state.members[2]!.id }, deltaGameMinutes: 0 }).events).toEqual([]);
    expect(facade.state).toEqual(before);
  });

  it('淘汰在册团员同时清编:小队不悬挂已离会成员', () => {
    const facade = new SimulationFacade(20261018, '星盾公会');
    facade.dispatch({ command: { type: 'createSquad' }, deltaGameMinutes: 0 });
    const target = facade.state.members[1]!;
    facade.dispatch({ command: { type: 'assignToSquad', memberId: target.id, squadId: 1 }, deltaGameMinutes: 0 });

    const dismissed = facade.dispatch({ command: { type: 'dismissMember', memberId: target.id }, deltaGameMinutes: 0 });
    expect(dismissed.state.members.some((m) => m.id === target.id)).toBe(false);
    expect(dismissed.state.squads).toEqual([{ id: 1, memberIds: [] }]);
  });

  it('编成可序列化且确定性:同种子同脚本 ⇒ 同状态(验收标准 4 的可持久面)', () => {
    const run = (seed: number): string => {
      const facade = new SimulationFacade(seed, '星盾公会');
      facade.dispatch({ command: { type: 'createSquad' }, deltaGameMinutes: 0 });
      for (const member of facade.state.members) {
        facade.dispatch({ command: { type: 'assignToSquad', memberId: member.id, squadId: 1 }, deltaGameMinutes: 0 });
      }
      facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
      facade.dispatch({ command: { type: 'removeFromSquad', memberId: 2 }, deltaGameMinutes: 0 });
      return JSON.stringify(facade.state);
    };
    expect(run(20261018)).toBe(run(20261018));

    // JSON 往返(存档持久化路径):恢复后的状态可继续经门面推进
    const facade = new SimulationFacade(20261018, '星盾公会');
    facade.dispatch({ command: { type: 'createSquad' }, deltaGameMinutes: 0 });
    facade.dispatch({ command: { type: 'assignToSquad', memberId: 1, squadId: 1 }, deltaGameMinutes: 0 });
    const roundTripped = JSON.parse(JSON.stringify(facade.state)) as GameState;
    const resumed = new SimulationFacade(0, undefined, roundTripped);
    expect(resumed.state).toEqual(facade.state);
    const next = resumed.dispatch({ command: { type: 'assignToSquad', memberId: 2, squadId: 1 }, deltaGameMinutes: 0 });
    expect(next.state.squads).toEqual([{ id: 1, memberIds: [1, 2] }]);
  });
});

describe('光环计算(验收标准 5)', () => {
  it('真实名册编队:光环预览 = 队内各职业(去重)光环按类别相加(独立重算)', () => {
    // 固定种子的建会名册是确定的;取前 4 人编入一队,用内容表独立重算期望值
    const facade = new SimulationFacade(20261018, '星盾公会');
    facade.dispatch({ command: { type: 'createSquad' }, deltaGameMinutes: 0 });
    const chosen = facade.state.members.slice(0, 4);
    for (const member of chosen) {
      facade.dispatch({ command: { type: 'assignToSquad', memberId: member.id, squadId: 1 }, deltaGameMinutes: 0 });
    }

    // 独立重算:按职业去重(同职业不叠加)后,各职业光环按类别相加
    const expected: Record<AuraStat, number> = { 伤害: 0, 生存: 0, 治疗: 0 };
    const expectedAuras = new Map<string, string[]>();
    for (const member of chosen) {
      const def = AURA_BY_CLASS.get(member.classId)!;
      const providers = expectedAuras.get(def.name) ?? [];
      if (providers.length === 0) {
        expected[def.stat] += def.percent; // 该职业的第一名队员才计入加成
      }
      providers.push(member.name);
      expectedAuras.set(def.name, providers);
    }

    const composition = squadCompositions(facade.state)[0]!;
    expect(composition.auraBonus).toEqual(expected);
    expect(composition.auras.map((aura) => aura.def.name).sort()).toEqual([...expectedAuras.keys()].sort());
    for (const aura of composition.auras) {
      expect(aura.providers).toEqual(expectedAuras.get(aura.def.name));
    }
  });

  it('同职业光环不叠加:两队友同职业只计一次,提供者全部列出', () => {
    // 扫描种子找到同职业队友同在的建会名册(确定性扫描;加权抽取下几乎必有)
    let facade: SimulationFacade | undefined;
    for (let seed = 1; seed <= 60; seed++) {
      const probe = new SimulationFacade(seed, '星盾公会');
      const classes = probe.state.members.map((m) => m.classId);
      if (new Set(classes.slice(0, 2)).size === 1) {
        facade = probe;
        break;
      }
    }
    expect(facade).toBeDefined();

    facade!.dispatch({ command: { type: 'createSquad' }, deltaGameMinutes: 0 });
    const first = facade!.state.members[0]!;
    const second = facade!.state.members[1]!;
    facade!.dispatch({ command: { type: 'assignToSquad', memberId: first.id, squadId: 1 }, deltaGameMinutes: 0 });
    facade!.dispatch({ command: { type: 'assignToSquad', memberId: second.id, squadId: 1 }, deltaGameMinutes: 0 });

    const def = AURA_BY_CLASS.get(first.classId)!;
    const composition = squadCompositions(facade!.state)[0]!;
    expect(composition.auras).toHaveLength(1);
    expect(composition.auras[0]!.providers).toEqual([first.name, second.name]);
    expect(composition.auraBonus[def.stat]).toBe(def.percent); // 只加一次
  });

  it('合成编队:三类加成互不串扰,精确到配置数值', () => {
    // 战士(战吼 伤害+6)+ 圣骑(虔诚 生存+8)+ 牧师(抚慰颂歌 治疗+8)+ 术士(血契 生存+6)
    const members = [
      synthMember(1, 'warrior', 'warrior-battle'),
      synthMember(2, 'paladin', 'paladin-justicar'),
      synthMember(3, 'priest', 'priest-shadow'),
      synthMember(4, 'warlock', 'warlock-ruin'),
    ];
    const state = stateWith(members, [{ id: 1, memberIds: [1, 2, 3, 4] }]);
    const composition = squadCompositions(state)[0]!;
    expect(composition.auraBonus).toEqual({ 伤害: 6, 生存: 14, 治疗: 8 });
    expect(composition.auras.map((aura) => aura.def.name)).toEqual(['战吼', '虔诚光环', '抚慰颂歌', '血契']);
  });

  it('空小队与空光环:无成员则无光环、加成为零', () => {
    const state = stateWith([], [{ id: 1, memberIds: [] }]);
    const composition = squadCompositions(state)[0]!;
    expect(composition.auras).toEqual([]);
    expect(composition.auraBonus).toEqual({ 伤害: 0, 生存: 0, 治疗: 0 });
    expect(composition.gaps.map((gap) => [gap.kind, gap.missing])).toEqual([
      ['坦克', COMP.squadStructure.minTanks],
      ['治疗', COMP.squadStructure.minHealers],
      ['满员', COMP.squadSize],
    ]);
  });
});

describe('团队检查判定(验收标准 5)', () => {
  /** 40 人满编团队:每队 1 坦(铁壁战)+ 1 奶(圣言牧)+ 3 输出(奥术法)。 */
  function fullTeamState(): GameState {
    const members: Member[] = [];
    const squads: Squad[] = [];
    let nextId = 1;
    for (let squadIndex = 0; squadIndex < COMP.teamCheck.requiredFullSquads; squadIndex++) {
      const memberIds: number[] = [];
      for (let slot = 0; slot < COMP.squadSize; slot++) {
        const [classId, specId] =
          slot === 0
            ? (['warrior', 'warrior-guard'] as const)
            : slot === 1
              ? (['priest', 'priest-light'] as const)
              : (['mage', 'mage-arcane'] as const);
        members.push(synthMember(nextId, classId, specId));
        memberIds.push(nextId);
        nextId++;
      }
      squads.push({ id: squadIndex + 1, memberIds });
    }
    return stateWith(members, squads);
  }

  it('满编且职能达标:团队检查通过', () => {
    const state = fullTeamState();
    const result = teamCheck(state);
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.totals).toEqual({
      squads: 8,
      fullSquads: 8,
      assigned: 40,
      tanks: 8,
      healers: 8,
      dps: 24,
    });
  });

  it('缺坦克(职能覆盖):该小队被点名,团队检查不通过', () => {
    const state = fullTeamState();
    // 把第 2 小队的坦克换成输出:该队缺坦克,职能覆盖失败
    const squadTwo = state.squads[1]!;
    const tankId = squadTwo.memberIds[0]!;
    const members = state.members.map((member) =>
      member.id === tankId ? synthMember(member.id, 'mage', 'mage-flame') : member,
    );
    const result = teamCheck({ ...state, members });
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      { kind: '职能覆盖', text: '第 2 小队缺坦克×1' },
    ]);
    expect(result.totals.tanks).toBe(7);
  });

  it('小队不足、总坦克与总治疗不足:三类失败同时列出', () => {
    // 只有两支满员小队(各 1 坦 1 奶 3 输出),远够不到 8 队门槛
    const state = fullTeamState();
    const squads = state.squads.slice(0, 2);
    const kept = new Set(squads.flatMap((squad) => squad.memberIds));
    const members = state.members.filter((member) => kept.has(member.id));
    const result = teamCheck({ ...state, squads, members });
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      { kind: '满编', text: `满员小队不足:2/${COMP.teamCheck.requiredFullSquads} 支` },
      { kind: '总坦克', text: `总坦克不足:2/${COMP.teamCheck.minTanks}` },
      { kind: '总治疗', text: `总治疗不足:2/${COMP.teamCheck.minHealers}` },
    ]);
  });

  it('空编成:不通过,满编/坦克/治疗三项全缺', () => {
    const result = teamCheck(stateWith([], []));
    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.kind)).toEqual(['满编', '总坦克', '总治疗']);
    expect(result.totals.assigned).toBe(0);
  });

  it('总治疗不足单独成立:职能覆盖达标但治疗总数低于门槛的配置可被分辨', () => {
    // 8 队满员、每队有坦克,但只有第 1 小队带 1 名治疗:覆盖达标(各队只要 1 坦 1 奶?不 —— 治疗覆盖也要求)
    // 设计上「职能覆盖」要求每队 1 坦 1 奶,因此本例同时触发各队缺治疗;总治疗计数仍独立结算。
    const state = fullTeamState();
    const healers = new Set<number>();
    for (const squad of state.squads) {
      healers.add(squad.memberIds[1]!);
    }
    // 把第 2..8 小队的治疗全部换成坦克(队内仍有坦克,但治疗为 0)
    const members = state.members.map((member) =>
      healers.has(member.id) && member.id !== state.squads[0]!.memberIds[1]
        ? synthMember(member.id, 'warrior', 'warrior-guard')
        : member,
    );
    const result = teamCheck({ ...state, members });
    expect(result.totals.healers).toBe(1);
    expect(result.totals.tanks).toBe(15); // 原有 8 坦 + 7 名治疗换职成坦
    expect(result.failures.some((failure) => failure.kind === '总治疗')).toBe(true);
    expect(result.failures.filter((failure) => failure.kind === '职能覆盖')).toHaveLength(7);
    expect(result.passed).toBe(false);
  });

  it('职能角色由职业+专精查表:换专精即换职能(数据驱动)', () => {
    const guard = synthMember(1, 'warrior', 'warrior-guard');
    const fury = synthMember(2, 'warrior', 'warrior-fury');
    const state = stateWith([guard, fury], [{ id: 1, memberIds: [1, 2] }]);
    const composition = squadCompositions(state)[0]!;
    expect(composition.roleCounts).toEqual({ 坦克: 1, 治疗: 0, 输出: 1 });
    expect(CLASS_BY_ID.get('warrior')!.specs.find((s) => s.id === 'warrior-guard')!.role).toBe('坦克');
  });
});
