import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from '../sim/clock';
import type { SimInput } from '../sim/facade';
import type { SimEvent } from '../sim/events';
import type { GameState } from '../sim/state';
import { formatGameClock, formatGameStamp } from './format';

/**
 * 薄渲染层:只读状态、派发输入,不含任何业务规则。
 * 一切规则(校验、结算、时间推进)都在 sim 门面内。
 */

export interface AppHandle {
  /** 用新状态重渲染;newEvents 追加进滚动日志缓冲。 */
  render(state: GameState, newEvents: readonly SimEvent[]): void;
}

export interface MountOptions {
  /** 把门面输入(指令/时间增量)交给装配层转发给门面。 */
  dispatch: (input: SimInput) => void;
}

/** 五页签(DESIGN.md:名册/编成/日程/世界/金库·荣誉);T1 仅名册页签为空态。 */
const TABS = [
  { id: 'roster', label: '名册' },
  { id: 'squads', label: '编成' },
  { id: 'schedule', label: '日程' },
  { id: 'world', label: '世界' },
  { id: 'vault', label: '金库·荣誉' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** 日志缓冲上限(UI 侧的展示缓冲;完整日志由门面事件流给出)。 */
const FEED_LIMIT = 50;

export function mountApp(root: HTMLElement, options: MountOptions): AppHandle {
  root.innerHTML = `
    <header class="app-header">
      <div class="guild-row">
        <h1 class="guild-name" data-ref="guild-name"></h1>
        <span class="member-count" data-ref="member-count"></span>
      </div>
      <div class="game-clock" data-ref="game-clock"></div>
    </header>
    <main class="panes">
      <section class="pane" data-pane="roster">
        <p class="empty-hint">名册空空如也 —— 招募与团员系统在后续工单开放。</p>
      </section>
      <section class="pane" data-pane="squads" hidden>
        <p class="empty-hint">「编成」页签在后续工单开放。</p>
      </section>
      <section class="pane" data-pane="schedule" hidden>
        <p class="empty-hint">「日程」页签在后续工单开放。</p>
      </section>
      <section class="pane" data-pane="world" hidden>
        <p class="empty-hint">「世界」页签在后续工单开放。</p>
      </section>
      <section class="pane" data-pane="vault" hidden>
        <p class="empty-hint">「金库·荣誉」页签在后续工单开放。</p>
      </section>
    </main>
    <section class="event-panel">
      <h2 class="panel-title">事件日志</h2>
      <ul class="event-feed" data-ref="event-feed">
        <li class="feed-empty">暂无事件 —— 游戏时间推进后会在这里出现日更与周更。</li>
      </ul>
    </section>
    <div class="dev-strip">
      <span class="dev-label">调试</span>
      <button type="button" data-dev="day">+1 游戏日</button>
      <button type="button" data-dev="week">+1 游戏周</button>
      <button type="button" data-dev="rename">公会改名</button>
    </div>
    <nav class="tab-bar">
      ${TABS.map((tab) => `<button type="button" data-tab="${tab.id}"${tab.id === 'roster' ? ' class="active"' : ''}>${tab.label}</button>`).join('\n')}
    </nav>
  `;

  const guildNameEl = requireElement<HTMLHeadingElement>(root, 'guild-name');
  const memberCountEl = requireElement<HTMLSpanElement>(root, 'member-count');
  const gameClockEl = requireElement<HTMLDivElement>(root, 'game-clock');
  const feedEl = requireElement<HTMLUListElement>(root, 'event-feed');

  // 页签切换:纯展示行为(哪个 pane 可见),不是业务规则
  let activeTab: TabId = 'roster';
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    button.addEventListener('click', () => {
      activeTab = button.dataset.tab as TabId;
      for (const btn of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
        btn.classList.toggle('active', btn === button);
      }
      for (const pane of root.querySelectorAll<HTMLElement>('[data-pane]')) {
        pane.hidden = pane.dataset.pane !== activeTab;
      }
    });
  }

  // 调试条:与 UI 时钟一样,只是向门面派发输入(时间跳变/指令),不实现规则
  const devDay = root.querySelector<HTMLButtonElement>('[data-dev="day"]');
  devDay?.addEventListener('click', () => options.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY }));
  const devWeek = root.querySelector<HTMLButtonElement>('[data-dev="week"]');
  devWeek?.addEventListener('click', () => options.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK }));
  const devRename = root.querySelector<HTMLButtonElement>('[data-dev="rename"]');
  devRename?.addEventListener('click', () => {
    const name = window.prompt('新的公会名(规则由模拟门面裁决):');
    if (name !== null) {
      options.dispatch({ command: { type: 'renameGuild', name }, deltaGameMinutes: 0 });
    }
  });

  const feed: SimEvent[] = [];

  function render(state: GameState, newEvents: readonly SimEvent[]): void {
    guildNameEl.textContent = state.guild.name;
    memberCountEl.textContent = `在册团员 ${state.members.length} 人`;
    gameClockEl.textContent = formatGameClock(state.clockGameMinutes);

    if (newEvents.length > 0) {
      feed.push(...newEvents);
      if (feed.length > FEED_LIMIT) {
        feed.splice(0, feed.length - FEED_LIMIT);
      }
      feedEl.replaceChildren(
        ...feed
          .slice(-12)
          .reverse()
          .map((event) => {
            const li = document.createElement('li');
            const stamp = document.createElement('span');
            stamp.className = 'stamp';
            stamp.textContent = `[${formatGameStamp(event.atGameMinutes)}]`;
            li.append(stamp, document.createTextNode(event.text));
            return li;
          }),
      );
    }
  }

  return { render };
}

function requireElement<T extends HTMLElement>(root: HTMLElement, ref: string): T {
  const el = root.querySelector<T>(`[data-ref="${ref}"]`);
  if (el === null) {
    throw new Error(`应用外壳缺少节点:${ref}`);
  }
  return el;
}
