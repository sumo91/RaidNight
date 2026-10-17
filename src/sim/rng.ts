/**
 * 注入式种子随机源(mulberry32)。
 *
 * 铁律:游戏本体(src/sim)禁用全局随机(Math.random 等)。
 * 一切随机必须经由本模块:随机链状态保存在 GameState.rngState 内,
 * 可序列化、可重放 —— 保证「同种子 + 同输入序列 ⇒ 同状态与同日志」。
 */

/** 从当前随机链状态取一个 [0,1) 均匀浮点,并返回下一状态。 */
export function nextFloat(state: number): [value: number, nextState: number] {
  let t = (state + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  return [value, t];
}

/** 从内容池等概率取一项,并返回下一随机链状态。 */
export function pickOne<T>(state: number, pool: readonly T[]): [item: T, nextState: number] {
  const [u, nextState] = nextFloat(state);
  const index = Math.min(pool.length - 1, Math.floor(u * pool.length));
  const item = pool[index];
  if (item === undefined) {
    throw new Error('内容池为空,无法随机选取');
  }
  return [item, nextState];
}

/** 带权重的随机条目(生成期分布配置用)。 */
export interface WeightedEntry {
  readonly weight: number;
}

/** 按权重取一项(权重为 0 的条目不会被抽中),并返回下一随机链状态。 */
export function pickWeighted<T extends WeightedEntry>(
  state: number,
  entries: readonly T[],
): [item: T, nextState: number] {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (total <= 0 || entries.length === 0) {
    throw new Error('权重全为非正数,无法随机选取');
  }
  const [u, nextState] = nextFloat(state);
  let cursor = u * total;
  for (const entry of entries) {
    cursor -= Math.max(0, entry.weight);
    if (cursor < 0) {
      return [entry, nextState];
    }
  }
  // 浮点兜底:最后一个权重非零的条目
  const lastPositive = [...entries].reverse().find((entry) => entry.weight > 0);
  return [lastPositive as T, nextState];
}

/** 取闭区间 [min, max] 内的整数,并返回下一随机链状态。 */
export function nextInt(state: number, min: number, max: number): [value: number, nextState: number] {
  if (max < min) {
    throw new Error('nextInt 区间非法:max < min');
  }
  const [u, nextState] = nextFloat(state);
  const span = max - min + 1;
  const value = min + Math.floor(u * span);
  return [Math.min(value, max), nextState];
}
