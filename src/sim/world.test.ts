import { describe, expect, it } from 'vitest';
import { COMP } from '../content/comp';
import { GEAR_SLOTS } from '../content/gear';
import { RAID_BY_ID, RAID_SETTLEMENT, type RaidDef } from '../content/raids';
import { RIVAL_GUILDS, WORLD } from '../content/world';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from './clock';
import type { GuildCommand } from './commands';
import { SimulationFacade, decodeSave, encodeSave, step } from './facade';
import type { SimEvent } from './events';
import {
  computeRanking,
  createServerWorld,
  npcGuildScore,
  playerGrowthScore,
  playerWorldScore,
  repairCostFactor,
  serverLadder,
  serverRanking,
  settleWorldDay,
  settleWorldWeek,
} from './world';
import type { Applicant, GearItem, GameState, HonorWall, Member, Squad } from './state';

/**
 * T13 门面测试:虚拟服务器 —— NPC 公会群 + 全服新闻 + 橡皮筋。
 * 与全项目一致只打门面接缝:驱动 SimulationFacade / 纯函数 step 断言状态快照
 * 与事件日志;world 的纯函数按 T2–T12 先例直接断言。团本竞速场景用合成状态
 * (40 人满编超出指令可达规模),与 raid.test 同法;数值断言用内容常量独立重算。
 */

const SEED = 20261018;
const RAID = RAID_BY_ID.get('molten-abyss') as RaidDef;
const LADDER = serverLadder();
/** 标准 8 队的战力刻度(独立重算:职能分 27 × 光环 1.19,与 raid.test 同式)。 */
const FULL_CLEAR_ITEM_LEVEL = 85; // (85+27)×1.19 ≈ 133 ≥ 86+5:末首领必胜 ⇒ 全通确定
const TWO_KILL_ITEM_LEVEL = 34; // 首领 1/2 必胜;首领 3 硬门槛 36 未达 ⇒ 必团灭

/** 合成团员:只填团本结算涉及的维度(与 raid.test 同法)。 */
function synthMember(id: number, classId: string, specId: string, itemLevel: number): Member {
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
    gear: GEAR_SLOTS.map((slot) => ({ slot, quality: '蓝' as const, itemLevel })) as GearItem[],
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

/** 团本就绪状态:8 支满员标准小队 + 已开团,时钟停在周边界前 60 分钟。 */
function raidTeamState(itemLevel: number, options?: { seed?: number }): GameState {
  const base = new SimulationFacade(options?.seed ?? SEED, '星盾公会').state;
  const members: Member[] = [];
  const squads: Squad[] = [];
  for (let squadIndex = 0; squadIndex < COMP.teamCheck.requiredFullSquads; squadIndex++) {
    const squadMembers = standardSquadMembers(squadIndex * COMP.squadSize + 1, itemLevel);
    members.push(...squadMembers);
    squads.push({ id: squadIndex + 1, memberIds: squadMembers.map((m) => m.id) });
  }
  const chairman = synthMember(41, 'rogue', 'rogue-venom', itemLevel);
  members.push({ ...chairman, isChairman: true });
  return {
    ...base,
    members,
    nextMemberId: 42,
    squads,
    nextSquadId: 9,
    clockGameMinutes: GAME_MINUTES_PER_WEEK - 60,
    raidPlan: { raidId: RAID.id, openedAtGameMinutes: GAME_MINUTES_PER_WEEK - 120 },
  };
}

/** 全体团员换装等(慢曲线回暖:模拟回 5 人本提装等再回团本)。 */
function reequipAll(state: GameState, itemLevel: number): GameState {
  return {
    ...state,
    members: state.members.map((member) => ({
      ...member,
      gear: member.gear.map((item) => ({ ...item, itemLevel })),
    })),
  };
}

/** 驱动一步并返回新状态(事件另行累计)。 */
function drive(state: GameState, input: { command?: GuildCommand; deltaGameMinutes: number }): {
  state: GameState;
  events: readonly SimEvent[];
} {
  return step(state, input);
}

describe('虚拟服务器:NPC 公会群与排名(验收标准 1)', () => {
  it('上百 NPC 公会:竞争 + 背景合计过百,名字唯一,竞争公会来自内容表', () => {
    const world = createServerWorld(SEED);
    expect(world.guilds.length).toBeGreaterThanOrEqual(100);
    const rivals = world.guilds.filter((guild) => guild.kind === 'rival');
    const backgrounds = world.guilds.filter((guild) => guild.kind === 'background');
    expect(rivals).toHaveLength(RIVAL_GUILDS.length);
    expect(backgrounds).toHaveLength(WORLD.backgroundGuildCount);
    expect(rivals.map((guild) => guild.name)).toEqual(RIVAL_GUILDS.map((def) => def.name));
    expect(new Set(world.guilds.map((guild) => guild.name)).size).toBe(world.guilds.length); // 名字唯一
    // 正典背景公会在列(T12 去向文案已提及)
    expect(backgrounds.map((guild) => guild.name)).toContain('霜语会');
    expect(backgrounds.map((guild) => guild.name)).toContain('灰烬兄弟会');
    // 开服新闻就位(世界页从建会起有内容可看)
    expect(world.news).toHaveLength(1);
    expect(world.news[0]!.text).toContain(WORLD.serverName);
  });

  it('生成确定性:同种子 ⇒ 同一公会群;异种子 ⇒ 名字与排布不同', () => {
    expect(createServerWorld(SEED)).toEqual(createServerWorld(SEED));
    const other = createServerWorld(777);
    expect(other.guilds).toHaveLength(createServerWorld(SEED).guilds.length);
    expect(other.guilds.map((guild) => guild.name)).not.toEqual(
      createServerWorld(SEED).guilds.map((guild) => guild.name),
    );
  });

  it('排名榜:玩家 + 全部 NPC 同榜可浏览,并列时本会列前(确定性)', () => {
    const facade = new SimulationFacade(SEED, '星盾公会');
    const ranking = serverRanking(facade.state);
    expect(ranking.total).toBe(facade.state.world.guilds.length + 1);
    expect(ranking.entries).toHaveLength(ranking.total);
    expect(ranking.playerRank).toBeGreaterThanOrEqual(1);
    expect(ranking.playerRank).toBeLessThanOrEqual(ranking.total);
    // 分数单调不增(名次序正确)
    for (let i = 0; i + 1 < ranking.entries.length; i++) {
      expect(ranking.entries[i + 1]!.score).toBeLessThanOrEqual(ranking.entries[i]!.score);
    }
    // 并列时本会列前:构造同分的合成榜
    const guilds = createServerWorld(SEED).guilds.map((guild) => ({ ...guild, baseScore: 50, ladderProgress: 0 }));
    const tied = computeRanking(guilds, 50, 0, '并列测试会', 0);
    expect(tied.playerRank).toBe(1); // 全员同分,本会第一
  });

  it('排名分刻度:一杀压过全部成长分;背景公会极缓成长且有上限', () => {
    // 玩家成长分封顶(不足一杀)
    expect(playerGrowthScore(60, 100)).toBe(WORLD.ladder.playerGrowthCap);
    // 一杀 = scorePerBoss,压过任何成长分
    expect(playerWorldScore(1, 60, 100)).toBe(WORLD.ladder.scorePerBoss + WORLD.ladder.playerGrowthCap);
    // 背景公会:静止的不动,缓涨的每 driftWeeks 周 +1,封顶 driftCeiling
    const guilds = createServerWorld(SEED).guilds.filter((guild) => guild.kind === 'background');
    const staticGuild = guilds.find((guild) => guild.driftWeeks === 0)!;
    expect(npcGuildScore(staticGuild, 0)).toBe(npcGuildScore(staticGuild, 200));
    const drifting = guilds.find((guild) => guild.driftWeeks > 0)!;
    expect(npcGuildScore(drifting, 0)).toBe(drifting.baseScore);
    expect(npcGuildScore(drifting, drifting.driftWeeks * 2)).toBe(drifting.baseScore + 2);
    expect(npcGuildScore(drifting, 10_000)).toBeLessThanOrEqual(WORLD.background.driftCeiling);
  });
});

describe('橡皮筋:快推进曲线(验收标准 2 与 5)', () => {
  it('正常推进时玩家先杀:一夜全通,全部服务器首杀归玩家并发全服公告', () => {
    let state = raidTeamState(FULL_CLEAR_ITEM_LEVEL);
    const output = drive(state, { deltaGameMinutes: 60 });
    state = output.state;

    // 本会首杀(T12)与服务器首杀(T13)同时达成:5 名首领全部由玩家首杀
    expect(state.honorWall.firstKills).toHaveLength(RAID.bosses.length);
    expect(state.world.serverFirstKills).toHaveLength(RAID.bosses.length);
    expect(state.world.serverFirstKills.every((kill) => kill.byPlayer)).toBe(true);
    expect(state.world.serverFirstKills.every((kill) => kill.guildName === state.guild.name)).toBe(true);
    expect(state.world.serverFirstKills.map((kill) => kill.bossId)).toEqual(
      RAID.bosses.map((boss) => boss.id),
    );
    // 全服公告入事件流与新闻流
    const announcements = output.events.filter((event) => event.kind === '世界' && event.text.includes('全服首杀'));
    expect(announcements).toHaveLength(RAID.bosses.length);
    expect(state.world.news.filter((item) => item.text.includes('全服首杀'))).toHaveLength(RAID.bosses.length);
    // 无竞争公会夺杀的新闻
    expect(output.events.some((event) => event.text.includes('服务器首杀') && !event.text.includes('全服首杀'))).toBe(false);
  });

  it('慢半拍:竞争公会推进但始终落后玩家一个身位,拿不到首杀', () => {
    let state = raidTeamState(FULL_CLEAR_ITEM_LEVEL);
    state = drive(state, { deltaGameMinutes: 60 }).state;

    // 第 1 周后:玩家进度 5,竞争公会按「玩家进度 − lag」推进每周 1 名 ⇒ 全部停在 1
    const rivals = state.world.guilds.filter((guild) => guild.kind === 'rival');
    expect(rivals.every((guild) => guild.ladderProgress === WORLD.rubberBand.weeklyAdvance)).toBe(true);
    expect(rivals.every((guild) => guild.ladderProgress <= RAID.bosses.length - WORLD.rubberBand.lagBosses)).toBe(true);

    // 继续数周(全通后转备战下一档:装等逐周抬升,成长仍在 ⇒ 未停滞,
    // 竞争公会被锚拉住,停在玩家身后一个身位)
    for (let week = 0; week < 3; week++) {
      state = reequipAll(state, FULL_CLEAR_ITEM_LEVEL + 3 * (week + 1));
      state = drive(state, { command: { type: 'openRaid', raidId: RAID.id }, deltaGameMinutes: 0 }).state;
      state = drive(state, { deltaGameMinutes: GAME_MINUTES_PER_WEEK }).state;
    }
    const rivalsLater = state.world.guilds.filter((guild) => guild.kind === 'rival');
    // 长期无新进度后进入追赶(内容表 catchUp),但所有首杀早已名花有主
    expect(rivalsLater.every((guild) => guild.ladderProgress <= LADDER.length)).toBe(true);
    expect(state.world.serverFirstKills.every((kill) => kill.byPlayer)).toBe(true); // 首杀归属不变
  });

  it('玩家未参战时全服共同等待:竞争公会不推进、不发新闻', () => {
    // 新会只推进时间(连团本门槛都没到):竞争公会进度恒 0
    const facade = new SimulationFacade(SEED, '星盾公会');
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK * 4 });
    const rivals = facade.state.world.guilds.filter((guild) => guild.kind === 'rival');
    expect(rivals.every((guild) => guild.ladderProgress === 0)).toBe(true);
    expect(facade.state.world.serverFirstKills).toHaveLength(0);
  });
});

describe('橡皮筋:长期停滞曲线(验收标准 3 与 5)', () => {
  /** 慢曲线前半:第 1 夜杀 2 名首领后在硬门槛团灭,随后原地开荒数周(状态全静止)。 */
  function stalledCurve(): { state: GameState; events: SimEvent[] } {
    let state = raidTeamState(TWO_KILL_ITEM_LEVEL);
    const events: SimEvent[] = [];
    let output = drive(state, { deltaGameMinutes: 60 });
    state = output.state;
    events.push(...output.events);
    expect(state.honorWall.firstKills).toHaveLength(2); // 首领 1、2 已入墙
    // 之后每周再开团(装等不足,夜夜团灭在硬门槛)—— 三刻度全无增长的真停滞;
    // T18 起团本掉落更肥,前排两名的战利品会把团队装等抬过硬门槛、把「停滞」
    // 变回推进 —— 每周夜后把装备重置回 67,保住「原地开荒」的夹具语义
    for (let week = 0; week < 3; week++) {
      output = drive(state, { command: { type: 'openRaid', raidId: RAID.id }, deltaGameMinutes: 0 });
      state = output.state;
      output = drive(state, { deltaGameMinutes: GAME_MINUTES_PER_WEEK });
      state = reequipAll(output.state, TWO_KILL_ITEM_LEVEL);
      events.push(...output.events);
    }
    return { state, events };
  }

  it('停滞达阈值被超车:竞争公会夺走余下服务器首杀并发全服新闻', () => {
    const { state, events } = stalledCurve();
    // 停滞周数已到阈值
    expect(state.world.playerStallWeeks).toBeGreaterThanOrEqual(WORLD.rubberBand.stallWeeksToCatchUp);
    // 首领 1、2 归玩家;首领 3 起被竞争公会超车夺杀(先越过者 = 名单第一家)
    const kills = state.world.serverFirstKills;
    expect(kills.filter((kill) => kill.byPlayer)).toHaveLength(2);
    expect(kills.filter((kill) => !kill.byPlayer).length).toBeGreaterThanOrEqual(1);
    expect(kills.find((kill) => kill.bossId === RAID.bosses[2]!.id)?.guildName).toBe(RIVAL_GUILDS[0]!.name);
    // 超车新闻入事件流
    const overtakeNews = events.filter((event) => event.kind === '世界' && event.text.includes('服务器首杀'));
    expect(overtakeNews.length).toBeGreaterThanOrEqual(1);
    expect(state.world.news.some((item) => item.text.includes(RIVAL_GUILDS[0]!.name) && item.text.includes('服务器首杀'))).toBe(true);
    // 竞争公会推进越过玩家(超车之势)
    const rivals = state.world.guilds.filter((guild) => guild.kind === 'rival');
    expect(rivals.every((guild) => guild.ladderProgress > 2)).toBe(true);
  });

  it('被超车不锁内容:提装等后同样的首领照样杀,本会首杀照常入墙', () => {
    let { state } = { state: stalledCurve().state };
    const serverKillsBefore = state.world.serverFirstKills.length;

    // 回 5 人本提装等(合成:全团换装),再开团 —— 团本照常可打、可通
    state = reequipAll(state, FULL_CLEAR_ITEM_LEVEL);
    state = drive(state, { command: { type: 'openRaid', raidId: RAID.id }, deltaGameMinutes: 0 }).state;
    const output = drive(state, { deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    state = output.state;

    expect(state.lastRaidNight?.cleared).toBe(true); // 内容没有被锁:全通
    expect(state.honorWall.firstKills).toHaveLength(RAID.bosses.length); // 本会首杀补齐(含被夺服务器首杀的首领)
    // 已被夺走的服务器首杀不夺回;恢复期新增的首杀全归玩家(未被超车的首领照常首杀)
    expect(state.world.serverFirstKills.slice(0, serverKillsBefore)).toEqual(
      state.world.serverFirstKills.slice(0, serverKillsBefore),
    );
    expect(state.world.serverFirstKills.slice(serverKillsBefore).every((kill) => kill.byPlayer)).toBe(true);
    // 掉落照常发生(超车不影响 loot)
    expect(state.lastRaidNight!.bosses.reduce((sum, boss) => sum + boss.drops.length, 0)).toBe(
      RAID.bosses.reduce((sum, boss) => sum + boss.dropsPerKill, 0),
    );
  });

  it('橡皮筋回弹:玩家恢复推进后竞争公会停步等待,排名可反超', () => {
    let state = stalledCurve().state;
    const rivalProgressAtOvertake = state.world.guilds
      .filter((guild) => guild.kind === 'rival')
      .map((guild) => guild.ladderProgress);

    state = reequipAll(state, FULL_CLEAR_ITEM_LEVEL);
    state = drive(state, { command: { type: 'openRaid', raidId: RAID.id }, deltaGameMinutes: 0 }).state;
    state = drive(state, { deltaGameMinutes: GAME_MINUTES_PER_WEEK }).state; // 恢复推进的一周

    // 玩家进度回到 5,竞争公会被锚拉住:至多跟到玩家身后一名(目标 4),不再超车
    const rivalsAfter = state.world.guilds.filter((guild) => guild.kind === 'rival');
    expect(rivalsAfter.every((guild) => guild.ladderProgress <= RAID.bosses.length - WORLD.rubberBand.lagBosses)).toBe(true);
    expect(rivalsAfter.every((guild) => guild.ladderProgress >= rivalProgressAtOvertake[0]!)).toBe(true);
    // 排名反超:玩家满进度分压过一切 NPC
    const ranking = serverRanking(state);
    expect(ranking.playerRank).toBe(1);
    expect(ranking.entries[0]!.name).toBe(state.guild.name);
  });
});

describe('竞争公会的存在感:抬价与抢苗子(验收标准 4)', () => {
  /** 相位对齐的世界副本:让指定日的节律必然触发。 */
  function phasedWorld(world: GameState['world'], marketPhase: number, poachPhase: number): GameState['world'] {
    return { ...world, marketPhase, poachPhase };
  }

  it('抢苗子:相位日截走池中最好的一份,绝不截空,新闻可追溯', () => {
    const base = new SimulationFacade(SEED, '星盾公会').state;
    // 3 份申请:技艺档与等级各不相同(第 1 份最好:top 档 + 满级)
    const applicants: Applicant[] = [1, 2, 3].map((offset) => {
      const profile = structuredClone(base.members[0]!);
      return {
        applicationId: offset,
        profile: {
          ...profile,
          name: `苗子${offset}`,
          level: offset === 1 ? 60 : 30 + offset,
          skillTierId: offset === 1 ? 'top' : offset === 2 ? 'expert' : 'rookie',
        },
      };
    });

    // 日序 1(第 2 天)对齐截胡相位
    const world = phasedWorld(base.world, -1, 1); // marketPhase -1:行情永不触发(取模不为 0..11)
    const settled = settleWorldDay({ world, applicants, atGameMinutes: GAME_MINUTES_PER_DAY });
    expect(settled.applicants).toHaveLength(2); // 截走一份,剩两份
    expect(settled.applicants.map((applicant) => applicant.profile.name)).not.toContain('苗子1'); // 最好的被截
    expect(settled.news.join('')).toContain('苗子1');
    expect(settled.news.join('')).toContain(RIVAL_GUILDS[0]!.name); // 轮换第一家出手
    expect(settled.world.poachCount).toBe(1);

    // 池中只剩 1 份(minPoolLeft)时:相位日也不截空
    const one = settleWorldDay({
      world: settled.world,
      applicants: settled.applicants.slice(0, 1),
      atGameMinutes: GAME_MINUTES_PER_DAY * (1 + WORLD.poach.periodDays),
    });
    expect(one.applicants).toHaveLength(1);
  });

  it('抬价波:相位日掀起,修理金上浮到期回落;团灭修理实付按系数精确上浮', () => {
    const base = new SimulationFacade(SEED, '星盾公会').state;
    // ① 生命周期:相位日掀起(daysLeft = durationDays)→ 逐日倒数 → 归零回落
    let world = phasedWorld(base.world, 1, -1); // poachPhase -1:截胡永不触发
    expect(repairCostFactor(world)).toBe(1);
    const start = settleWorldDay({ world, applicants: [], atGameMinutes: GAME_MINUTES_PER_DAY });
    expect(start.world.marketWave?.daysLeft).toBe(WORLD.market.durationDays);
    expect(start.news.join('')).toContain('行情看涨');
    expect(repairCostFactor(start.world)).toBeCloseTo(1 + WORLD.market.repairMarkupPercent / 100, 10);

    let current = start.world;
    let fellText = '';
    for (let day = 2; day <= WORLD.market.durationDays + 1; day++) {
      const daySettle = settleWorldDay({
        world: current,
        applicants: [],
        atGameMinutes: GAME_MINUTES_PER_DAY * day,
      });
      current = daySettle.world;
      if (daySettle.news.length > 0) {
        fellText = daySettle.news.join('');
      }
    }
    expect(current.marketWave).toBeUndefined(); // 到期回落
    expect(fellText).toContain('行情回落');
    expect(repairCostFactor(current)).toBe(1);

    // ② 传导到团灭修理金:抬价期团灭,实付 = 内容表基价 × 系数(四舍五入)
    const wiped = raidTeamState(TWO_KILL_ITEM_LEVEL);
    const markedUp: GameState = {
      ...wiped,
      world: { ...wiped.world, marketWave: { daysLeft: 3, guildName: RIVAL_GUILDS[0]!.name } },
    };
    const night = drive(markedUp, { deltaGameMinutes: 60 });
    const expectedRepair = Math.round(
      RAID_SETTLEMENT.wipeRepairGoldPerRaider * 40 * (1 + WORLD.market.repairMarkupPercent / 100),
    );
    expect(night.state.lastRaidNight?.wipe?.repairGold).toBe(expectedRepair);
    expect(expectedRepair).toBeGreaterThan(RAID_SETTLEMENT.wipeRepairGoldPerRaider * 40); // 幅度可感知
  });

  it('轻量:截胡与抬价都只动自己的面 —— 名册/金库/荣誉墙不受影响', () => {
    const before = raidTeamState(TWO_KILL_ITEM_LEVEL);
    const poachDay = drive(before, { deltaGameMinutes: 60 });
    // 团本夜照常结算(存在感不掠夺:只影响修理金与申请池,不动玩法结果本身)
    expect(poachDay.state.lastRaidNight?.bosses[0]?.killed).toBe(true);
    expect(poachDay.state.honorWall.firstKills.length).toBeGreaterThan(0);
  });
});

describe('虚拟服务器:门面接缝与存档(验收标准 1 与 5)', () => {
  it('确定性:同种子同脚本 ⇒ 世界状态与新闻逐字节一致', () => {
    const run = (): string => {
      const facade = new SimulationFacade(SEED, '星盾公会');
      facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK * 2 });
      return JSON.stringify(facade.state.world);
    };
    expect(run()).toBe(run());
  });

  it('新闻流封顶:超容裁旧,总量有界(长离线不撑爆存档)', () => {
    // 预填满额旧闻,再在截胡相位日触发一条新新闻 ⇒ 仍是 newsKeepCount 条(最旧的被裁)
    const base = new SimulationFacade(SEED, '星盾公会').state;
    const stuffed = {
      ...base.world,
      news: Array.from({ length: WORLD.newsKeepCount }, (_, index) => ({
        atGameMinutes: index,
        text: `旧闻${index}`,
      })),
    };
    const applicants: Applicant[] = [1, 2].map((offset) => {
      const profile = structuredClone(base.members[0]!);
      return { applicationId: offset, profile: { ...profile, name: `苗子${offset}` } };
    });
    const settled = settleWorldDay({
      world: { ...stuffed, poachPhase: 3, marketPhase: -1 },
      applicants,
      atGameMinutes: GAME_MINUTES_PER_DAY * 3, // 日序 3 = 截胡相位日
    });
    expect(settled.world.news).toHaveLength(WORLD.newsKeepCount);
    expect(settled.world.news[0]!.text).toBe('旧闻1'); // 最旧的「旧闻0」被裁
    expect(settled.world.news.at(-1)!.text).toContain('截胡'); // 新的排最后
  });

  it('周结算纯函数:锚与停滞计数正确推进(不消费随机链)', () => {
    const base = new SimulationFacade(SEED, '星盾公会').state;
    const wall: HonorWall = {
      firstKills: [
        {
          raidId: RAID.id,
          raidName: RAID.name,
          bossId: RAID.bosses[0]!.id,
          bossName: RAID.bosses[0]!.name,
          atGameMinutes: 0,
        },
      ],
      milestones: [],
      rareDrops: [],
      rankLadder: [],
    };
    // 第 1 周:玩家杀首领 1(有推进)⇒ 停滞清零、锚更新
    const week1 = settleWorldWeek({
      world: base.world,
      honorWall: wall,
      guildName: '测试公会',
      atGameMinutes: GAME_MINUTES_PER_WEEK,
      tonightKilledBossIds: [RAID.bosses[0]!.id],
      averageLevel: 55,
      averageItemLevel: 62,
    });
    expect(week1.world.playerStallWeeks).toBe(0);
    expect(week1.world.anchor).toEqual({ ladderProgress: 1, averageLevel: 55, averageItemLevel: 62 });
    expect(week1.world.serverFirstKills.filter((kill) => kill.byPlayer)).toHaveLength(1);
    // 竞争公会推进到「玩家进度 − lag」= 0,无推进
    expect(week1.world.guilds.filter((guild) => guild.kind === 'rival').every((guild) => guild.ladderProgress === 0)).toBe(true);

    // 第 2 周:提装等中(平均装等 62 → 65)⇒ 仍是推进,停滞不累计,竞争公会被锚拉住
    const week2 = settleWorldWeek({
      world: week1.world,
      honorWall: wall,
      guildName: '测试公会',
      atGameMinutes: GAME_MINUTES_PER_WEEK * 2,
      tonightKilledBossIds: [],
      averageLevel: 55,
      averageItemLevel: 65,
    });
    expect(week2.world.playerStallWeeks).toBe(0);
    // 第 3 周:三刻度全静止 ⇒ 停滞 1(尚未到阈值,不追赶)
    const week3 = settleWorldWeek({
      world: week2.world,
      honorWall: wall,
      guildName: '测试公会',
      atGameMinutes: GAME_MINUTES_PER_WEEK * 3,
      tonightKilledBossIds: [],
      averageLevel: 55,
      averageItemLevel: 65,
    });
    expect(week3.world.playerStallWeeks).toBe(1);
    expect(
      week3.world.guilds.filter((guild) => guild.kind === 'rival').every((guild) => guild.ladderProgress === 0),
    ).toBe(true);
    // 第 4 周:停滞到阈值 ⇒ 追赶 +catchUpWeeklyAdvance(玩家已开局,不再全服等待)
    const week4 = settleWorldWeek({
      world: week3.world,
      honorWall: wall,
      guildName: '测试公会',
      atGameMinutes: GAME_MINUTES_PER_WEEK * 4,
      tonightKilledBossIds: [],
      averageLevel: 55,
      averageItemLevel: 65,
    });
    expect(week4.world.playerStallWeeks).toBe(2);
    expect(
      week4.world.guilds
        .filter((guild) => guild.kind === 'rival')
        .every((guild) => guild.ladderProgress === WORLD.rubberBand.catchUpWeeklyAdvance),
    ).toBe(true);
    // 追赶越过的首领 2 未被认领 ⇒ 名单第一家夺得服务器首杀并发新闻
    const claims = week4.world.serverFirstKills.filter((kill) => !kill.byPlayer);
    expect(claims.map((kill) => kill.bossId)).toEqual([RAID.bosses[1]!.id]);
    expect(claims[0]!.guildName).toBe(RIVAL_GUILDS[0]!.name);
    expect(week4.news.join('')).toContain('服务器首杀');
  });

  it('存档:v9 随状态落盘往返稳定;v8 旧档迁移补世界并结转玩家首杀', () => {
    const state = raidTeamState(FULL_CLEAR_ITEM_LEVEL);
    const settled = drive(state, { deltaGameMinutes: 60 }).state;
    // v9 往返:世界连同首杀榜与新闻一起落盘,恢复后可继续
    const restored = decodeSave(encodeSave(settled))!;
    expect(restored.world).toEqual(settled.world);
    const facade = new SimulationFacade(0, undefined, restored);
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    expect(facade.state.world.serverFirstKills.every((kill) => kill.byPlayer)).toBe(true);

    // v8 形状:剥掉世界(还原 v8 时代的真实存档形状),迁移后按种子补生成
    const legacyState = JSON.parse(
      JSON.stringify(settled, (key, value) => (key === 'world' ? undefined : value)),
    ) as GameState;
    const v8File = JSON.stringify({ kind: 'wowidle-save', version: 8, state: legacyState });
    const migrated = decodeSave(v8File)!;
    expect(migrated.world.guilds).toHaveLength(settled.world.guilds.length);
    // 玩家已得的本会首杀按服务器首杀结转(署玩家公会名),进度锚同步
    expect(migrated.world.serverFirstKills).toHaveLength(RAID.bosses.length);
    expect(migrated.world.serverFirstKills.every((kill) => kill.byPlayer && kill.guildName === settled.guild.name)).toBe(true);
    expect(migrated.world.anchor.ladderProgress).toBe(RAID.bosses.length);
  });
});
