import { ATTENDANCE_STYLES } from '../content/attendance';
import { CLASSES } from '../content/classes';
import { GEAR_SLOTS, QUALITY_RULES } from '../content/gear';
import { FAMILY_NAME_POOL, GIVEN_NAME_POOL } from '../content/names';
import { ROSTER_GEN, type Range } from '../content/roster-gen';
import { SKILL_TIERS, type SkillTierDef } from '../content/skill-tiers';
import { TRAIT_POOL } from '../content/traits';
import { nextInt, pickOne, pickWeighted } from './rng';
import type { AttendanceProfile, GearItem, Member, MemberProfile } from './state';

/**
 * 团员画像生成:纯函数、只走注入的种子随机链(src/sim/rng.ts),
 * 规则数值全部来自 src/content/(数据驱动,可配置)。
 *
 * 抽取顺序固定:姓名 → 职业 → 专精 → 等级 → 8 部位装备 → 三维 → 出勤画像
 * → 性格标签个数与内容 → 技艺评级;任何一步都消费并传递随机链状态,
 * 因此「同一种子 + 同一配置 ⇒ 同一批团员」。
 * 建会名册与申请池共用本模块;申请池经 options 覆盖等级区间与技艺权重。
 */

/** 生成结果:名册 + 生成结束后的随机链状态 + 下一个团员 id。 */
export interface FoundingRoster {
  readonly members: readonly Member[];
  readonly rngState: number;
  readonly nextMemberId: number;
}

export function generateFoundingRoster(seed: number): FoundingRoster {
  let rng: number = seed;
  const members: Member[] = [];
  const usedNames = new Set<string>();

  // 会长角色最先入册(id 1)
  const chairman = generateMember(rng, 1, { isChairman: true, usedNames });
  rng = chairman[1];
  members.push(chairman[0]);
  usedNames.add(chairman[0].name);

  for (let i = 0; i < ROSTER_GEN.foundingMemberCount; i++) {
    const id = members.length + 1;
    const member = generateMember(rng, id, { isChairman: false, usedNames });
    rng = member[1];
    members.push(member[0]);
    usedNames.add(member[0].name);
  }

  return { members, rngState: rng, nextMemberId: members.length + 1 };
}

/** 画像生成选项。 */
export interface GenerateProfileOptions {
  readonly isChairman: boolean;
  /** 同批已用姓名(去重) */
  readonly usedNames: ReadonlySet<string>;
  /** 等级区间覆盖(申请池规格用;缺省取 ROSTER_GEN 配置) */
  readonly levelRange?: Range;
  /** 技艺档权重覆盖(申请池规格用;缺省取 SKILL_TIERS 基础权重) */
  readonly skillTiers?: readonly SkillTierDef[];
}

/** 生成一名在册团员(id 由名册分配)。 */
function generateMember(
  rng: number,
  id: number,
  options: GenerateProfileOptions,
): [Member, number] {
  const [profile, nextState] = generateMemberProfile(rng, options);
  return [{ id, isChairman: options.isChairman, ...profile }, nextState];
}

/** 生成一份团员画像:在册团员与申请人共用。 */
export function generateMemberProfile(
  rng: number,
  options: GenerateProfileOptions,
): [MemberProfile, number] {
  const { isChairman } = options;

  // 1) 姓名(同批去重;组合空间远大于名册规模,重试用尽后接受重名)
  const [name, afterName] = generateUniqueName(rng, options.usedNames);
  let state = afterName;

  // 2) 职业(按分布权重)与专精(职业内等概率)
  const [cls, afterClass] = pickWeighted(state, CLASSES);
  state = afterClass;
  const [spec, afterSpec] = pickOne(state, cls.specs);
  state = afterSpec;

  // 3) 等级:会长取固定值,其余按区间随机(申请池可覆盖区间)
  const defaultLevelRange: Range = isChairman
    ? [ROSTER_GEN.chairman.level, ROSTER_GEN.chairman.level]
    : ROSTER_GEN.member.levelRange;
  const levelRange = options.levelRange ?? defaultLevelRange;
  const [level, afterLevel] = nextInt(state, levelRange[0], levelRange[1]);
  state = afterLevel;

  // 4) 8 部位装备:品质加权,装等 = 等级 + 品质加成 ± 扰动(下限 1)
  const [gear, afterGear] = generateGear(state, level);
  state = afterGear;

  // 5) 三维状态:会长与普通团员各有区间;会长忠诚恒 100(那是他自己的公会)
  const moodRange = isChairman ? ROSTER_GEN.chairman.moodRange : ROSTER_GEN.member.moodRange;
  const fatigueRange = isChairman ? ROSTER_GEN.chairman.fatigueRange : ROSTER_GEN.member.fatigueRange;
  const [mood, afterMood] = nextInt(state, moodRange[0], moodRange[1]);
  state = afterMood;
  const [fatigue, afterFatigue] = nextInt(state, fatigueRange[0], fatigueRange[1]);
  state = afterFatigue;
  let loyalty: number;
  if (isChairman) {
    loyalty = 100;
  } else {
    const [rolled, afterLoyalty] = nextInt(state, ROSTER_GEN.member.loyaltyRange[0], ROSTER_GEN.member.loyaltyRange[1]);
    loyalty = rolled;
    state = afterLoyalty;
  }

  // 6) 出勤画像:会长固定「铁打的」(他必然到场),普通团员按风格权重抽
  const attendanceResult = isChairman
    ? rollAttendanceFromStyle(state, ROSTER_GEN.chairman.attendanceStyleId, ROSTER_GEN.chairman.attendanceRateRange)
    : generateAttendance(state);
  const [attendance, afterAttendance] = attendanceResult;
  state = afterAttendance;

  // 7) 性格标签(1–2 个,不重复)
  const [traits, afterTraits] = generateTraits(state);
  state = afterTraits;

  // 8) 技艺评级(按档位权重;申请池可换声望驱动的重加权档位表)
  const [tier, afterTier] = pickWeighted(state, options.skillTiers ?? SKILL_TIERS);
  state = afterTier;

  return [
    {
      name,
      classId: cls.id,
      specId: spec.id,
      level,
      experience: 0, // 入册即 0 经验起步,成长由练级活动积累
      gear,
      mood,
      loyalty,
      fatigue,
      personalGold: 0, // 入册身无分文:个人金从打工与野团挣起(GLOSSARY:个人金)
      dkp: 0, // 出勤积分从 0 记起(仅 DKP 制下增减)
      attendance,
      traits,
      skillTierId: tier.id,
    },
    state,
  ];
}

/** 姓名 = 姓 + 名,等概率组合;同批去重。 */
function generateUniqueName(rng: number, usedNames: ReadonlySet<string>): [string, number] {
  let state = rng;
  let last = '';
  for (let attempt = 0; attempt < Math.max(1, ROSTER_GEN.nameUniqueAttempts); attempt++) {
    const [family, afterFamily] = pickOne(state, FAMILY_NAME_POOL);
    const [given, afterGiven] = pickOne(afterFamily, GIVEN_NAME_POOL);
    state = afterGiven;
    last = family + given;
    if (!usedNames.has(last)) {
      return [last, state];
    }
  }
  return [last, state]; // 极罕见:接受重名(确定性不受影响)
}

/** 8 部位装备:每件独立抽品质与装等扰动。 */
function generateGear(rng: number, level: number): [GearItem[], number] {
  let state = rng;
  const gear: GearItem[] = [];
  for (const slot of GEAR_SLOTS) {
    const [rule, afterQuality] = pickWeighted(state, QUALITY_RULES);
    const [jitter, afterJitter] = nextInt(afterQuality, -ROSTER_GEN.itemLevelJitter, ROSTER_GEN.itemLevelJitter);
    state = afterJitter;
    const itemLevel = Math.max(1, level + rule.itemLevelBonus + jitter);
    gear.push({ slot, quality: rule.quality, itemLevel });
  }
  return [gear, state];
}

/** 出勤画像:风格按权重抽,基础出勤率在风格区间内随机。 */
function generateAttendance(rng: number): [AttendanceProfile, number] {
  const [style, afterStyle] = pickWeighted(rng, ATTENDANCE_STYLES);
  return rollAttendanceFromStyle(afterStyle, style.id, style.baseRateRange);
}

/** 指定风格的出勤画像(会长角色用)。 */
function rollAttendanceFromStyle(rng: number, styleId: string, rateRange: Range): [AttendanceProfile, number] {
  const [baseRate, nextState] = nextInt(rng, rateRange[0], rateRange[1]);
  return [{ styleId, baseRate }, nextState];
}

/** 性格标签:先抽个数(1–2),再逐个抽取并去重。 */
function generateTraits(rng: number): [string[], number] {
  const [countEntry, afterCount] = pickWeighted(rng, ROSTER_GEN.traitCountWeights);
  const [first, afterFirst] = pickOne(afterCount, TRAIT_POOL);
  if (countEntry.count <= 1) {
    return [[first.id], afterFirst];
  }
  const [second, afterSecond] = pickOne(afterFirst, TRAIT_POOL);
  if (second.id === first.id) {
    return [[first.id], afterSecond]; // 撞签则只留一个(确定性)
  }
  return [[first.id, second.id], afterSecond];
}
