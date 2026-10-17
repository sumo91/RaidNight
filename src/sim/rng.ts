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
