/**
 * 小组件薄渲染层(T19,GLOSSARY:小组件模式):只读状态、派发点击,
 * 不含任何业务规则 —— 倒计时/最近掉落/资源条的全部数据来自
 * sim/widget.ts 的纯派生函数,这里只做「状态 → DOM」映射与纯展示行为
 * (hover 展开、点击进入全窗)。
 *
 * 常驻占用低:DOM 一次建好,render 只改文本;派生视图序列化不变则
 * 整帧跳过(游戏分钟 ≈ 8.6 现实秒,实际重绘约每 9 秒一次)。
 * hover 展开用纯 CSS(:hover),不占用 JS。
 */

import { GAME_MINUTES_PER_WEEK, gameMinutesToRealMs } from '../sim/clock';
import { widgetView, type WidgetCountdownLine, type WidgetRecentLine } from '../sim/widget';
import type { GameState } from '../sim/state';
import { formatGameClock, formatGameDuration, formatRealDuration } from './format';

export interface WidgetOptions {
  /** 点击卡片进入全窗(装配层接到桌面壳命令;浏览器开发下的回退也由装配层定)。 */
  openFullWindow(): void;
}

export interface WidgetHandle {
  /** 用新状态重渲染小组件(派生视图无变化时跳过)。 */
  render(state: GameState): void;
  /** 标记「模拟已交还全窗」:桌面壳下全窗打开期间的冻结态提示。 */
  markDelegated(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** 倒计时主行文案:「团本夜「名」· 还有多久(约多少现实时)」。 */
function countdownPrimaryText(line: WidgetCountdownLine): string {
  const target = line.kind === '团本夜' && line.targetName !== undefined ? `「${line.targetName}」` : '';
  const weekNote = line.kind === '日结算' && line.isWeekBoundary ? '(周更)' : '';
  return `${line.kind}${target}${weekNote} 还有 ${formatGameDuration(line.remainingGameMinutes)}`;
}

/** 倒计时辅行文案:第二行(存在时)的紧凑形式,附现实时长。 */
function countdownSecondaryText(line: WidgetCountdownLine): string {
  const weekNote = line.isWeekBoundary ? '(周更)' : '';
  return `${line.kind}${weekNote} ${formatGameDuration(line.remainingGameMinutes)} · 约 ${formatRealDuration(
    gameMinutesToRealMs(line.remainingGameMinutes),
  )} 现实`;
}

/** 最近结果行文案(结构化 → 一行字;品质着色由类名做,见 widget.css)。 */
function recentLineText(line: WidgetRecentLine): string {
  switch (line.kind) {
    case '团本':
      return line.cleared
        ? `团本「${line.raidName}」全通(${line.kills}/${line.bossCount})`
        : `团本「${line.raidName}」${line.kills}/${line.bossCount},团灭于「${line.wipeBossName ?? '?'}」`;
    case '下本':
      return `第${line.squadOrdinal}队${line.success ? '速通' : '败退'}「${line.dungeonName}」 · 拾取 ${line.dropsEquipped}/${line.dropsTotal}`;
    case '战场':
      return `战场「${line.battlefieldName}」${line.victory ? '胜' : '败'} · 荣誉 +${line.honorGained}`;
    case '掉落':
      return `「${line.holder}」穿上${line.quality}装·${line.slot}(装等 ${line.itemLevel}) · ${line.source}`;
  }
}

/** 最近结果行的品质类名(掉落行按品质着色,其余按类别)。 */
function recentLineClass(line: WidgetRecentLine): string {
  if (line.kind === '掉落') {
    return `widget-recent-item q-${line.quality}`;
  }
  return `widget-recent-item widget-recent-${line.kind}`;
}

export function mountWidget(root: HTMLElement, options: WidgetOptions): WidgetHandle {
  root.innerHTML = `
    <div class="widget-card">
      <div class="widget-bar" data-tauri-drag-region>
        <span class="widget-grip" aria-hidden="true">⠿</span>
        <span class="widget-guild" data-ref="guild"></span>
        <span class="widget-clock" data-ref="clock"></span>
      </div>
      <div class="widget-main">
        <p class="widget-count-primary" data-ref="count-primary"></p>
        <p class="widget-count-secondary" data-ref="count-secondary"></p>
        <div class="widget-resources" data-ref="resources"></div>
        <p class="widget-delegated" data-ref="delegated" hidden>全窗运行中 —— 关闭全窗后这里恢复直播</p>
      </div>
      <div class="widget-preview">
        <div class="widget-preview-head">
          <span>最近战果</span>
          <span class="widget-preview-tip">点击卡片进入完整窗 · 拖顶栏移动 · 右下角调大小</span>
        </div>
        <ul class="widget-recent" data-ref="recent"></ul>
      </div>
      <div class="widget-resize-grip" title="拖动调整大小" aria-hidden="true"></div>
    </div>
  `;

  const card = root.querySelector<HTMLElement>('.widget-card')!;
  const guildEl = root.querySelector<HTMLElement>('[data-ref="guild"]')!;
  const clockEl = root.querySelector<HTMLElement>('[data-ref="clock"]')!;
  const primaryEl = root.querySelector<HTMLElement>('[data-ref="count-primary"]')!;
  const secondaryEl = root.querySelector<HTMLElement>('[data-ref="count-secondary"]')!;
  const resourcesEl = root.querySelector<HTMLElement>('[data-ref="resources"]')!;
  const delegatedEl = root.querySelector<HTMLElement>('[data-ref="delegated"]')!;
  const recentEl = root.querySelector<HTMLElement>('[data-ref="recent"]')!;

  // 点击卡片(顶栏与抓柄除外)⇒ 进入全窗;拖拽/调大小不误触
  card.addEventListener('click', (event) => {
    if ((event.target as Element).closest('.widget-bar, .widget-resize-grip') !== null) {
      return;
    }
    options.openFullWindow();
  });

  let lastSnapshot = '';
  let lastRecentSignature = '';

  function renderRecent(lines: readonly WidgetRecentLine[]): void {
    const signature = JSON.stringify(lines);
    if (signature === lastRecentSignature) {
      return;
    }
    lastRecentSignature = signature;
    if (lines.length === 0) {
      recentEl.replaceChildren(
        el('li', 'widget-recent-empty', '还没有战果 —— 安排小队活动后,最近结果与掉落会出现在这里。'),
      );
      return;
    }
    recentEl.replaceChildren(
      ...lines.map((line) => el('li', recentLineClass(line), recentLineText(line))),
    );
  }

  function render(state: GameState): void {
    const view = widgetView(state);
    const snapshot = JSON.stringify(view);
    if (snapshot === lastSnapshot) {
      return; // 派生视图一字未变:整帧跳过(常驻占用低)
    }
    lastSnapshot = snapshot;
    delegatedEl.hidden = true;
    guildEl.textContent = view.guildName;
    clockEl.textContent = formatGameClock(view.clockGameMinutes);
    const [primary, secondary] = view.countdown;
    primaryEl.textContent = primary === undefined ? '时钟停摆' : countdownPrimaryText(primary);
    // 辅行:团本夜为主行时给日结算,否则给「距团本周 CD」的静态提示
    if (secondary !== undefined) {
      secondaryEl.textContent = countdownSecondaryText(secondary);
    } else {
      secondaryEl.textContent = `团本 CD = 游戏周(${Math.round(GAME_MINUTES_PER_WEEK / 1440)} 天),开团后在此倒计时`;
    }
    resourcesEl.replaceChildren(
      el('span', 'widget-chip widget-chip-gold', `金库 ${view.resources.gold}`),
      el('span', 'widget-chip widget-chip-honor', `荣誉 ${view.resources.honorPoints}`),
      el('span', 'widget-chip widget-chip-roster', `名册 ${view.resources.rosterCount}/${view.resources.rosterCap}`),
      el('span', 'widget-chip widget-chip-renown', view.resources.renown),
    );
    renderRecent(view.recent);
  }

  function markDelegated(): void {
    delegatedEl.hidden = false;
    lastSnapshot = ''; // 交还标记不属于快照:清掉,下一次 render 必定全量应用
  }

  return { render, markDelegated };
}
