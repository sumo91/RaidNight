/**
 * 会长指令:门面输入的指令部分。
 * 后续工单(招募、编成、分配制度、开团决策……)都在这里扩展指令类型;
 * 指令只描述「会长想做什么」,生效规则一律在门面内实现。
 */

export type GuildCommand =
  /** 公会更名 */
  | { readonly type: 'renameGuild'; readonly name: string };

/** 公会名长度上限(规则只存在于 sim,UI 不做校验)。 */
export const GUILD_NAME_MAX_LENGTH = 24;
