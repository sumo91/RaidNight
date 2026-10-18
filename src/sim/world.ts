/**
 * 虚拟服务器(T13,GLOSSARY:虚拟服务器/竞争公会/背景公会/橡皮筋/首杀)。
 *
 * 玩家公会所在的模拟服务器生态:上百 NPC 公会(多数背景公会营造规模感,
 * 少数竞争公会有成长曲线)的排名、全服新闻与服务器首杀。
 * 橡皮筋:竞争公会进度以玩家进度为锚 —— 玩家正常推进(击杀新首领,或平均
 * 等级/装等仍在增长)时对方慢半拍,长期停滞(周快照全无增长)时对方才
 * 超车并发全服新闻;超车不锁内容、不拿走本会首杀,玩家随时可以反超回去。
 * 竞争公会另以市场抬价(团灭修理金短期上浮)与抢申请池苗子刷存在感:
 * 轻量、可感知、到期回落 / 绝不截空。
 *
 * 本模块只有纯函数:公会群由种子确定性生成(独立盐化随机链,不动共享链);
 * 日/周结算完全不消费随机 —— 抬价波与抢苗子按「日序 % 周期 === 相位」的
 * 确定性节律触发(相位由建会种子定,存档间有差异),橡皮筋只由锚推导。
 * 一切可调数值与文案在 content/world.ts(数据驱动);结算编排在门面的
 * 日/周边界(sim/facade.ts)。
 */

import {
  GUILD_NAME_PREFIXES,
  GUILD_NAME_SUFFIXES,
  POACH_NEWS_POOL,
  RIVAL_GUILDS,
  WORLD,
} from '../content/world';
import { SKILL_TIERS } from '../content/skill-tiers';
import { RAIDS } from '../content/raids';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from './clock';
import { nextInt, pickOne } from './rng';
import { guildAverageItemLevel, guildAverageLevel } from './roster';
import type {
  Applicant,
  HonorWall,
  MemberProfile,
  NpcGuild,
  ServerFirstKill,
  ServerWorld,
} from './state';

/** 服务器阶梯的一名首领:各团本按难度档序拼接、首领按序,即全服竞速的赛道。 */
export interface LadderBoss {
  readonly raidId: string;
  readonly raidName: string;
  readonly raidTier: number;
  readonly bossId: string;
  readonly bossName: string;
}

/** 服务器阶梯(内容表派生:团本按档序,首领按结算顺序)。 */
export function serverLadder(): readonly LadderBoss[] {
  return [...RAIDS]
    .sort((a, b) => a.tier - b.tier)
    .flatMap((raid) =>
      raid.bosses.map((boss) => ({
        raidId: raid.id,
        raidName: raid.name,
        raidTier: raid.tier,
        bossId: boss.id,
        bossName: boss.name,
      })),
    );
}

/** 生成世界时的独立随机链种子(与共享链互不干扰,重放不受影响)。 */
const WORLD_CHAIN_SALT = 0x2545f491;

/** 世界生成的可选锚点:旧档迁移时结转玩家已有进度(建会时缺省为空)。 */
export interface CreateWorldOptions {
  /** 已有的荣誉墙:其首杀徽章按玩家服务器首杀结转,锚取当前进度。 */
  readonly honorWall?: HonorWall;
  /** 玩家公会名(结转服务器首杀的署名)。 */
  readonly guildName?: string;
  /** 结转时刻(建会 = 0)。 */
  readonly atGameMinutes?: number;
}

/**
 * 生成虚拟服务器(确定性:同种子 ⇒ 同一 NPC 公会群与开服新闻)。
 * 背景公会名 = 前缀 × 后缀去重组合(「霜语会」「灰烬兄弟会」为既有去向文案
 * 中的正典背景公会,固定在列);竞争公会自内容表取,推进从 0 起。
 */
export function createServerWorld(seed: number, options?: CreateWorldOptions): ServerWorld {
  let rng = (seed | 0) ^ WORLD_CHAIN_SALT;
  const atGameMinutes = options?.atGameMinutes ?? 0;

  const rivals: NpcGuild[] = RIVAL_GUILDS.map((def, index) => ({
    id: index + 1,
    name: def.name,
    kind: 'rival' as const,
    baseScore: def.restScore,
    driftWeeks: 0,
    ladderProgress: 0,
  }));

  const takenNames = new Set<string>(rivals.map((guild) => guild.name));
  let nextId = rivals.length + 1;
  const makeBackground = (name: string): NpcGuild => {
    const [baseScore, afterBase] = nextInt(rng, WORLD.background.baseScoreRange[0], WORLD.background.baseScoreRange[1]);
    rng = afterBase;
    const [driftWeeks, afterDrift] = pickOne(rng, WORLD.background.driftWeeksChoices);
    rng = afterDrift;
    return {
      id: nextId++,
      name,
      kind: 'background' as const,
      baseScore,
      driftWeeks,
      ladderProgress: 0,
    };
  };

  // 正典背景公会(T12 去向文案已提及)+ 名池去重组合,凑足规模感
  const backgrounds: NpcGuild[] = [];
  for (const canon of ['霜语会', '灰烬兄弟会'] as const) {
    takenNames.add(canon);
    backgrounds.push(makeBackground(canon));
  }
  while (backgrounds.length < WORLD.backgroundGuildCount) {
    const [prefix, afterPrefix] = pickOne(rng, GUILD_NAME_PREFIXES);
    rng = afterPrefix;
    const [suffix, afterSuffix] = pickOne(rng, GUILD_NAME_SUFFIXES);
    rng = afterSuffix;
    const name = prefix + suffix;
    if (takenNames.has(name)) {
      continue; // 重名重抽(组合空间远大于公会数,重放同种子必同结果)
    }
    takenNames.add(name);
    backgrounds.push(makeBackground(name));
  }

  // 旧档迁移:玩家已得的本会首杀按服务器首杀结转(署玩家公会名)
  const serverFirstKills: ServerFirstKill[] = [];
  const anchorProgress = { ladderProgress: 0 };
  if (options?.honorWall !== undefined) {
    const ladder = serverLadder();
    const seen = new Set<string>();
    for (const badge of options.honorWall.firstKills) {
      if (seen.has(badge.bossId)) {
        continue;
      }
      const position = ladder.findIndex((boss) => boss.bossId === badge.bossId);
      if (position === -1) {
        continue; // 首领已不在内容表:不结转
      }
      seen.add(badge.bossId);
      anchorProgress.ladderProgress = Math.max(anchorProgress.ladderProgress, position + 1);
      serverFirstKills.push({
        bossId: badge.bossId,
        raidName: badge.raidName,
        bossName: badge.bossName,
        guildName: options.guildName ?? '',
        byPlayer: true,
        atGameMinutes,
      });
    }
  }

  const guilds = [...rivals, ...backgrounds];
  // 抬价/截胡的确定性节律相位(种子定;日序 % 周期 === 相位当日触发)
  const [marketPhase, afterMarketPhase] = nextInt(rng, 0, WORLD.market.periodDays - 1);
  rng = afterMarketPhase;
  const [poachPhase, afterPoachPhase] = nextInt(rng, 0, WORLD.poach.periodDays - 1);
  rng = afterPoachPhase;
  return {
    guilds,
    news: [
      {
        atGameMinutes: 0,
        text: `${WORLD.serverName}正式开启:${guilds.length} 支公会同场竞技,首杀榜虚位以待。`,
      },
    ],
    serverFirstKills,
    anchor: { ladderProgress: anchorProgress.ladderProgress, averageLevel: 0, averageItemLevel: 0 },
    playerStallWeeks: 0,
    bestRank: 0,
    // marketWave 为可选键:缺省不写入(键序在「JSON 往返 + 结算展开」与连续推进
    // 两条路径间保持一致,存档字节级可重放)
    poachCount: 0,
    marketPhase,
    poachPhase,
  };
}

// ———— 派生量(排名 / 进度 / 行情;纯函数,UI 与门面共用) ————

/** 玩家在服务器阶梯上的推进位数(已击杀首领的最靠后位置 + 1;未参战 = 0)。 */
export function playerLadderProgress(honorWall: HonorWall): number {
  const ladder = serverLadder();
  const killed = new Set(honorWall.firstKills.map((badge) => badge.bossId));
  let progress = 0;
  for (const [index, boss] of ladder.entries()) {
    if (killed.has(boss.bossId)) {
      progress = Math.max(progress, index + 1);
    }
  }
  return progress;
}

/** 玩家成长分:平均等级与装等的折算(封顶不足一杀;权重见内容表)。 */
export function playerGrowthScore(averageLevel: number, averageItemLevel: number): number {
  const raw =
    Math.floor(averageLevel * WORLD.ladder.playerLevelWeight) +
    Math.floor(averageItemLevel * WORLD.ladder.playerItemLevelWeight);
  return Math.min(WORLD.ladder.playerGrowthCap, raw);
}

/** 玩家排名分 = 每首领击杀分 × 阶梯推进数 + 成长分。 */
export function playerWorldScore(
  ladderProgress: number,
  averageLevel: number,
  averageItemLevel: number,
): number {
  return WORLD.ladder.scorePerBoss * ladderProgress + playerGrowthScore(averageLevel, averageItemLevel);
}

/** NPC 公会排名分:竞争公会 = 击杀分 × 推进数 + 底蕴分;背景公会 = 基础分 + 极缓成长。 */
export function npcGuildScore(guild: NpcGuild, weekIndex: number): number {
  if (guild.kind === 'rival') {
    return WORLD.ladder.scorePerBoss * guild.ladderProgress + guild.baseScore;
  }
  const drift = guild.driftWeeks > 0 ? Math.floor(weekIndex / guild.driftWeeks) : 0;
  return Math.min(WORLD.background.driftCeiling, guild.baseScore + drift);
}

/** 排名榜条目(世界页与周结算共用;kind 为界面标签)。 */
export interface RankingEntry {
  readonly name: string;
  readonly kind: '本会' | '竞争' | '背景';
  readonly score: number;
  /** 服务器阶梯推进位数(背景公会恒 0)。 */
  readonly ladderProgress: number;
  readonly isPlayer: boolean;
}

/** 排名榜(按名次排序;并列时本会列前,其余保持稳定序 —— 确定性)。 */
export interface ServerRanking {
  readonly entries: readonly RankingEntry[];
  readonly playerRank: number;
  readonly total: number;
}

/** 计算整份排名榜(纯函数;玩家分与 NPC 分同刻度同公式)。 */
export function computeRanking(
  guilds: readonly NpcGuild[],
  playerScore: number,
  playerProgress: number,
  playerName: string,
  weekIndex: number,
): ServerRanking {
  const entries: RankingEntry[] = [
    { name: playerName, kind: '本会', score: playerScore, ladderProgress: playerProgress, isPlayer: true },
    ...guilds.map((guild) => ({
      name: guild.name,
      kind: (guild.kind === 'rival' ? '竞争' : '背景') as RankingEntry['kind'],
      score: npcGuildScore(guild, weekIndex),
      ladderProgress: guild.ladderProgress,
      isPlayer: false,
    })),
  ];
  // 稳定排序:分高在前;并列本会列前(主场哨),其余按原序(竞争在前、背景随后)
  entries.sort((a, b) => b.score - a.score || Number(b.isPlayer) - Number(a.isPlayer));
  return { entries, playerRank: entries.findIndex((entry) => entry.isPlayer) + 1, total: entries.length };
}

/** 当前整份排名榜(UI 入口;从状态直接派生,刻度函数与 sim/roster 同源)。 */
export function serverRanking(state: {
  readonly members: readonly MemberProfile[];
  readonly honorWall: HonorWall;
  readonly world: ServerWorld;
  readonly guild: { readonly name: string };
  readonly clockGameMinutes: number;
}): ServerRanking {
  const progress = playerLadderProgress(state.honorWall);
  const averageLevel = guildAverageLevel(state.members);
  const averageItemLevel = guildAverageItemLevel(state.members);
  const weekIndex = Math.floor(state.clockGameMinutes / GAME_MINUTES_PER_WEEK);
  return computeRanking(
    state.world.guilds,
    playerWorldScore(progress, averageLevel, averageItemLevel),
    progress,
    state.guild.name,
    weekIndex,
  );
}

/** 抬价系数:行情波进行中 ⇒ 团灭修理金上浮(门面传入 raid 结算;平稳 = 1)。 */
export function repairCostFactor(world: ServerWorld): number {
  return world.marketWave === undefined ? 1 : 1 + WORLD.market.repairMarkupPercent / 100;
}

// ———— 日结算:行情波 + 抢苗子(门面在每个日界、申请池刷新之后调用) ————

/** 日结算入参:申请池为当日新刷的池。纯确定性:不消费任何随机链。 */
export interface SettleWorldDayParams {
  readonly world: ServerWorld;
  readonly applicants: readonly Applicant[];
  readonly atGameMinutes: number;
}

export interface SettleWorldDayResult {
  readonly world: ServerWorld;
  /** 截胡后的申请池(未触发 = 原池)。 */
  readonly applicants: readonly Applicant[];
  /** 本日新增的全服新闻(门面负责入事件流)。 */
  readonly news: readonly string[];
}

/** 申请池苗子的「好苗」排序:技艺档优先,同级比等级,再比编号(确定性)。 */
function poachVictimOf(applicants: readonly Applicant[]): Applicant | undefined {
  const skillOrder = new Map(SKILL_TIERS.map((tier, index) => [tier.id, index]));
  let best: Applicant | undefined;
  for (const applicant of applicants) {
    if (best === undefined) {
      best = applicant;
      continue;
    }
    const skill = skillOrder.get(applicant.profile.skillTierId) ?? SKILL_TIERS.length;
    const bestSkill = skillOrder.get(best.profile.skillTierId) ?? SKILL_TIERS.length;
    if (
      skill < bestSkill ||
      (skill === bestSkill && applicant.profile.level > best.profile.level) ||
      (skill === bestSkill &&
        applicant.profile.level === best.profile.level &&
        applicant.applicationId < best.applicationId)
    ) {
      best = applicant;
    }
  }
  return best;
}

/**
 * 虚拟服务器的日结算(纯确定性,不消费随机链):
 * ① 行情波:进行中则倒数,归零回落并发新闻;平稳则在相位日掀起(轻量抬价,
 *    出手公会按周期轮换);
 * ② 抢苗子:相位日由一家竞争公会(轮换)截走池中最好的一份申请
 *    (池中至少保留 minPoolLeft 份,绝不截空)。
 * 节律 = 日序 % 周期 === 相位(相位由建会种子定,存档间有差异)。
 */
export function settleWorldDay(params: SettleWorldDayParams): SettleWorldDayResult {
  const { applicants, atGameMinutes } = params;
  const dayIndex = Math.floor(atGameMinutes / GAME_MINUTES_PER_DAY);
  let world = params.world;
  const news: string[] = [];

  // ① 行情波:倒数回落 / 相位日掀起
  const rivals = world.guilds.filter((guild) => guild.kind === 'rival');
  if (world.marketWave !== undefined) {
    const daysLeft = world.marketWave.daysLeft - 1;
    if (daysLeft <= 0) {
      world = { ...world, marketWave: undefined };
      news.push('拍卖行行情回落,修理材料恢复原价。');
    } else {
      world = { ...world, marketWave: { ...world.marketWave, daysLeft } };
    }
  } else if (dayIndex % WORLD.market.periodDays === world.marketPhase % WORLD.market.periodDays) {
    const rival = rivals[dayIndex % rivals.length]!;
    world = {
      ...world,
      marketWave: { daysLeft: WORLD.market.durationDays, guildName: rival.name },
    };
    news.push(
      `「${rival.name}」在拍卖行扫货,修理材料行情看涨:团灭修理金 +${WORLD.market.repairMarkupPercent}%,约 ${WORLD.market.durationDays} 日。`,
    );
  }

  // ② 抢苗子:相位日由轮换的竞争公会截走最好的一份申请
  let settledApplicants = applicants;
  if (dayIndex % WORLD.poach.periodDays === world.poachPhase % WORLD.poach.periodDays) {
    const victim = applicants.length > WORLD.poach.minPoolLeft ? poachVictimOf(applicants) : undefined;
    if (victim !== undefined) {
      const rival = rivals[world.poachCount % rivals.length]!;
      const template = POACH_NEWS_POOL[world.poachCount % POACH_NEWS_POOL.length]!;
      settledApplicants = applicants.filter((applicant) => applicant.applicationId !== victim.applicationId);
      world = { ...world, poachCount: world.poachCount + 1 };
      news.push(template.replaceAll('{guild}', rival.name).replaceAll('{name}', victim.profile.name));
    }
  }

  // 新闻入流(带时刻,超容裁旧)
  if (news.length > 0) {
    const items = news.map((text) => ({ atGameMinutes, text }));
    world = {
      ...world,
      news: [...world.news, ...items].slice(-WORLD.newsKeepCount),
    };
  }

  return { world, applicants: settledApplicants, news };
}

// ———— 周结算:服务器首杀 + 橡皮筋 + 排名(门面在周边界、荣誉结算之后调用) ————

/** 周结算入参。 */
export interface SettleWorldWeekParams {
  readonly world: ServerWorld;
  /** 本夜结算后的荣誉墙(本会首杀已入墙;玩家的服务器首杀据此判定)。 */
  readonly honorWall: HonorWall;
  /** 玩家公会名(新闻署名)。 */
  readonly guildName: string;
  /** 周边界时刻。 */
  readonly atGameMinutes: number;
  /** 本团本夜击杀的首领 id(玩家本夜的战果;无夜为空)。 */
  readonly tonightKilledBossIds: readonly string[];
  /** 当前公会平均等级与装等(成长分与停滞判定)。 */
  readonly averageLevel: number;
  readonly averageItemLevel: number;
}

export interface SettleWorldWeekResult {
  readonly world: ServerWorld;
  /** 本周边界新增的全服新闻(门面负责入事件流)。 */
  readonly news: readonly string[];
}

/**
 * 虚拟服务器的周结算(确定性,不消费随机链):
 * ① 服务器首杀(玩家):本夜击杀且全服未有人杀过的首领,由玩家夺得并发全服公告;
 * ② 橡皮筋:玩家停滞(周快照三刻度全无增长)达阈值 → 竞争公会按追赶速率推进,
 *   越过未认领的首领即夺服务器首杀并发新闻(超车);正常推进 → 慢半拍跟随,
 *   锚定「玩家进度 − lag」、每周边界至多 weeklyAdvance 名;
 * ③ 排名:玩家杀入新名次段(阈值表)时发全服新闻,历史最佳名次只升不降。
 */
export function settleWorldWeek(params: SettleWorldWeekParams): SettleWorldWeekResult {
  const { honorWall, guildName, atGameMinutes, tonightKilledBossIds } = params;
  const ladder = serverLadder();
  const news: string[] = [];
  let serverFirstKills = params.world.serverFirstKills;
  const claimed = new Set(serverFirstKills.map((kill) => kill.bossId));
  let guilds = params.world.guilds;

  // ① 玩家的服务器首杀:本夜战果中全服未有人杀过的首领(先于竞争公会判定,
  //    同一边界玩家优先 —— 正常推进时首杀稳拿)
  for (const bossId of tonightKilledBossIds) {
    if (claimed.has(bossId)) {
      continue;
    }
    const boss = ladder.find((entry) => entry.bossId === bossId);
    if (boss === undefined) {
      continue;
    }
    claimed.add(bossId);
    serverFirstKills = [
      ...serverFirstKills,
      {
        bossId: boss.bossId,
        raidName: boss.raidName,
        bossName: boss.bossName,
        guildName,
        byPlayer: true,
        atGameMinutes,
      },
    ];
    news.push(`全服首杀!「${guildName}」率先击杀「${boss.bossName}」(${boss.raidName}),公告传遍${WORLD.serverName}。`);
  }

  // ② 橡皮筋:玩家本周期是否推进(新首领,或平均等级/装等仍在增长 ——
  //    提装开荒也是推进;三刻度全无增长才算停滞)
  const playerProgress = playerLadderProgress(honorWall);
  const anchor = params.world.anchor;
  const progressed =
    playerProgress > anchor.ladderProgress ||
    params.averageLevel > anchor.averageLevel ||
    params.averageItemLevel > anchor.averageItemLevel;
  const stallWeeks = progressed ? 0 : params.world.playerStallWeeks + 1;
  const catchingUp = stallWeeks >= WORLD.rubberBand.stallWeeksToCatchUp;

  // 竞争公会推进(顺序固定;同周多名越过同一首领时,先者夺首杀)
  for (const guild of guilds) {
    if (guild.kind !== 'rival') {
      continue;
    }
    let next = guild.ladderProgress;
    if (playerProgress > 0) {
      if (catchingUp) {
        next = Math.min(ladder.length, guild.ladderProgress + WORLD.rubberBand.catchUpWeeklyAdvance);
      } else {
        const target = Math.max(0, playerProgress - WORLD.rubberBand.lagBosses);
        next = Math.min(guild.ladderProgress + WORLD.rubberBand.weeklyAdvance, Math.max(guild.ladderProgress, target));
      }
    }
    next = Math.min(next, ladder.length); // 玩家未参战(进度 0):全服共同等待,不推进

    for (let position = guild.ladderProgress; position < next; position++) {
      const boss = ladder[position];
      if (boss === undefined || claimed.has(boss.bossId)) {
        continue;
      }
      claimed.add(boss.bossId);
      serverFirstKills = [
        ...serverFirstKills,
        {
          bossId: boss.bossId,
          raidName: boss.raidName,
          bossName: boss.bossName,
          guildName: guild.name,
          byPlayer: false,
          atGameMinutes,
        },
      ];
      news.push(`「${guild.name}」拿下「${boss.bossName}」服务器首杀(${boss.raidName})—— 他们抢在了前头。`);
    }

    if (next !== guild.ladderProgress) {
      guilds = guilds.map((entry) => (entry.id === guild.id ? { ...entry, ladderProgress: next } : entry));
    }
  }

  // ③ 排名与名次段新闻(整榜以推进后的 NPC 分重算;背景分按周序缓涨)
  const weekIndex = Math.floor(atGameMinutes / GAME_MINUTES_PER_WEEK);
  const playerScore = playerWorldScore(playerProgress, params.averageLevel, params.averageItemLevel);
  const ranking = computeRanking(guilds, playerScore, playerProgress, guildName, weekIndex);
  let bestRank = params.world.bestRank;
  if (bestRank === 0) {
    bestRank = ranking.playerRank; // 首评:只记录,不发新闻
  } else if (ranking.playerRank < bestRank) {
    const threshold = WORLD.rankNewsThresholds.find((value) => ranking.playerRank <= value && bestRank > value);
    if (threshold !== undefined) {
      news.push(`「${guildName}」升至${WORLD.serverName}第 ${ranking.playerRank} 位 —— 杀入前 ${threshold}!`);
    }
    bestRank = ranking.playerRank;
  }

  // 新闻入流(带时刻,超容裁旧)
  let world = params.world;
  if (news.length > 0) {
    const items = news.map((text) => ({ atGameMinutes, text }));
    world = { ...world, news: [...world.news, ...items].slice(-WORLD.newsKeepCount) };
  }

  return {
    world: {
      ...world,
      guilds,
      serverFirstKills,
      anchor: {
        ladderProgress: playerProgress,
        averageLevel: params.averageLevel,
        averageItemLevel: params.averageItemLevel,
      },
      playerStallWeeks: stallWeeks,
      bestRank,
    },
    news,
  };
}
