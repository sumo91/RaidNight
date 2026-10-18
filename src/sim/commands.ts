/**
 * 会长指令:门面输入的指令部分。
 * 后续工单(招募、编成、分配制度、开团决策……)都在这里扩展指令类型;
 * 指令只描述「会长想做什么」,生效规则一律在门面内实现。
 */

import type { LootSystemId } from '../content/economy';
import type { WeeklyGoalId } from '../content/plan';
import type { ConsumableTierId, RaidStanceId, WorldBuffId } from '../content/raid-tactics';

export type GuildCommand =
  /** 公会更名 */
  | { readonly type: 'renameGuild'; readonly name: string }
  /** 招入申请(申请池 → 名册) */
  | { readonly type: 'recruitApplicant'; readonly applicationId: number }
  /** 拒绝申请(移出申请池) */
  | { readonly type: 'rejectApplicant'; readonly applicationId: number }
  /** 淘汰在册团员(移出名册;会长角色不可淘汰) */
  | { readonly type: 'dismissMember'; readonly memberId: number }
  /** 新建小队(编成;上限见 content/comp.maxSquads) */
  | { readonly type: 'createSquad' }
  /** 解散小队(仅空小队可解散) */
  | { readonly type: 'disbandSquad'; readonly squadId: number }
  /** 编入小队(已在别队则先调离;小队满员则拒绝) */
  | { readonly type: 'assignToSquad'; readonly memberId: number; readonly squadId: number }
  /** 调离小队(回到待命名册) */
  | { readonly type: 'removeFromSquad'; readonly memberId: number }
  /** 安排小队练级(进驻已解锁地图;未解锁/未知名图由门面忽略) */
  | { readonly type: 'assignLevelingMap'; readonly squadId: number; mapId: string }
  /** 停止小队练级(回城休整,疲劳自然恢复) */
  | { readonly type: 'stopLeveling'; readonly squadId: number }
  /** 安排小队下本(进驻已解锁 5 人本;未解锁/未满职能由门面忽略) */
  | { readonly type: 'assignDungeon'; readonly squadId: number; dungeonId: string }
  /** 停止小队下本(回城休整,疲劳自然恢复) */
  | { readonly type: 'stopDungeon'; readonly squadId: number }
  /** 安排小队 G团打工(外快,收入归个人金;未解锁/未满职能由门面忽略) */
  | { readonly type: 'assignCarry'; readonly squadId: number }
  /** 停止小队打工(回城休整,疲劳自然恢复) */
  | { readonly type: 'stopCarry'; readonly squadId: number }
  /** 安排小队跑野团(外快,收入归个人金;未解锁/未满职能由门面忽略) */
  | { readonly type: 'assignWildRaid'; readonly squadId: number }
  /** 停止小队野团(回城休整,疲劳自然恢复) */
  | { readonly type: 'stopWildRaid'; readonly squadId: number }
  /** 开团(计划层:安排下一个团本夜;内容阶梯未解锁/团队检查未过由门面忽略) */
  | { readonly type: 'openRaid'; readonly raidId: string }
  /** 取消开团安排(本周不开团) */
  | { readonly type: 'cancelRaid' }
  /**
   * 设定消耗品预算(开荒决策面,T14:金库拨款买药水合剂,提升当夜全团战力)。
   * 未开团/未知档位/金库不足/同档重复由门面忽略;换档再全额拨款、此前不退。
   */
  | { readonly type: 'setConsumableBudget'; readonly tier: ConsumableTierId }
  /**
   * 启用世界 Buff(开荒决策面,T14:拨款 + 筹备时长的时效增益)。
   * 未开团/未知 Buff/重复启用/金库不足由门面忽略;
   * 启用时刻距团本夜不足筹备时长 ⇒ 当夜无效(拨款不退)。
   */
  | { readonly type: 'armWorldBuff'; readonly buffId: WorldBuffId }
  /**
   * 编成微调阵形(开荒决策面,T14:职能分与光环覆盖的取舍系数)。
   * 未开团/未知阵形/同阵形重复由门面忽略。
   */
  | { readonly type: 'setRaidStance'; readonly stance: RaidStanceId }
  /**
   * 设定周计划(计划层,T15:每周团本夜安排 + 当周目标)。
   * 常驻模板:自动层每周照此开团;本周尚未开团时设定即照计划开团
   * (本周已手动开团的不被覆盖)。未知目标/未知团本由门面忽略。
   */
  | { readonly type: 'setWeeklyPlan'; readonly goal: WeeklyGoalId; readonly raidId: string }
  /** 取消周计划(此后每周团本夜需手动开团;本周已开的团不受影响) */
  | { readonly type: 'clearWeeklyPlan' }
  /** 更换分配制度(GLOSSARY:三选一可更换有转换成本;成本不足/制度相同由门面忽略) */
  | { readonly type: 'setLootSystem'; readonly system: LootSystemId }
  /** 开关自肥(仅会长裁量制下生效;GLOSSARY:自肥) */
  | { readonly type: 'setSelfDealing'; readonly enabled: boolean };

/** 公会名长度上限(规则只存在于 sim,UI 不做校验)。 */
export const GUILD_NAME_MAX_LENGTH = 24;
