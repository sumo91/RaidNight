/**
 * 经济配置(数据驱动内容)。
 *
 * T10 只做「最小金库」:余额 + 修理支出(团灭代价的扣款账户);
 * 完整经济(双钱包、分配制度、打工收入)在 T11 经济工单 —— 届时在此扩表,
 * 不动模拟代码。规则逻辑在 src/sim/(结算与扣款),此处只有数值。
 */

/** 公会金库(GLOSSARY)配置。 */
export interface VaultConfig {
  /** 建会时的金库起始余额。 */
  readonly startingGold: number;
}

export const VAULT: VaultConfig = {
  startingGold: 500,
};
