import { GUILD_NAME_MAX_LENGTH } from './commands';
import type { EncounterBand } from './encounter';
import { generateFoundingRoster } from './member-gen';
import { generateApplicantPool } from './recruit';
import { createServerWorld } from './world';
import { DEFAULT_LOOT_SYSTEM, VAULT, type LootSystemId } from '../content/economy';
import { RECRUIT } from '../content/recruit';
import type { WeeklyGoalId } from '../content/plan';
import type { DepartureReason } from '../content/reputation';
import type { GearSlot, Quality } from '../content/gear';
import type { ConsumableTierId, RaidStanceId, WorldBuffId } from '../content/raid-tactics';

/**
 * 团员画像:除 id 与会长标记外的全部团员维度。
 * 在册团员(Member)与申请人(Applicant)共用 —— 申请人招入时画像原样转正。
 */
export interface MemberProfile {
  readonly name: string;
  readonly classId: string;
  readonly specId: string;
  readonly level: number;
  /** 当前等级内已累计的经验(升级公式见 sim/leveling.ts) */
  readonly experience: number;
  /** 8 部位装备,顺序同 content/gear.GEAR_SLOTS */
  readonly gear: readonly GearItem[];
  /** 心情(0-100) */
  readonly mood: number;
  /** 忠诚(0-100);会长角色恒为 100 */
  readonly loyalty: number;
  /** 疲劳(0-100) */
  readonly fatigue: number;
  /** 个人金(GLOSSARY):打工与野团所得归此;GKP 制下用于团本出价 */
  readonly personalGold: number;
  /** DKP 余额:仅 DKP 制下增减(击杀记分/拿装扣分);允许负账 */
  readonly dkp: number;
  /** 出勤画像:风格 + 基础出勤率 */
  readonly attendance: AttendanceProfile;
  /** 性格标签 id(1–2 个) */
  readonly traits: readonly string[];
  /** 技艺评级档位 id */
  readonly skillTierId: string;
  /** 功绩统计:参与击杀的团本首领数(名人堂「功绩」陈列;申请人转正自 0 起) */
  readonly bossKills: number;
  /** 功绩统计:穿上的紫装件数(名人堂「功绩」陈列) */
  readonly rareLootWon: number;
}

/**
 * 团员:名册中的一名在册成员(GLOSSARY)。
 * 全维度见 MemberProfile;引用内容表处只存 id(数据驱动:改文案不动存档)。
 */
export interface Member extends MemberProfile {
  readonly id: number;
  /** 是否会长角色(会长在名册中的自有角色,GLOSSARY) */
  readonly isChairman: boolean;
  /** 入册时刻(游戏分钟;名人堂「在会时长」与功绩陈列用;建会元老为 0) */
  readonly joinedAtGameMinutes: number;
  /** 连续待命(未编入任何小队)的游戏日数;编入即清零(自动退会条件之一,T12) */
  readonly benchDays: number;
}

/**
 * 申请:申请池中的一份求职申请(GLOSSARY:申请池)。
 * 画像在每日刷新时按池子规格预生成;招入时才分配团员 id。
 */
export interface Applicant {
  /** 申请编号(与团员 id 相互独立的空间) */
  readonly applicationId: number;
  /** 申请人完整画像 */
  readonly profile: MemberProfile;
}

/**
 * 小队:5 人制的基本编组单位(GLOSSARY);一切活动的出勤以小队为原子。
 * 队内只存团员 id(顺序即编入顺序);职能结构与光环是派生量(sim/comp.ts)。
 */
export interface Squad {
  readonly id: number;
  readonly memberIds: readonly number[];
  /** 当前活动安排;缺省 = 待命休整(疲劳自然恢复,见 sim/leveling.ts) */
  readonly activity?: SquadActivity;
}

/** 小队活动:练级(进驻地图)/ 下本(进驻 5 人本)/ 外快(打工/野团)/ 战场(进驻 PvP);后续工单在此扩展类型。 */
export type SquadActivity =
  /** 练级:进驻某张练级地图,自动层逐日结算 */
  | { readonly type: 'leveling'; readonly mapId: string }
  /** 下本:进驻某座 5 人本,自动层逐日按 runsPerRun 结算(规则见 sim/dungeon.ts) */
  | { readonly type: 'dungeon'; readonly dungeonId: string }
  /** G团打工:整队出坞替别家金团出力,收入归个人金(规则见 sim/economy.ts) */
  | { readonly type: 'carry' }
  /** 野团:整队跑临时混合团,收入归个人金(规则见 sim/economy.ts) */
  | { readonly type: 'wildRaid' }
  /** 战场:编入战场队进驻某梯度战场,自动层逐日结算(规则见 sim/pvp.ts,T16) */
  | { readonly type: 'battlefield'; readonly battlefieldId: string };

/**
 * 单件装备:部位 + 品质 + 装等(物品表见后续装备工单)。
 * pvpPower = 军装的战场向属性(T16):只在战场结算计入战力,PvE 结算不计。
 * setId = tier 套装 id(T18,DESIGN「团本 tier 出 5 件套」):团本紫装落在
 * 套装部位上即携带;同套装穿满 2 件起效(见 sim/roster.effectiveItemLevel)。
 */
export interface GearItem {
  readonly slot: GearSlot;
  readonly quality: Quality;
  readonly itemLevel: number;
  /** 战场向属性加成(军装才有;缺省 = 无)。 */
  readonly pvpPower?: number;
  /** tier 套装 id(团本套装件才有;缺省 = 非套装)。 */
  readonly setId?: string;
}

/** 一件掉落的去向:5 人本为自动择优穿戴;团本按分配制度归属(经济字段见 sim/economy.ts)。 */
export interface DropOutcome {
  readonly slot: GearSlot;
  readonly quality: Quality;
  readonly itemLevel: number;
  /** 是否被穿上(择优/制度分配;false = 无人可提升或流拍,已分解) */
  readonly equipped: boolean;
  /** 换装团员名(equipped 时必有) */
  readonly assignedTo?: string;
  /** 该部位装等提升值(equipped 时必为正) */
  readonly upgradeDelta?: number;
  /** 分配制度(团本掉落才有;5 人本自动择优不填) */
  readonly system?: LootSystemId;
  /** GKP 成交价(赢家实付个人金;仅 GKP 制) */
  readonly goldPaid?: number;
  /** DKP 扣分(仅 DKP 制;负账可能) */
  readonly dkpPaid?: number;
  /** 自肥件(会长裁量制 + 自肥生效) */
  readonly selfDealt?: boolean;
  /** G团整批售价(T18,G团接单的夜才有:掉落卖给买家,不穿戴)。 */
  readonly soldGold?: number;
  /** tier 套装件(T18:团本紫装落在套装部位上)。 */
  readonly setId?: string;
  /** 未穿戴原因(缺省 = 无人可提升;流拍 = 出不起价) */
  readonly unequippedReason?: '流拍';
}

/** 一次下本的结果卡数据(结构化快照;过程要点同时以「下本」事件进短日志)。 */
export interface DungeonRunReport {
  readonly dungeonId: string;
  readonly dungeonName: string;
  readonly squadId: number;
  /** 第几小队(1 起,按编成顺序) */
  readonly squadOrdinal: number;
  readonly atGameMinutes: number;
  readonly success: boolean;
  /** 结算三要素快照:战力 / 难度目标 / 成功概率 / 三段式区间 */
  readonly power: number;
  readonly target: number;
  readonly successChance: number;
  readonly band: EncounterBand;
  /** 参战名单快照(结算时刻的名字/职能/装等) */
  readonly members: readonly { readonly name: string; readonly role: string; readonly itemLevel: number }[];
  /** 本次掉落与去向(失败为空数组) */
  readonly drops: readonly DropOutcome[];
}

/**
 * 一次战场结算的结果卡数据(T16,结构化快照;过程要点同时以「战场」事件进短日志)。
 * 演出级别(DESIGN「三级演出」):战场 = 结果卡 + 短日志(与 5 人本同级)。
 */
export interface BattlefieldReport {
  readonly battlefieldId: string;
  readonly battlefieldName: string;
  /** 梯度(1 起;GLOSSARY:分梯度)。 */
  readonly gradient: number;
  readonly atGameMinutes: number;
  /** 本场胜负。 */
  readonly victory: boolean;
  /** 结算三要素快照:战场队战力(含军装战场向属性)/ 难度目标 / 成功概率 / 三段式区间。 */
  readonly power: number;
  readonly target: number;
  readonly successChance: number;
  readonly band: EncounterBand;
  /** 出战小队序号(1 起,按编成顺序)。 */
  readonly squadOrdinals: readonly number[];
  /** 出战人数(战场队 = 2–3 小队)。 */
  readonly teamSize: number;
  /** 军装战场向属性合计(战力刻度;军装价值的可观察面)。 */
  readonly pvpPowerTotal: number;
  /** 本场荣誉进账(胜 = honorPerWin,败 = honorPerLoss)。 */
  readonly honorGained: number;
  /** 参战名单快照(结算时刻的名字/职能/装等,含战场向属性后的有效装等)。 */
  readonly members: readonly { readonly name: string; readonly role: string; readonly itemLevel: number }[];
}

/** 出勤画像:风格 id(content/attendance)+ 基础出勤率(0-100)。 */
export interface AttendanceProfile {
  readonly styleId: string;
  readonly baseRate: number;
}

/**
 * 公会金库(GLOSSARY):余额 + 收支两向的历史累计。
 * 收入面:GKP 制成交抽成(T11);支出面:修理金(T10)、
 * 消耗品/招募/建设(后续工单)。
 */
export interface GuildVault {
  /** 当前余额(金币)。 */
  readonly gold: number;
  /** 历史修理支出累计(团灭代价;只增不减)。 */
  readonly repairSpent: number;
  /** 历史收入累计(GKP 抽成等;只增不减)。 */
  readonly incomeTotal: number;
}

/**
 * 公会经济(T11,GLOSSARY:分配制度/自肥):
 * 双钱包的「钱包侧」在团员(personalGold)与金库;此处是制度侧。
 */
export interface GuildEconomy {
  /** 当前分配制度(新会默认 会长裁量;可换制,成本见内容表)。 */
  readonly system: LootSystemId;
  /** 现行制度生效时刻(游戏分钟;展示用)。 */
  readonly systemSinceGameMinutes: number;
  /** 自肥开关(GLOSSARY:自肥):仅会长裁量制下可为 true;换出该制度即自动关闭。 */
  readonly selfDealing: boolean;
  /** 历史自肥件数(忠诚/声望代价随件累积,此处可见累计)。 */
  readonly selfDealtCount: number;
  /** 历史自肥的声望代价累计(逐件从声望值实扣,T12 起声望为真值)。 */
  readonly selfDealReputationPaid: number;
}

/** 建会(或旧档迁移)时的初始经济:会长裁量制、不自肥。 */
export function createInitialEconomy(clockGameMinutes: number): GuildEconomy {
  return {
    system: DEFAULT_LOOT_SYSTEM,
    systemSinceGameMinutes: clockGameMinutes,
    selfDealing: false,
    selfDealtCount: 0,
    selfDealReputationPaid: 0,
  };
}

/** 已启用的世界 Buff:记录启用时刻,是否备妥由筹备时长判定(就绪式见 sim/raid.ts)。 */
export interface ArmedWorldBuff {
  readonly buffId: WorldBuffId;
  /** 启用时刻(游戏分钟;启用即从金库拨款,无论是否来得及都不退)。 */
  readonly armedAtGameMinutes: number;
}

/**
 * 开荒决策面(T14,DESIGN):挂在开团安排上的三项赛前决策,当夜结算生效。
 * 安排随团本夜结束清空 ⇒ 决策同样只对当夜有效(时效);下周重新开团、重新决策。
 */
export interface RaidTactics {
  /** 消耗品预算档位(设定时金库已拨款;换档再全额拨款、此前不退)。 */
  readonly consumableTier?: ConsumableTierId;
  /** 已启用的世界 Buff(启用时金库已拨款;多个叠加,就绪判定逐项进行)。 */
  readonly worldBuffs?: readonly ArmedWorldBuff[];
  /** 编成微调阵形(缺省 = 常规阵形)。 */
  readonly stance?: RaidStanceId;
}

/**
 * 周计划(计划层,T15,GLOSSARY:计划层 = 会长定期设定目标与开团安排的轻决策层):
 * 常驻的每周团本夜安排与当周目标 —— 自动层每周照此开团,直到会长更改或取消,
 * 会长不操作时公会照常运转。与单周开团安排(raidPlan)的关系:计划决定「每周
 * 自动开哪本、按什么目标打」;本周已手动开团的不被计划覆盖,夜结束照常清空。
 */
export interface WeeklyPlan {
  /** 当周目标(content/plan 数据驱动;改目标即时生效,含本周已开的团本夜)。 */
  readonly goal: WeeklyGoalId;
  /** 每周团本夜所开团本(后续多本团本时可扩为轮换表)。 */
  readonly raidId: string;
  /** 计划设定时刻(游戏分钟;展示用)。 */
  readonly setAtGameMinutes: number;
}

/**
 * 开团安排(计划层):已开团的团本。
 * 团本夜 = 下一个游戏周边界(团本 CD = 游戏周,DESIGN):门面在跨过
 * 周边界时按首领顺序整夜结算,夜结束安排即清空(下周重新开团 ——
 * 有周计划时由自动层照计划重开,T15)。
 * mode(T18):'gRun' = 以 G团接单开团(GLOSSARY:G团 = 以金币结算装备
 * 归属的团本形式;掉落整批卖给买家,金库抽成 + 打团者均分打工费),
 * 仅开放接单的团本(20 人休闲团本)可设;缺省 = 公会团(按分配制度穿装备)。
 */
export interface RaidPlan {
  readonly raidId: string;
  /** 开团时刻(游戏分钟;展示用)。 */
  readonly openedAtGameMinutes: number;
  /** G团接单标记(缺省 = 公会团)。 */
  readonly mode?: 'gRun';
  /** 赛前决策(T14;缺省 = 全不启用)。 */
  readonly tactics?: RaidTactics;
}

/** 团本夜单首领结算结果(直播视图与事件日志的数据面)。 */
export interface RaidBossOutcome {
  readonly bossId: string;
  readonly name: string;
  readonly killed: boolean;
  /** 团队战力与难度目标(统一结算引擎的评估快照)。 */
  readonly power: number;
  readonly target: number;
  readonly successChance: number;
  readonly band: EncounterBand;
  /** 硬门槛装等(设置了即硬门槛首领;undefined = 无硬门槛)。 */
  readonly hardGateItemLevel?: number;
  readonly hardGateMet: boolean;
  /** 本次战斗倒下的团人数(团灭 = 全员;击杀时 = 险胜程度,上限在内容表)。 */
  readonly fallen: number;
  /** 本首领掉落与去向(团灭/失败为空数组)。 */
  readonly drops: readonly DropOutcome[];
}

/** 团灭代价结算快照(修理金 / 疲劳 / 士气,无永久损失)。 */
export interface RaidWipe {
  /** 团灭在第几个首领(1 起)。 */
  readonly bossIndex: number;
  readonly bossName: string;
  /** 实际扣除的修理金(金库不足时按余额封顶)。 */
  readonly repairGold: number;
  /** 每名团员的额外疲劳(在每次首领战疲劳之上)。 */
  readonly fatigue: number;
  /** 每名团员的士气(心情)打击。 */
  readonly moodHit: number;
}

/**
 * 团本夜赛前决策的生效快照(T14;直播小结与测试断言的数据面)。
 * 金币在指令时刻已扣,这里记的是当夜实际生效的增益与已花金额。
 */
export interface RaidTacticsEffect {
  /** 当夜阵形(未微调 = 常规阵形)。 */
  readonly stance: { readonly id: RaidStanceId; readonly name: string };
  /** 消耗品预算(未设 = undefined)。 */
  readonly consumable?: {
    readonly id: ConsumableTierId;
    readonly name: string;
    readonly bonusPercent: number;
    /** 该档拨款额(指令时已扣)。 */
    readonly goldSpent: number;
  };
  /** 世界 Buff 逐项:是否就绪与生效增益(未就绪 = 不生效,但金已花)。 */
  readonly worldBuffs: readonly {
    readonly id: WorldBuffId;
    readonly name: string;
    readonly ready: boolean;
    /** 就绪时的增益 %(未就绪为 0)。 */
    readonly bonusPercent: number;
    readonly goldSpent: number;
  }[];
  /** 当夜战力增益合计 %(消耗品 + 就绪世界 Buff;阵形是取舍不是增益,不计入)。 */
  readonly bonusPowerPercent: number;
}

/** 一次团本夜的结算报告(直播视图:首领血条 + 40 人点阵 + 滚动战斗日志)。 */
export interface RaidNightReport {
  readonly raidId: string;
  readonly raidName: string;
  readonly atGameMinutes: number;
  /** 团本规模(T18:40 人主力 / 20 人休闲;直播点阵的行数 = size/5)。 */
  readonly size: 20 | 40;
  /** 出战阵容快照(点阵的一行 = 一支小队;按小队顺序)。 */
  readonly lineup: readonly {
    readonly squadOrdinal: number;
    readonly name: string;
    readonly role: string;
    readonly itemLevel: number;
  }[];
  /** 全团平均装等(结算时刻,含套装加成)。 */
  readonly teamItemLevel: number;
  /** 按顺序的首领结算结果。 */
  readonly bosses: readonly RaidBossOutcome[];
  /** 全通 = true;团灭 = false(此时给出代价快照)。 */
  readonly cleared: boolean;
  readonly wipe?: RaidWipe;
  /** 本夜修理金合计(实付;全通为 0)。 */
  readonly repairGold: number;
  /** 本夜适用的当周目标(T15,计划层;无周计划的夜为 undefined)。 */
  readonly goal?: { readonly id: WeeklyGoalId; readonly name: string };
  /** 本夜分配结算摘要(T11:双钱包流向与制度代价;夜被取消时无报告)。 */
  readonly loot?: RaidLootFlow;
  /** 本夜赛前决策的生效快照(T14;未做任何决策时为 undefined)。 */
  readonly tactics?: RaidTacticsEffect;
  /** G团接单结算摘要(T18;公会团的夜为 undefined)。 */
  readonly gRun?: RaidGRunFlow;
}

/** 团本夜的分配结算摘要:三种制度的金币流向与忠诚/心情代价对照(金库页与测试断言共用)。 */
export interface RaidLootFlow {
  /** 本夜适用的分配制度。 */
  readonly system: LootSystemId;
  /** 本夜入金库金币(GKP 抽成与零头;他制为 0)。 */
  readonly vaultGoldIn: number;
  /** 本夜个人金支出合计(GKP 成交价合计;他制为 0)。 */
  readonly personalGoldOut: number;
  /** 本夜自肥件数。 */
  readonly selfDealtCount: number;
  /** 夜末出席团员的忠诚调整(制度心态,内容表;会长角色除外)。 */
  readonly attendeeLoyaltyPerNight: number;
  /** 夜末出席团员的心情调整(制度心态,内容表)。 */
  readonly attendeeMoodPerNight: number;
}

/**
 * G团接单夜的结算摘要(T18,GLOSSARY:G团/打工):
 * 掉落整批卖给买家,收入 = 金库抽成 + 出战团员均分打工费(归个人金)。
 */
export interface RaidGRunFlow {
  /** 卖出的掉落件数(团灭止步则只卖已杀首领的掉落)。 */
  readonly dropsSold: number;
  /** 本夜入金库金币(抽成 + 除不尽的零头)。 */
  readonly vaultGoldIn: number;
  /** 每名出战团员分得的打工费(个人金进账)。 */
  readonly goldPerRaider: number;
}

/** 公会信息:玩家管理的核心成长主体。 */
export interface GuildInfo {
  readonly name: string;
}

/**
 * 首杀徽章(GLOSSARY:首杀 = 本会首次击杀某团本首领的荣誉记录,带日期陈列)。
 * 虚拟服务器与全服首杀属后续工单,当前记本会首杀。
 */
export interface FirstKillBadge {
  readonly raidId: string;
  readonly raidName: string;
  readonly bossId: string;
  readonly bossName: string;
  /** 达成时刻(游戏分钟;UI 换算为游戏历日期)。 */
  readonly atGameMinutes: number;
}

/** 里程碑达成记录(荣誉墙「里程碑」陈列;条件与分值见 content/reputation)。 */
export interface MilestoneRecord {
  readonly milestoneId: string;
  readonly name: string;
  readonly atGameMinutes: number;
}

/** 稀有掉落陈列(荣誉墙「稀有陈列」:被穿上的紫装战利品)。 */
export interface RareDropRecord {
  readonly slot: GearSlot;
  readonly quality: Quality;
  readonly itemLevel: number;
  /** 持有人(穿上者) */
  readonly holder: string;
  /** 来源文案(团本名或 5 人本名) */
  readonly source: string;
  readonly atGameMinutes: number;
}

/** 荣誉墙(GLOSSARY:首杀、成就与收藏的陈列界面):只增不减,随存档落盘。 */
export interface HonorWall {
  /** 首杀徽章(按达成顺序;同一首领只记一次) */
  readonly firstKills: readonly FirstKillBadge[];
  /** 里程碑(按达成顺序;同一里程碑只记一次) */
  readonly milestones: readonly MilestoneRecord[];
  /** 稀有陈列(按入墙顺序) */
  readonly rareDrops: readonly RareDropRecord[];
  /** 军衔记录(T16,GLOSSARY:荣誉阶梯;按晋升顺序,每阶只记一次) */
  readonly rankLadder: readonly HonorRankBadge[];
}

/**
 * 名人堂条目(GLOSSARY:名人堂 = 陈列历代团员含已离会者去向与功绩的板块)。
 * 离会即入堂:会长淘汰与自动退会都留档;台词与去向按团员 id 确定性取用。
 */
export interface HallOfFameEntry {
  readonly memberId: number;
  readonly name: string;
  readonly classId: string;
  readonly specId: string;
  /** 离会时的等级与装等快照 */
  readonly level: number;
  readonly itemLevel: number;
  readonly joinedAtGameMinutes: number;
  readonly leftAtGameMinutes: number;
  /** 离会方式(content/reputation.DepartureReason) */
  readonly reason: DepartureReason;
  /** 离会台词(数据驱动文案池) */
  readonly farewell: string;
  /** 去向文案(数据驱动文案池) */
  readonly destination: string;
  /** 功绩统计快照:参与击杀的首领数 / 穿上的紫装件数 */
  readonly bossKills: number;
  readonly rareLootWon: number;
}

/**
 * 荣誉账本(T16,GLOSSARY:战场/荣誉阶梯):
 * points = 可花费荣誉点(战场胜负所得,军装兑换支出);
 * career = 生涯荣誉累计(只增不减,军衔段位由此派生 —— 兑换军装不降衔)。
 */
export interface HonorLedger {
  /** 可花费荣誉点。 */
  readonly points: number;
  /** 生涯荣誉累计(军衔刻度)。 */
  readonly career: number;
}

/** 建会(或旧档迁移)时的初始荣誉账本:零荣誉、列兵起家。 */
export function createInitialHonor(): HonorLedger {
  return { points: 0, career: 0 };
}

/** 军衔记录(GLOSSARY:荣誉阶梯;荣誉墙「军衔记录」陈列,晋升即入墙)。 */
export interface HonorRankBadge {
  readonly rankId: string;
  readonly name: string;
  readonly atGameMinutes: number;
}

/** 空荣誉墙(建会初始与旧档迁移共用)。 */
export function createEmptyHonorWall(): HonorWall {
  return { firstKills: [], milestones: [], rareDrops: [], rankLadder: [] };
}

/**
 * NPC 公会(GLOSSARY:虚拟服务器中的非玩家公会;分竞争公会与背景公会)。
 * 建会时按种子确定性生成,随状态落盘;引用内容表处只存名字(数据驱动)。
 */
export interface NpcGuild {
  /** 公会编号(竞争公会 1..N 固定,背景公会随后;仅作稳定排序与去重)。 */
  readonly id: number;
  readonly name: string;
  /** 背景公会(不成长或极缓成长)/ 竞争公会(受橡皮筋约束的成长曲线)。 */
  readonly kind: 'background' | 'rival';
  /** 背景公会:排名基础分(极缓成长见 content/world);竞争公会:档内底蕴分。 */
  readonly baseScore: number;
  /** 背景公会的极缓成长:每 N 周排名分 +1(0 = 完全静止);竞争公会不用。 */
  readonly driftWeeks: number;
  /** 竞争公会:服务器阶梯上的推进位数(已击杀首领的前缀长度,只增不减)。 */
  readonly ladderProgress: number;
}

/**
 * 服务器首杀记录(GLOSSARY:首杀 = 全服首次击杀某团本首领的荣誉记录;
 * 与荣誉墙的「本会首杀」相互独立 —— 服务器首杀被夺走不影响本会徽章)。
 */
export interface ServerFirstKill {
  readonly bossId: string;
  readonly raidName: string;
  readonly bossName: string;
  /** 首杀归属公会名(玩家公会或 NPC 公会)。 */
  readonly guildName: string;
  /** 是否玩家公会夺得(UI 标记与测试断言)。 */
  readonly byPlayer: boolean;
  readonly atGameMinutes: number;
}

/** 全服新闻条目(世界页「全服新闻流」,按发生顺序;超容裁旧)。 */
export interface ServerNewsItem {
  readonly atGameMinutes: number;
  readonly text: string;
}

/** 抬价波:竞争公会扫货 → 团灭修理金上浮,数个游戏日后自动回落。 */
export interface MarketWave {
  /** 剩余游戏日数(每个日界 −1,归零即行情回落)。 */
  readonly daysLeft: number;
  /** 掀起行情的公会名。 */
  readonly guildName: string;
}

/** 橡皮筋的锚(GLOSSARY:橡皮筋):玩家进度的周快照,停滞判定以此为基准。 */
export interface RubberBandAnchor {
  /** 玩家在服务器阶梯上的推进位数(上一周边界快照)。 */
  readonly ladderProgress: number;
  /** 公会平均等级快照(任一刻度增长 = 有推进,停滞周清零)。 */
  readonly averageLevel: number;
  /** 公会平均装等快照。 */
  readonly averageItemLevel: number;
}

/**
 * 虚拟服务器(GLOSSARY:玩家公会所在的模拟服务器生态):
 * NPC 公会群 + 全服新闻 + 服务器首杀 + 橡皮筋锚。确定性:公会群由种子生成,
 * 竞争公会进度只由锚推导(不消费随机链),可序列化、可重放。
 */
export interface ServerWorld {
  readonly guilds: readonly NpcGuild[];
  readonly news: readonly ServerNewsItem[];
  readonly serverFirstKills: readonly ServerFirstKill[];
  /** 橡皮筋锚(上一周边界的玩家进度快照)。 */
  readonly anchor: RubberBandAnchor;
  /** 玩家连续停滞的周数(击杀新首领或平均刻度增长即清零)。 */
  readonly playerStallWeeks: number;
  /** 玩家历史最佳排名(1 起;0 = 尚未评估,首评不发新闻)。 */
  readonly bestRank: number;
  /** 进行中的抬价波(缺省 = 行情平稳)。 */
  readonly marketWave?: MarketWave;
  /** 苗子截胡计数(轮换出手的竞争公会)。 */
  readonly poachCount: number;
  /** 抬价波的相位(0..period−1,建会种子定):日序 % period === 相位当日掀起。 */
  readonly marketPhase: number;
  /** 抢苗子的相位(0..period−1,建会种子定):日序 % period === 相位当日出手。 */
  readonly poachPhase: number;
}

/**
 * 游戏状态:门面的状态部分,纯数据、可序列化。
 * 确定性的关键:种子与随机链状态(rngState)都在状态内。
 */
export interface GameState {
  /** 本局种子:决定一切随机(含建会名册生成) */
  readonly seed: number;
  /** 种子随机源链状态(见 sim/rng.ts;可序列化、可重放) */
  readonly rngState: number;
  /** 游戏时钟:自建会起累计的游戏分钟 */
  readonly clockGameMinutes: number;
  readonly guild: GuildInfo;
  /**
   * 声望值(T12,GLOSSARY:声望等级):首杀与里程碑加分、自肥扣分;
   * 7 档 × 3 星的档位与星级由阈值表派生(sim/reputation.ts),
   * 反向驱动申请池数量/质量与名册上限。
   */
  readonly renownPoints: number;
  /** 名册上限:自 6 人起步,随声望档位扩容(只升不降;大厅建设属后续工单)。 */
  readonly rosterCap: number;
  /** 名册:建会时生成(会长角色 + 初始团员),经招募/淘汰指令增减 */
  readonly members: readonly Member[];
  /** 下一个团员 id(生成与招募共用) */
  readonly nextMemberId: number;
  /** 编成:小队列表(建会时为空;最多 maxSquads 支,见 content/comp) */
  readonly squads: readonly Squad[];
  /** 下一个小队 id */
  readonly nextSquadId: number;
  /** 申请池:每游戏日刷新(含建会当日的初始池) */
  readonly applicants: readonly Applicant[];
  /** 下一个申请编号 */
  readonly nextApplicationId: number;
  /** 最近一次下本的结果卡数据(结构化;历史过程见事件日志的「下本」条目) */
  readonly lastDungeonRun?: DungeonRunReport;
  /** 荣誉账本(T16,GLOSSARY:战场/荣誉阶梯):荣誉点 + 生涯荣誉(军衔刻度)。 */
  readonly honor: HonorLedger;
  /** 最近一次战场结算的结果卡数据(T16;历史过程见事件日志的「战场」条目) */
  readonly lastBattlefieldReport?: BattlefieldReport;
  /** 公会金库(GLOSSARY:双钱包的公家一侧)。 */
  readonly vault: GuildVault;
  /** 公会经济:分配制度与自肥(T11,GLOSSARY:分配制度/自肥)。 */
  readonly economy: GuildEconomy;
  /** 当前开团安排(缺省 = 本周未开团;团本夜 = 下一个游戏周边界)。 */
  readonly raidPlan?: RaidPlan;
  /** 周计划(计划层,T15;缺省 = 无常驻计划,每周需手动开团)。 */
  readonly weeklyPlan?: WeeklyPlan;
  /** 最近一次团本夜的结算报告(结构化;过程见事件日志的「团本」条目) */
  readonly lastRaidNight?: RaidNightReport;
  /** 荣誉墙(T12):首杀徽章 / 里程碑 / 稀有陈列。 */
  readonly honorWall: HonorWall;
  /** 名人堂(T12):离会团员的去向与功绩(含会长淘汰,按离会顺序)。 */
  readonly hallOfFame: readonly HallOfFameEntry[];
  /** 虚拟服务器(T13,GLOSSARY):NPC 公会群 + 全服新闻 + 服务器首杀 + 橡皮筋。 */
  readonly world: ServerWorld;
  /** 下一个事件序号 */
  readonly nextEventSeq: number;
}

export const DEFAULT_GUILD_NAME = '星盾公会';

/**
 * 初始状态:建会时刻,游戏时间为 0。
 * 名册与当日申请池在此时生成:同一种子 ⇒ 同一批团员与同一池申请
 * (生成走种子随机链,链状态存回 GameState)。
 */
export function createInitialState(seed: number, guildName?: string): GameState {
  const seed32 = seed | 0;
  const name = guildName === undefined ? DEFAULT_GUILD_NAME : normalizeGuildName(guildName);
  const roster = generateFoundingRoster(seed32);
  // 建会当日就有申请池可浏览(每日刷新从下一个游戏日边界开始);
  // 新会声望 0 点 = 0 阶(无名小会),申请池规格由阶位驱动
  const pool = generateApplicantPool(roster.rngState, 0, roster.members, 1);
  return {
    seed: seed32,
    rngState: pool.rngState,
    clockGameMinutes: 0,
    guild: { name: name ?? DEFAULT_GUILD_NAME },
    renownPoints: 0,
    rosterCap: RECRUIT.baseRosterCap,
    members: roster.members,
    nextMemberId: roster.nextMemberId,
    squads: [],
    nextSquadId: 1,
    applicants: pool.applicants,
    nextApplicationId: pool.nextApplicationId,
    lastDungeonRun: undefined,
    honor: createInitialHonor(),
    lastBattlefieldReport: undefined,
    vault: { gold: VAULT.startingGold, repairSpent: 0, incomeTotal: 0 },
    economy: createInitialEconomy(0),
    raidPlan: undefined,
    weeklyPlan: undefined,
    lastRaidNight: undefined,
    honorWall: createEmptyHonorWall(),
    hallOfFame: [],
    world: createServerWorld(seed32),
    nextEventSeq: 1,
  };
}

/** 公会名规范化:去首尾空白 + 截断;非法(空)返回 undefined。规则只存在于 sim。 */
export function normalizeGuildName(raw: string): string | undefined {
  const name = raw.trim().slice(0, GUILD_NAME_MAX_LENGTH);
  return name === '' ? undefined : name;
}
