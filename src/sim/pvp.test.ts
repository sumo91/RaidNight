import { describe, expect, it } from 'vitest';
import { DUNGEON_SETTLEMENT } from '../content/dungeons';
import { GEAR_SLOTS } from '../content/gear';
import { BATTLEFIELD_BY_ID, HONOR_GEAR_BY_ID, PVP_SETTLEMENT } from '../content/pvp';
import { GAME_MINUTES_PER_DAY } from './clock';
import { SimulationFacade, decodeSave, encodeSave } from './facade';
import type { GameState, GearItem, Member, Squad } from './state';

/**
 * T16 门面测试:PvP —— 战场梯度 + 荣誉阶梯 + 军装。
 * 与全项目一致只打门面接缝:驱动 SimulationFacade(内含合成状态的 step)断言
 * 状态快照与事件日志。数值断言全部用内容常量独立重算(不复用结算实现的代码路径)。
 *
 * 场景基线:标准小队(战士·铁壁 + 牧师·圣言 + 法师三系)× 2 支,全员 Lv60、
 * 装等 30 —— 第 1 梯度「砾石哨垒」已解锁(门槛 Lv20/装等16),第 2 梯度装等
 * 门槛 34 未达。战场队战力按统一结算引擎独立重算:
 * (有效装等 + 职能分)×(1 + 光环%),职能分封顶按小队数缩放,
 * 光环 = 战吼6(战士)+ 抚慰颂歌8(牧师)+ 奥能共鸣5(法师,同职业去重)= 19%/小队。
 */

const SEED = 20261018;
const G1 = BATTLEFIELD_BY_ID.get('gravel-bulwark')!;
const G2 = BATTLEFIELD_BY_ID.get('frostring-vale')!;

/** 标准小队职能分(封顶 2/2/3、perTank3/perHealer3/perDps5;封顶按小队数缩放)。 */
function roleScoreOf(squadCount: number): number {
  const { perTank, tankCap, perHealer, healerCap, perDps, dpsCap } = DUNGEON_SETTLEMENT.roleScore;
  // 每队 1 坦 1 奶 3 输出;N 队 = N/N/3N,封顶 ×N 后坦奶恰在封顶、输出恰满编
  return (
    Math.min(squadCount, tankCap * squadCount) * perTank +
    Math.min(squadCount, healerCap * squadCount) * perHealer +
    Math.min(3 * squadCount, dpsCap * squadCount) * perDps
  );
}

/** 标准小队光环合计百分比(内容表常量重算)。 */
const AURA_PER_SQUAD = 6 + 8 + 5;

/** 战场队战力(统一结算引擎公式重算):(有效装等 + 职能分)×(1 + 光环%)。 */
function expectedPower(effectiveItemLevel: number, squadCount: number): number {
  return (effectiveItemLevel + roleScoreOf(squadCount)) * (1 + AURA_PER_SQUAD / 100);
}

/** 三段式胜率(引擎公式重算):下界(目标−failMargin)取 0,上界(目标+winMargin)取 1。 */
function expectedChance(power: number, target: number): number {
  const { failMargin, winMargin } = DUNGEON_SETTLEMENT;
  const lower = target - failMargin;
  const upper = target + winMargin;
  return Math.max(0, Math.min(1, (power - lower) / (upper - lower)));
}

/** 合成团员:只填战场结算与军装兑换涉及的维度;可注入逐件战场向属性(军装效果)。 */
function synthMember(
  id: number,
  classId: string,
  specId: string,
  itemLevel: number,
  options?: { pvpPowerPerSlot?: number },
): Member {
  const pvpPowerPerSlot = options?.pvpPowerPerSlot ?? 0;
  return {
    id,
    isChairman: false,
    joinedAtGameMinutes: 0,
    benchDays: 0,
    name: `合成团员${id}`,
    classId,
    specId,
    level: 60,
    experience: 0,
    gear: GEAR_SLOTS.map(
      (slot) =>
        ({
          slot,
          quality: '蓝' as const,
          itemLevel,
          ...(pvpPowerPerSlot > 0 ? { pvpPower: pvpPowerPerSlot } : {}),
        }) as GearItem,
    ),
    mood: 80,
    loyalty: 80,
    fatigue: 0,
    personalGold: 0,
    dkp: 0,
    attendance: { styleId: 'iron', baseRate: 95 },
    traits: [],
    skillTierId: 'skilled',
    bossKills: 0,
    rareLootWon: 0,
  };
}

/** 标准小队成员:1 坦(战士·铁壁)+ 1 奶(牧师·圣言)+ 3 输出(法师三系)。 */
function standardSquadMembers(
  startId: number,
  itemLevel: number,
  options?: { pvpPowerPerSlot?: number },
): Member[] {
  const make = (id: number, classId: string, specId: string) =>
    synthMember(id, classId, specId, itemLevel, options);
  return [
    make(startId, 'warrior', 'warrior-guard'),
    make(startId + 1, 'priest', 'priest-light'),
    make(startId + 2, 'mage', 'mage-arcane'),
    make(startId + 3, 'mage', 'mage-flame'),
    make(startId + 4, 'mage', 'mage-frost'),
  ];
}

/**
 * 战场就绪的合成状态:N 支满员标准小队(id 自 1 起)+ 可调荣誉账本。
 * 名册只含小队成员 ⇒ 公会平均等级 60、平均装等 = 合成装等。
 */
function pvpState(
  options?: { squadCount?: number; itemLevel?: number; pvpPowerPerSlot?: number; honorPoints?: number; honorCareer?: number },
): GameState {
  const squadCount = options?.squadCount ?? 2;
  const base = new SimulationFacade(SEED, '战场测试公会').state;
  const members: Member[] = [];
  const squads: Squad[] = [];
  for (let squadIndex = 0; squadIndex < squadCount; squadIndex++) {
    const squadMembers = standardSquadMembers(
      squadIndex * 5 + 1,
      options?.itemLevel ?? 30,
      options?.pvpPowerPerSlot !== undefined ? { pvpPowerPerSlot: options.pvpPowerPerSlot } : undefined,
    );
    members.push(...squadMembers);
    squads.push({ id: squadIndex + 1, memberIds: squadMembers.map((member) => member.id) });
  }
  return {
    ...base,
    members,
    nextMemberId: squadCount * 5 + 1,
    squads,
    nextSquadId: squadCount + 1,
    honor: { points: options?.honorPoints ?? 0, career: options?.honorCareer ?? 0 },
  };
}

describe('战场:编队与梯度进入(验收标准 1)', () => {
  it('满职能小队可编入战场队,事件可见队内序号;已在战场不重复编入', () => {
    const facade = new SimulationFacade(SEED, '战场测试公会', pvpState());
    const first = facade.dispatch({
      command: { type: 'assignBattlefield', squadId: 1, battlefieldId: G1.id },
      deltaGameMinutes: 0,
    });
    expect(first.state.squads[0]!.activity).toEqual({ type: 'battlefield', battlefieldId: G1.id });
    expect(
      first.events.some((event) => event.kind === '战场' && event.text.includes(`进驻「${G1.name}」`) && event.text.includes('1/3')),
    ).toBe(true);

    const second = facade.dispatch({
      command: { type: 'assignBattlefield', squadId: 2, battlefieldId: G1.id },
      deltaGameMinutes: 0,
    });
    expect(
      second.events.some((event) => event.text.includes('2/3')),
    ).toBe(true);

    // 重复编入同一战场:无变化、无事件
    const repeat = facade.dispatch({
      command: { type: 'assignBattlefield', squadId: 1, battlefieldId: G1.id },
      deltaGameMinutes: 0,
    });
    expect(repeat.events).toHaveLength(0);
    expect(repeat.state.squads[0]!.activity).toEqual({ type: 'battlefield', battlefieldId: G1.id });
  });

  it('梯度门槛未达(装等不足)不可进入;编成不齐的小队被拒', () => {
    const facade = new SimulationFacade(SEED, '战场测试公会', pvpState());
    // 公会平均装等 30 < 第 2 梯度门槛 34:忽略
    const locked = facade.dispatch({
      command: { type: 'assignBattlefield', squadId: 1, battlefieldId: G2.id },
      deltaGameMinutes: 0,
    });
    expect(locked.events).toHaveLength(0);
    expect(locked.state.squads[0]!.activity).toBeUndefined();

    // 编成不齐(调离一人后 4/5):忽略
    facade.dispatch({ command: { type: 'removeFromSquad', memberId: 2 }, deltaGameMinutes: 0 });
    const refused = facade.dispatch({
      command: { type: 'assignBattlefield', squadId: 1, battlefieldId: G1.id },
      deltaGameMinutes: 0,
    });
    expect(refused.events.filter((event) => event.kind === '战场')).toHaveLength(0);
    expect(refused.state.squads[0]!.activity).toBeUndefined();
  });

  it('战场队上限 3 支小队:第 4 支不可再编入同一战场', () => {
    const facade = new SimulationFacade(SEED, '战场测试公会', pvpState({ squadCount: 4 }));
    for (const squadId of [1, 2, 3]) {
      facade.dispatch({ command: { type: 'assignBattlefield', squadId, battlefieldId: G1.id }, deltaGameMinutes: 0 });
    }
    const overflow = facade.dispatch({
      command: { type: 'assignBattlefield', squadId: 4, battlefieldId: G1.id },
      deltaGameMinutes: 0,
    });
    expect(overflow.events).toHaveLength(0); // 门面静默拒绝(队满)
    expect(overflow.state.squads[3]!.activity).toBeUndefined();
    expect(PVP_SETTLEMENT.maxSquadsPerBattlefield).toBe(3);
  });

  it('撤出战场:活动清空、事件可见', () => {
    const facade = new SimulationFacade(SEED, '战场测试公会', pvpState());
    facade.dispatch({ command: { type: 'assignBattlefield', squadId: 1, battlefieldId: G1.id }, deltaGameMinutes: 0 });
    const out = facade.dispatch({ command: { type: 'stopBattlefield', squadId: 1 }, deltaGameMinutes: 0 });
    expect(out.state.squads[0]!.activity).toBeUndefined();
    expect(out.events.some((event) => event.kind === '战场' && event.text.includes('撤出战场'))).toBe(true);
  });
});

describe('战场结算与荣誉累积(验收标准 2、4)', () => {
  it('两支小队的战场队按第 1 梯度结算:必胜区间连捷,荣誉与生涯荣誉双双入账', () => {
    const facade = new SimulationFacade(SEED, '战场测试公会', pvpState());
    facade.dispatch({ command: { type: 'assignBattlefield', squadId: 1, battlefieldId: G1.id }, deltaGameMinutes: 0 });
    facade.dispatch({ command: { type: 'assignBattlefield', squadId: 2, battlefieldId: G1.id }, deltaGameMinutes: 0 });
    const out = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });

    // 战力独立重算:装等 30 + 职能分 42(2 队缩放)× 光环 1.19 = 85.68,对目标 66 必胜
    const power = expectedPower(30, 2);
    expect(power).toBeCloseTo((30 + 42) * 1.19, 10);
    expect(expectedChance(power, G1.difficultyTarget)).toBe(1);

    // 荣誉账本:两场全胜,荣誉点与生涯荣誉同额进账
    expect(out.state.honor).toEqual({ points: 2 * G1.honorPerWin, career: 2 * G1.honorPerWin });

    // 结果卡:胜负、三要素、战场队构成与荣誉快照
    const report = out.state.lastBattlefieldReport!;
    expect(report.battlefieldId).toBe(G1.id);
    expect(report.gradient).toBe(1);
    expect(report.victory).toBe(true);
    expect(report.band).toBe('必胜');
    expect(report.successChance).toBe(1);
    expect(report.power).toBeCloseTo(power, 9);
    expect(report.target).toBe(G1.difficultyTarget);
    expect(report.squadOrdinals).toEqual([1, 2]);
    expect(report.teamSize).toBe(10);
    expect(report.honorGained).toBe(G1.honorPerWin); // 结果卡记最后一场
    expect(report.pvpPowerTotal).toBe(0); // 未着军装

    // 事件日志:两场告捷逐场可见
    const victories = out.events.filter((event) => event.kind === '战场' && event.text.includes('告捷'));
    expect(victories).toHaveLength(G1.battlesPerDay);

    // 出战团员:两场积劳 +2×7,士气 +2×3
    const member = out.state.members[0]!;
    expect(member.fatigue).toBe(G1.battlesPerDay * G1.fatiguePerBattle);
    expect(member.mood).toBe(80 + G1.battlesPerDay * PVP_SETTLEMENT.victoryMoodBoost);
  });

  it('单支小队硬闯第 1 梯度:必败区间连败,只有安慰荣誉', () => {
    const facade = new SimulationFacade(SEED, '战场测试公会', pvpState({ squadCount: 1, itemLevel: 28 }));
    facade.dispatch({ command: { type: 'assignBattlefield', squadId: 1, battlefieldId: G1.id }, deltaGameMinutes: 0 });
    const out = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });

    const power = expectedPower(28, 1); // (28+21)×1.19 = 58.31,对目标 66 必败
    expect(power).toBeCloseTo((28 + 21) * 1.19, 10);
    expect(expectedChance(power, G1.difficultyTarget)).toBe(0);

    expect(out.state.honor).toEqual({ points: 2 * G1.honorPerLoss, career: 2 * G1.honorPerLoss });
    const report = out.state.lastBattlefieldReport!;
    expect(report.victory).toBe(false);
    expect(report.band).toBe('必败');
    expect(report.honorGained).toBe(G1.honorPerLoss);
    expect(out.events.some((event) => event.kind === '战场' && event.text.includes('失利'))).toBe(true);
    const member = out.state.members[0]!;
    expect(member.mood).toBe(80 - G1.battlesPerDay * PVP_SETTLEMENT.defeatMoodHit);
  });

  it('军衔随生涯荣誉晋升:跨过门槛当日入荣誉墙并发事件(可观察)', () => {
    // 生涯荣誉 140,距「中士」门槛 150 差 10:两场全胜 +60 ⇒ 200,晋升第 2 阶
    const facade = new SimulationFacade(SEED, '战场测试公会', pvpState({ honorCareer: 140 }));
    facade.dispatch({ command: { type: 'assignBattlefield', squadId: 1, battlefieldId: G1.id }, deltaGameMinutes: 0 });
    facade.dispatch({ command: { type: 'assignBattlefield', squadId: 2, battlefieldId: G1.id }, deltaGameMinutes: 0 });
    const out = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });

    expect(out.state.honor.career).toBe(200);
    expect(out.state.honorWall.rankLadder).toEqual([
      { rankId: 'sergeant', name: '中士', atGameMinutes: GAME_MINUTES_PER_DAY },
    ]);
    const promotion = out.events.find((event) => event.kind === '战场' && event.text.includes('军衔晋升'));
    expect(promotion).toBeDefined();
    expect(promotion!.text).toContain('「中士」');
  });

  it('确定性:同种子同输入序列 ⇒ 同状态与同事件日志', () => {
    const run = () => {
      const facade = new SimulationFacade(SEED, '战场测试公会', pvpState());
      facade.dispatch({ command: { type: 'assignBattlefield', squadId: 1, battlefieldId: G1.id }, deltaGameMinutes: 0 });
      facade.dispatch({ command: { type: 'assignBattlefield', squadId: 2, battlefieldId: G1.id }, deltaGameMinutes: 0 });
      return facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY * 3 });
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });
});

describe('军装:兑换、穿戴与战场向属性(验收标准 3、4)', () => {
  const BLUE_HEAD = HONOR_GEAR_BY_ID.get('staff-sergeant-头')!;

  it('军衔达标且荣誉点充足:兑换即穿上,战场向属性入格、荣誉点扣减', () => {
    // 生涯荣誉 450 = 军士长(第 3 阶)⇒ 军士长战装(需第 3 阶)可兑
    const facade = new SimulationFacade(SEED, '战场测试公会', pvpState({ honorPoints: BLUE_HEAD.costHonor, honorCareer: 450 }));
    const out = facade.dispatch({
      command: { type: 'redeemHonorGear', memberId: 1, gearId: BLUE_HEAD.id },
      deltaGameMinutes: 0,
    });
    expect(out.state.honor).toEqual({ points: 0, career: 450 }); // 只花荣誉点,不降衔
    const head = out.state.members[0]!.gear.find((gear) => gear.slot === '头')!;
    expect(head).toEqual({ slot: '头', quality: '蓝', itemLevel: BLUE_HEAD.itemLevel, pvpPower: BLUE_HEAD.pvpPower });
    expect(out.events.some((event) => event.kind === '战场' && event.text.includes('军装兑换') && event.text.includes('合成团员1'))).toBe(true);
  });

  it('军衔不足或荣誉点不足:门面静默拒绝,状态与事件不变', () => {
    // 军衔不足:百夫长战装需第 4 阶(生涯荣誉 1100),当前军士长(450)
    const facade = new SimulationFacade(SEED, '战场测试公会', pvpState({ honorPoints: 5000, honorCareer: 450 }));
    const rankBlocked = facade.dispatch({
      command: { type: 'redeemHonorGear', memberId: 1, gearId: 'centurion-头' },
      deltaGameMinutes: 0,
    });
    expect(rankBlocked.events).toHaveLength(0);
    expect(rankBlocked.state.honor.points).toBe(5000);

    // 荣誉点不足:军士长战装 90 点,只有 50 点
    const poor = new SimulationFacade(SEED, '战场测试公会', pvpState({ honorPoints: 50, honorCareer: 450 }));
    const refused = poor.dispatch({
      command: { type: 'redeemHonorGear', memberId: 1, gearId: BLUE_HEAD.id },
      deltaGameMinutes: 0,
    });
    expect(refused.events).toHaveLength(0);
    expect(refused.state.honor.points).toBe(50);
  });

  it('军装的战场向属性只在战场结算计入:同装等下,着军装翻盘', () => {
    // 对照组:单队装等 28、无军装 ⇒ 必败(见前);实验组:同装等 + 每件战场向属性 +2
    const plain = new SimulationFacade(SEED, '战场测试公会', pvpState({ squadCount: 1, itemLevel: 28 }));
    plain.dispatch({ command: { type: 'assignBattlefield', squadId: 1, battlefieldId: G1.id }, deltaGameMinutes: 0 });
    const plainOut = plain.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(plainOut.state.lastBattlefieldReport!.victory).toBe(false);

    const geared = new SimulationFacade(
      SEED,
      '战场测试公会',
      pvpState({ squadCount: 1, itemLevel: 28, pvpPowerPerSlot: 2 }),
    );
    geared.dispatch({ command: { type: 'assignBattlefield', squadId: 1, battlefieldId: G1.id }, deltaGameMinutes: 0 });
    const gearedOut = geared.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });

    // 有效装等 = 28 + 8件×2 = 44:(44+21)×1.19 = 77.35,对目标 66 必胜
    const effective = 28 + GEAR_SLOTS.length * 2;
    const report = gearedOut.state.lastBattlefieldReport!;
    expect(report.victory).toBe(true);
    expect(report.band).toBe('必胜');
    expect(report.power).toBeCloseTo(expectedPower(effective, 1), 9);
    expect(report.pvpPowerTotal).toBe(5 * GEAR_SLOTS.length * 2); // 5 人 × 8 件 × 2
    // 荣誉进账随之翻盘为胜场全额
    expect(gearedOut.state.honor.points).toBe(2 * G1.honorPerWin);
  });
});

describe('存档:荣誉账本与军衔记录随档落盘(v12)', () => {
  it('编码/解码往返:荣誉账本与战场结果卡无损', () => {
    const facade = new SimulationFacade(SEED, '战场测试公会', pvpState({ honorCareer: 140 }));
    facade.dispatch({ command: { type: 'assignBattlefield', squadId: 1, battlefieldId: G1.id }, deltaGameMinutes: 0 });
    facade.dispatch({ command: { type: 'assignBattlefield', squadId: 2, battlefieldId: G1.id }, deltaGameMinutes: 0 });
    const out = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });

    const restored = decodeSave(encodeSave(out.state, 12345));
    expect(restored).not.toBeNull();
    expect(restored!.honor).toEqual(out.state.honor);
    expect(restored!.lastBattlefieldReport).toEqual(out.state.lastBattlefieldReport);
    expect(restored!.honorWall.rankLadder).toEqual(out.state.honorWall.rankLadder);
  });

  it('v11 旧档迁移:补零荣誉账本与空军衔记录,迁移后可玩', () => {
    const facade = new SimulationFacade(SEED, '战场测试公会', pvpState({ honorCareer: 200 }));
    // 剥掉 v12 新增字段,还原 v11 时代的存档形状
    const legacy = JSON.parse(
      JSON.stringify(facade.state, (key, value) =>
        key === 'honor' || key === 'lastBattlefieldReport' || key === 'rankLadder' ? undefined : value,
      ),
    );
    const migrated = decodeSave(JSON.stringify({ version: 11, state: legacy }))!;
    expect(migrated.honor).toEqual({ points: 0, career: 0 });
    expect(migrated.honorWall.rankLadder).toEqual([]);
    // 迁移后直接可玩
    const resumed = new SimulationFacade(SEED, undefined, migrated);
    resumed.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(resumed.state.clockGameMinutes).toBe(GAME_MINUTES_PER_DAY);
  });
});
