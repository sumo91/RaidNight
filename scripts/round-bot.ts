/**
 * 贪心机器人(T18 节奏验证工具):把游戏从建会真实玩到通关最终团本。
 *
 * 开发期工具(非游戏本体):只经门面接缝发会长指令 + 时间增量,
 * 策略全部是玩家可执行的常规操作 —— scripts/sim-round.ts 用它做节奏
 * 粗调的时间线打印,src/sim/fullrun.test.ts 用它做「完整一轮可玩」的
 * 验收断言。改机器人策略不影响游戏数值;改内容表不需要改机器人。
 */

import { CLASS_BY_ID, type Role } from '../src/content/classes';
import { COMP } from '../src/content/comp';
import { DUNGEONS } from '../src/content/dungeons';
import { LEVELING_MAPS } from '../src/content/maps';
import { WORLD_BUFF_BY_ID, type ConsumableTierId } from '../src/content/raid-tactics';
import { FINAL_RAID, RAID_BY_ID as RAID_MAP, RAIDS, type RaidDef } from '../src/content/raids';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from '../src/sim/clock';
import { SimulationFacade } from '../src/sim/facade';
import type { GuildCommand } from '../src/sim/commands';
import type { SimEvent } from '../src/sim/events';
import { guildAverageItemLevel, guildAverageLevel, setBonusItemLevel } from '../src/sim/roster';
import type { GameState, Member, MemberProfile } from '../src/sim/state';

/** 机器人策略常量(不是游戏数值):练级/下本切换线与 G团接单的资金线。 */
const LEVEL_UNTIL = 59;
/** G团只在金库真正见底时救急。 */
const GRUN_WHEN_VAULT_BELOW = 150;
/** 名册目标:40 人团队(8 小队 × 5,会长角色在编)。 */
const ROSTER_TARGET = COMP.maxSquads * COMP.squadSize;

/** 一名画像的职能(内容表查表;机器人只读内容,不碰 sim 内部规则)。 */
function roleOf(profile: MemberProfile): Role | undefined {
  return CLASS_BY_ID.get(profile.classId)?.specs.find((spec) => spec.id === profile.specId)?.role;
}

/** 逐周边界快照(节奏粗调的可观察面)。 */
export interface WeekSnapshot {
  readonly week: number;
  readonly averageLevel: number;
  readonly averageItemLevel: number;
  readonly vaultGold: number;
  readonly rosterSize: number;
  readonly raidNight?: string;
  readonly clearedFinal: boolean;
}

/** 一轮的结果面:节奏与里程碑时刻。 */
export interface RoundOutcome {
  readonly state: GameState;
  /** 通关最终团本时的周序(1 起);未通关 = undefined。 */
  readonly finalClearWeek: number | undefined;
  readonly snapshots: readonly WeekSnapshot[];
  /** 全程发出的事件数(超限即机器人陷入指令风暴)。 */
  readonly eventCount: number;
  /** G团接单夜次数(追赶与接单场景的行为面)。 */
  readonly gRunNights: number;
  /** 穿满同套装 ≥2 件的团员数(2/5 件效果生效的行为面)。 */
  readonly setBonusMembers: number;
}

/**
 * 贪心机器人:一天一拍地玩(每日发一轮指令 + 推进一日)。
 * 策略全部是玩家可执行的常规操作;对游戏规则只做「读状态、发指令」,
 * 职能查内容表,解锁与否交门面裁决(被忽略的指令自然无效)。
 */
export class RoundBot {
  private readonly facade: SimulationFacade;
  private readonly snapshots: WeekSnapshot[] = [];
  private eventCount = 0;
  private gRunNights = 0;

  constructor(readonly seed: number, readonly guildName: string) {
    this.facade = new SimulationFacade(seed, guildName);
  }

  get state(): GameState {
    return this.facade.state;
  }

  private dispatch(command: GuildCommand): readonly SimEvent[] {
    const output = this.facade.dispatch({ command, deltaGameMinutes: 0 });
    this.eventCount += output.events.length;
    return output.events;
  }

  private advanceDay(): readonly SimEvent[] {
    const output = this.facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    this.eventCount += output.events.length;
    // G团夜计数:开夜日志逐条点数(一夜恰一条)
    this.gRunNights += output.events.filter(
      (event) => event.kind === '团本' && event.text.includes('团本夜开始') && event.text.includes('(G团接单)'),
    ).length;
    return output.events;
  }

  /** 是否已通关当期最终团本(荣誉墙集齐其全部首杀)。 */
  private finalCleared(): boolean {
    const killed = new Set(this.state.honorWall.firstKills.map((badge) => badge.bossId));
    return FINAL_RAID.bosses.every((boss) => killed.has(boss.id));
  }

  /** 休闲团本是否都已留有本会首杀(G团接单周顺手拿)。 */
  private casualsCleared(): boolean {
    const killed = new Set(this.state.honorWall.firstKills.map((badge) => badge.bossId));
    return RAIDS.filter((raid) => raid.casual === true).every((raid) =>
      raid.bosses.every((boss) => killed.has(boss.id)),
    );
  }

  /** 玩一整轮:逐日决策推进,直到通关最终团本(凯旋周补完休闲本的 G团首杀)或超时。 */
  play(maxWeeks: number): RoundOutcome {
    let finalClearWeek: number | undefined;
    for (let day = 0; day < maxWeeks * 7 && (finalClearWeek === undefined || !this.casualsCleared()); day++) {
      this.dailyDecisions();
      this.advanceDay();
      const week = Math.floor(this.state.clockGameMinutes / GAME_MINUTES_PER_WEEK) + 1;
      if (week > this.snapshots.length) {
        const report = this.state.lastRaidNight;
        const raidNight =
          report !== undefined && report.atGameMinutes > this.state.clockGameMinutes - GAME_MINUTES_PER_WEEK
            ? `${report.raidName}${report.gRun !== undefined ? '·G团' : ''}${report.cleared ? '·全通' : '·止步'}`
            : undefined;
        this.snapshots.push(this.snapshot(week, raidNight, this.finalCleared()));
      }
      if (finalClearWeek === undefined && this.finalCleared()) {
        finalClearWeek = week;
        this.snapshots[this.snapshots.length - 1] = this.snapshot(week, this.snapshots[this.snapshots.length - 1]?.raidNight, true);
      }
    }
    return {
      state: this.state,
      finalClearWeek,
      snapshots: this.snapshots,
      eventCount: this.eventCount,
      gRunNights: this.gRunNights,
      setBonusMembers: this.state.members.filter((member) => setBonusItemLevel(member) > 0).length,
    };
  }

  private snapshot(week: number, raidNight: string | undefined, clearedFinal: boolean): WeekSnapshot {
    return {
      week,
      averageLevel: guildAverageLevel(this.state.members),
      averageItemLevel: guildAverageItemLevel(this.state.members),
      vaultGold: this.state.vault.gold,
      rosterSize: this.state.members.length,
      raidNight,
      clearedFinal,
    };
  }

  /** 调试用:单日一步(决策 + 推进);节奏调参时不经 play 直接逐日观察。 */
  debugStep(day: number): void {
    this.dailyDecisions();
    this.advanceDay();
    if (day % 7 === 6) {
      console.log(`  day${day} 周${Math.floor(this.state.clockGameMinutes / (7 * 24 * 60)) + 1} 事件${this.eventCount}`);
    }
  }

  /** 每日开始的一揽子决策(全部是会长指令):招募 → 编队 → 活动 → 开团与战术。 */
  private dailyDecisions(): void {
    this.recruit();
    this.compose();
    this.assignActivities();
    this.sendCarry();
    this.planRaid();
    this.buyTactics();
  }

  /** 招募:缺口职能(坦克/治疗,每队 1 名 + 1 名余量)优先录取;
   * 名册席位还填不满时什么人都收(先成军再挑人);满编但缺职能时,
   * 淘汰富余职能里最弱的换血 —— 真实会长都会做的事。 */
  private recruit(): void {
    const state = this.state;
    const counts: Record<Role, number> = { 坦克: 0, 治疗: 0, 输出: 0 };
    for (const member of state.members) {
      const role = roleOf(member);
      if (role !== undefined) {
        counts[role] += 1;
      }
    }
    const squads = state.squads.length;
    // 坦克/治疗按「每队 1 名 + 1 名余量」计缺口;输出从不缺(凑数解决)
    const shortOf = (role: Role | undefined): boolean =>
      (role === '坦克' || role === '治疗') && (role === undefined ? false : counts[role] < squads + 1);
    // 凑数名额:现有小队席位 + 再建一队的余量。公会平均等级过了 50 就不再
    // 凑数(低等级新人只会拖慢门槛刻度),直到名册上限放开到 40 人档再续招
    const dilutionSafe =
      guildAverageLevel(state.members) < 50 || state.rosterCap >= ROSTER_TARGET;
    const fillerRoom = dilutionSafe
      ? squads * COMP.squadSize + COMP.squadSize - state.members.length
      : 0;
    const candidates = [...state.applicants]
      .filter((applicant) => shortOf(roleOf(applicant.profile)) || fillerRoom > 0)
      .sort((a, b) => {
        const rank = (applicant: typeof a) => (shortOf(roleOf(applicant.profile)) ? 0 : 1);
        return (
          rank(a) - rank(b) || b.profile.level - a.profile.level || a.applicationId - b.applicationId
        );
      });
    for (const applicant of candidates) {
      const role = roleOf(applicant.profile);
      const needed = shortOf(role);
      if (!needed && state.members.length >= Math.min(ROSTER_TARGET, state.rosterCap)) {
        return; // 凑数招募到满编为止
      }
      if (state.members.length >= Math.min(ROSTER_TARGET, state.rosterCap)) {
        // 满编但缺坦克/治疗:换血(淘汰富余职能里最弱的,腾位子给缺口)
        const victim = this.expendableMember(counts, squads);
        if (victim === undefined) {
          return;
        }
        this.dispatch({ type: 'dismissMember', memberId: victim.id });
        const victimRole = roleOf(victim);
        if (victimRole !== undefined) {
          counts[victimRole] -= 1;
        }
      }
      this.dispatch({ type: 'recruitApplicant', applicationId: applicant.applicationId });
      if (role !== undefined) {
        counts[role] += 1;
      }
    }
  }

  /** 富余职能里最可淘汰的团员(等级低者优先;会长角色不可淘汰)。
   * 「富余」按当前编队规模衡量:坦克/治疗多于每队 1 名 + 1 名余量、
   * 输出多于每队 3 名 + 1 名余量,才算有得换。 */
  private expendableMember(counts: Record<Role, number>, squads: number): Member | undefined {
    const surplus = (role: Role) =>
      role === '输出' ? counts[role] >= squads * 3 : counts[role] > squads + 1;
    return (
      this.state.members
        .filter((m) => !m.isChairman)
        .filter((m) => {
          const role = roleOf(m);
          return role !== undefined && surplus(role);
        })
        .sort((a, b) => a.level - b.level || a.id - b.id)[0] ?? undefined
    );
  }

  /** 编队:建队到名册允许的规模;逐队补职能(1 坦 1 奶)再补满员。 */
  private compose(): void {
    const wantedSquads = Math.min(COMP.maxSquads, Math.floor(this.state.members.length / COMP.squadSize));
    while (this.state.squads.length < wantedSquads) {
      this.dispatch({ type: 'createSquad' });
    }
    // 按 id 逐队处理(每次都从最新状态取队伍对象:编入指令会更新队伍,
    // 迭代陈旧快照会看到旧长度从而重复指派)
    for (const squadId of this.state.squads.map((squad) => squad.id)) {
      const squad = () => this.state.squads.find((entry) => entry.id === squadId)!;
      if (!this.resolve(squad()).some((m) => roleOf(m) === '坦克')) {
        const tank = this.pickUnassigned('坦克') ?? this.pickSpareFromSquads('坦克', squadId);
        if (tank !== undefined) {
          this.makeRoom(squadId);
          this.dispatch({ type: 'assignToSquad', memberId: tank.id, squadId });
        }
      }
      if (!this.resolve(squad()).some((m) => roleOf(m) === '治疗')) {
        const healer = this.pickUnassigned('治疗') ?? this.pickSpareFromSquads('治疗', squadId);
        if (healer !== undefined) {
          this.makeRoom(squadId);
          this.dispatch({ type: 'assignToSquad', memberId: healer.id, squadId });
        }
      }
      for (let guard = 0; guard < COMP.squadSize + 2; guard++) {
        if (this.resolve(squad()).length >= COMP.squadSize) {
          break;
        }
        const next = this.pickUnassigned();
        if (next === undefined) {
          break;
        }
        this.dispatch({ type: 'assignToSquad', memberId: next.id, squadId });
      }
    }
  }

  private resolve(squad: { readonly memberIds: readonly number[] }): readonly Member[] {
    const byId = new Map(this.state.members.map((m) => [m.id, m]));
    return squad.memberIds.map((id) => byId.get(id)).filter((m): m is Member => m !== undefined);
  }

  /** 满编小队腾位:先调离最可让的队员(输出优先,等级低者优先;不动唯一的坦/奶)。 */
  private makeRoom(squadId: number): void {
    const squad = this.state.squads.find((entry) => entry.id === squadId);
    if (squad === undefined || squad.memberIds.length < COMP.squadSize) {
      return;
    }
    const members = this.resolve(squad);
    const dps = members.filter((m) => roleOf(m) === '输出');
    const victimPool =
      dps.length > 0
        ? dps
        : members.filter((m) => {
            const role = roleOf(m);
            const others = members.filter((x) => x.id !== m.id && roleOf(x) === role);
            return role !== undefined && others.length >= 1; // 该职能还有别人
          });
    const victim = victimPool.sort((a, b) => a.level - b.level || a.id - b.id)[0];
    if (victim !== undefined) {
      this.dispatch({ type: 'removeFromSquad', memberId: victim.id });
    }
  }

  /** 别的小队里的「第二名」同职能成员(借调填补空缺;assignToSquad 自动先调离原队)。 */
  private pickSpareFromSquads(role: Role, excludeSquadId: number): Member | undefined {
    for (const other of this.state.squads) {
      if (other.id === excludeSquadId) {
        continue;
      }
      const spares = this.resolve(other).filter((m) => roleOf(m) === role);
      if (spares.length >= 2) {
        return spares.sort((a, b) => a.level - b.level || a.id - b.id)[0]!;
      }
    }
    return undefined;
  }

  /** 待命中最好的人选(等级高者优先;可限定职能)。 */
  private pickUnassigned(role?: Role): Member | undefined {
    const assigned = new Set(this.state.squads.flatMap((squad) => squad.memberIds));
    return this.state.members
      .filter((m) => !assigned.has(m.id))
      .filter((m) => role === undefined || roleOf(m) === role)
      .sort((a, b) => b.level - a.level || a.id - b.id)[0];
  }

  /** 活动安排:没到练级线的队去最高效地图练级;到了的队进驻
   * 「本队打得动」的最高 5 人本(打不动的本只会日日败退空耗)。 */
  private assignActivities(): void {
    const state = this.state;
    const averageLevel = guildAverageLevel(state.members);
    const bestMap = [...LEVELING_MAPS]
      .filter((m) => m.tier === '高效' && averageLevel >= m.levelBand.min)
      .sort((a, b) => b.levelBand.min - a.levelBand.min)[0];
    const unlockedDungeons = [...DUNGEONS].filter(
      (d) =>
        guildAverageLevel(state.members) >= d.unlock.averageLevel &&
        guildAverageItemLevel(state.members) >= d.unlock.averageItemLevel,
    );

    for (const squad of state.squads) {
      const members = this.resolve(squad);
      if (members.length === 0) {
        continue;
      }
      const squadAverageLevel = members.reduce((sum, m) => sum + m.level, 0) / members.length;
      const ready =
        members.length >= COMP.squadSize &&
        members.some((m) => roleOf(m) === '坦克') &&
        members.some((m) => roleOf(m) === '治疗');
      const current = squad.activity;
      if (ready && squadAverageLevel >= LEVEL_UNTIL && unlockedDungeons.length > 0) {
        // 本队战力粗估((装等 + 标准职能分)× 保守光环系数):挑「本队打得动」
        // 的最高一座 —— 打不动的本只会日日败退,白耗疲劳
        const squadPower =
          ((members.reduce((sum, m) => sum + m.gear.reduce((x, g) => x + g.itemLevel, 0) / 8, 0) /
            members.length) +
            21) *
          1.15;
        const clearable = unlockedDungeons.filter((d) => d.difficultyTarget <= squadPower);
        const target = clearable[clearable.length - 1] ?? unlockedDungeons[0];
        if (current?.type !== 'dungeon' || current.dungeonId !== target!.id) {
          this.dispatch({ type: 'assignDungeon', squadId: squad.id, dungeonId: target!.id });
        }
      } else if (bestMap !== undefined && (current?.type !== 'leveling' || current.mapId !== bestMap.id)) {
        this.dispatch({ type: 'assignLevelingMap', squadId: squad.id, mapId: bestMap.id });
      }
    }
  }

  /** 开团:金库吃紧接 G团单;否则沿内容表推进(周计划照目标自动开)。 */
  private planRaid(): void {
    const state = this.state;
    const killed = new Set(state.honorWall.firstKills.map((badge) => badge.bossId));
    const isCleared = (raid: RaidDef) => raid.bosses.every((boss) => killed.has(boss.id));
    const unlocked = (raid: RaidDef) =>
      guildAverageLevel(state.members) >= raid.unlock.averageLevel &&
      guildAverageItemLevel(state.members) >= raid.unlock.averageItemLevel;
    // 沿内容表顺序推进主力团本(40 人,先清低档拿套装与首杀,再上更高档);
    // 20 人休闲本不占推进位:追赶周(尚无主力本可开)与 G团接单周去打
    const progression = RAIDS.find((raid) => raid.casual !== true && unlocked(raid) && !isCleared(raid));

    // 金库见底或凯旋周(最终团本已通、休闲本未清):接 G团单挣钱,
    // 没打过的休闲本优先(首杀顺手拿)
    const victoryLap = this.finalCleared() && !this.casualsCleared();
    const nothingToProgress = progression === undefined;
    if ((victoryLap || (nothingToProgress && state.vault.gold < GRUN_WHEN_VAULT_BELOW)) && this.maybeGRun()) {
      return;
    }
    const fallback = [...RAIDS].reverse().find((raid) => unlocked(raid) && !isCleared(raid));
    const target = progression ?? fallback;
    if (target === undefined) {
      return; // 尚无团本可开
    }
    // 本周安排的是已全通的本(自动层照旧计划重开的):取消后照新目标重开;
    // 未通的本不中途换(决策金随取消作废)
    const plannedRaid = state.raidPlan === undefined ? undefined : RAID_MAP.get(state.raidPlan.raidId);
    if (
      state.raidPlan !== undefined &&
      plannedRaid !== undefined &&
      plannedRaid.bosses.every((boss) => killed.has(boss.id)) &&
      state.raidPlan.raidId !== target.id
    ) {
      this.dispatch({ type: 'cancelRaid' });
    }
    if (this.state.raidPlan === undefined || state.weeklyPlan?.raidId !== target.id) {
      this.dispatch({ type: 'setWeeklyPlan', goal: 'progress', raidId: target.id });
    }
  }

  /** G团接单:开放接单且已解锁、团队检查可达标的 20 人本里挑目标;
   * 本周已有安排则先取消(采购尚未发生,无浪费)。 */
  private maybeGRun(): boolean {
    const state = this.state;
    const fullSquads = state.squads.filter((squad) => this.resolve(squad).length >= COMP.squadSize).length;
    const candidates = RAIDS.filter(
      (raid) =>
        raid.gRunAllowed === true &&
        guildAverageLevel(state.members) >= raid.unlock.averageLevel &&
        guildAverageItemLevel(state.members) >= raid.unlock.averageItemLevel &&
        fullSquads >= Math.round(raid.size / COMP.squadSize),
    );
    const target = candidates[candidates.length - 1];
    if (target === undefined) {
      return false;
    }
    if (state.raidPlan !== undefined) {
      this.dispatch({ type: 'cancelRaid' });
    }
    const output = this.dispatch({ type: 'openRaid', raidId: target.id, gRun: true });
    return output.some((event) => event.kind === '团本');
  }

  /** 打工回血:金库见底时,装备最低的满职能队出坞打工挣外快(不占团本夜;
   * 队伍多起来才派 —— 早期每队都是练级/伐木主力,拆不起)。 */
  private sendCarry(): void {
    const state = this.state;
    if (state.squads.length < 6) {
      return;
    }
    const carrying = state.squads.find((squad) => squad.activity?.type === 'carry');
    if (state.vault.gold >= 1200) {
      if (carrying !== undefined) {
        this.dispatch({ type: 'stopCarry', squadId: carrying.id });
      }
      return;
    }
    if (carrying !== undefined) {
      return; // 已有一队在打工
    }
    const gearOf = (squad: (typeof state.squads)[number]) =>
      this.resolve(squad).reduce((sum, m) => sum + m.gear.reduce((x, g) => x + g.itemLevel, 0) / 8, 0) /
      Math.max(1, squad.memberIds.length);
    const ready = (squad: (typeof state.squads)[number]) => {
      const members = this.resolve(squad);
      return (
        members.length >= COMP.squadSize &&
        members.some((m) => roleOf(m) === '坦克') &&
        members.some((m) => roleOf(m) === '治疗')
      );
    };
    // 挑「打得动本但装备最落后」的满职能队:它伐木的边际收益本来最低
    const weakest = [...state.squads]
      .filter(ready)
      .sort((a, b) => gearOf(a) - gearOf(b) || a.id - b.id)[0];
    if (weakest !== undefined) {
      this.dispatch({ type: 'assignCarry', squadId: weakest.id });
    }
  }

  /** 战术采买:有开团安排时,按钱包买最贵的用得起的消耗品 + 战鼓(越早启用越稳)。 */
  private buyTactics(): void {
    const plan = this.state.raidPlan;
    if (plan === undefined) {
      return;
    }
    // 按钱包分档:宽裕全力开荒,吃紧标配,见底省着用,掏不起就不买
    // (G团急救线以下还要留出修理金余量)
    const gold = this.state.vault.gold;
    const wanted =
      gold >= 900 ? 'lavish' : gold >= 360 ? 'standard' : gold >= 150 ? 'frugal' : undefined;
    if (wanted !== undefined && plan.tactics?.consumableTier !== wanted) {
      this.dispatch({ type: 'setConsumableBudget', tier: wanted as ConsumableTierId });
    }
    const drums = WORLD_BUFF_BY_ID.get('war-drums');
    if (
      drums !== undefined &&
      gold >= 600 &&
      !(plan.tactics?.worldBuffs ?? []).some((armed) => armed.buffId === 'war-drums')
    ) {
      this.dispatch({ type: 'armWorldBuff', buffId: 'war-drums' });
    }
  }
}

