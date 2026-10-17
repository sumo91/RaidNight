import { ATTENDANCE_BY_ID } from '../content/attendance';
import { CLASS_BY_ID } from '../content/classes';
import type { Quality } from '../content/gear';
import { SKILL_TIER_BY_ID } from '../content/skill-tiers';
import { TRAIT_BY_ID } from '../content/traits';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from '../sim/clock';
import type { SimInput } from '../sim/facade';
import type { SimEvent } from '../sim/events';
import { averageItemLevel } from '../sim/roster';
import type { GameState, Member } from '../sim/state';
import { formatGameClock, formatGameStamp } from './format';

/**
 * 薄渲染层:只读状态、派发输入,不含任何业务规则。
 * 一切规则(校验、结算、时间推进、派生数值)都在 sim 门面内;
 * 这里只做「状态 → DOM」的映射与纯展示行为(页签/选中)。
 */

export interface AppHandle {
  /** 用新状态重渲染;newEvents 追加进滚动日志缓冲。 */
  render(state: GameState, newEvents: readonly SimEvent[]): void;
}

export interface MountOptions {
  /** 把门面输入(指令/时间增量)交给装配层转发给门面。 */
  dispatch: (input: SimInput) => void;
}

/** 五页签(DESIGN.md:名册/编成/日程/世界/金库·荣誉);名册是首页(ADR-0006 组建之乐)。 */
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

/** 装备品质 → 样式类(纯展示映射,品质语义在 sim/content)。 */
const QUALITY_CLASS: Record<Quality, string> = {
  '白': 'q-white',
  '绿': 'q-green',
  '蓝': 'q-blue',
  '紫': 'q-purple',
};

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
        <ul class="roster-list" data-ref="roster-list"></ul>
        <div class="member-detail" data-ref="member-detail" hidden></div>
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
  const rosterListEl = requireElement<HTMLUListElement>(root, 'roster-list');
  const memberDetailEl = requireElement<HTMLDivElement>(root, 'member-detail');

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

  // 名册浏览:点行看详情、返回回列表 —— 选中态是纯 UI 状态,不进 GameState
  let selectedMemberId: number | null = null;
  let latestState: GameState | null = null;
  rosterListEl.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-member-id]');
    if (row !== null) {
      selectedMemberId = Number(row.dataset.memberId);
      renderRoster();
    }
  });
  memberDetailEl.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('[data-action="back"]') !== null) {
      selectedMemberId = null;
      renderRoster();
    }
  });

  const feed: SimEvent[] = [];

  function render(state: GameState, newEvents: readonly SimEvent[]): void {
    latestState = state;
    guildNameEl.textContent = state.guild.name;
    memberCountEl.textContent = `在册团员 ${state.members.length} 人`;
    gameClockEl.textContent = formatGameClock(state.clockGameMinutes);
    renderRoster();

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

  /** 名册区渲染:无选中 → 列表;有选中 → 详情(成员不存在时回退列表)。 */
  function renderRoster(): void {
    const state = latestState;
    if (state === null) {
      return;
    }
    const selected =
      selectedMemberId === null
        ? undefined
        : state.members.find((m) => m.id === selectedMemberId);
    if (selected === undefined) {
      selectedMemberId = null;
      memberDetailEl.hidden = true;
      rosterListEl.hidden = false;
      renderRosterList(state.members);
    } else {
      rosterListEl.hidden = true;
      memberDetailEl.hidden = false;
      renderMemberDetail(selected);
    }
  }

  /** 名册列表:职业 / 等级 / 装等摘要(验收标准 1)。 */
  function renderRosterList(members: readonly Member[]): void {
    if (members.length === 0) {
      rosterListEl.replaceChildren(
        el('li', 'empty-hint', '名册空空如也 —— 招募系统在后续工单开放。'),
      );
      return;
    }
    rosterListEl.replaceChildren(
      ...members.map((member) => {
        const cls = CLASS_BY_ID.get(member.classId);
        const spec = cls?.specs.find((s) => s.id === member.specId);
        const classLine = `${cls?.name ?? '?'} · ${spec?.name ?? '?'}${spec ? ` · ${spec.role}` : ''}`;

        const top = el('div', 'row-top');
        const nameWrap = el('div', 'row-name');
        nameWrap.append(el('span', 'member-name', member.name));
        if (member.isChairman) {
          nameWrap.append(el('span', 'chairman-badge', '会长'));
        }
        const summary = el('span', 'row-summary', `Lv${member.level} · 装等${averageItemLevel(member)}`);
        top.append(nameWrap, summary);

        const bottom = el('div', 'row-bottom');
        bottom.append(el('span', 'row-class', classLine));
        bottom.append(
          el(
            'span',
            'row-vitals',
            `心情${member.mood} 忠诚${member.loyalty} 疲劳${member.fatigue}`,
          ),
        );

        const row = el('li', 'roster-row');
        row.dataset.memberId = String(member.id);
        row.append(top, bottom);
        return row;
      }),
    );
  }

  /** 团员详情:全部维度 —— 三维/出勤/性格/技艺/装备(验收标准 2)。 */
  function renderMemberDetail(member: Member): void {
    const cls = CLASS_BY_ID.get(member.classId);
    const spec = cls?.specs.find((s) => s.id === member.specId);
    const style = ATTENDANCE_BY_ID.get(member.attendance.styleId);
    const tier = SKILL_TIER_BY_ID.get(member.skillTierId);

    const frag = document.createDocumentFragment();

    const back = el('button', 'detail-back', '← 返回名册');
    back.type = 'button';
    back.dataset.action = 'back';
    frag.append(back);

    const title = el('div', 'detail-title');
    const nameWrap = el('h3', 'detail-name');
    nameWrap.append(el('span', 'member-name', member.name));
    if (member.isChairman) {
      nameWrap.append(el('span', 'chairman-badge', '会长'));
    }
    title.append(nameWrap);
    title.append(el('div', 'detail-classline', `${cls?.name ?? '?'} · ${spec?.name ?? '?'} · ${spec?.role ?? '?'}`));
    if (cls !== undefined) {
      title.append(el('p', 'detail-flavor', cls.description));
    }
    frag.append(title);

    const stats = el('div', 'detail-stats');
    stats.append(
      el('div', 'stat', `等级 ${member.level}`),
      el('div', 'stat stat-accent', `装等 ${averageItemLevel(member)}`),
    );
    frag.append(stats);

    frag.append(el('h4', 'detail-section', '三维状态'));
    const vitals = el('div', 'detail-vitals');
    vitals.append(
      vitalBar('心情', member.mood),
      vitalBar('忠诚', member.loyalty),
      vitalBar('疲劳', member.fatigue),
    );
    frag.append(vitals);

    frag.append(el('h4', 'detail-section', '出勤画像'));
    const attendance = el('div', 'detail-block');
    attendance.append(
      el('div', 'block-title', `${style?.name ?? '?'} —— ${style?.description ?? ''}`),
      meterBar('基础出勤', member.attendance.baseRate),
    );
    frag.append(attendance);

    frag.append(el('h4', 'detail-section', '性格标签'));
    const traits = el('div', 'detail-traits');
    for (const id of member.traits) {
      const def = TRAIT_BY_ID.get(id);
      if (def !== undefined) {
        const chip = el('span', 'trait-chip', def.name);
        chip.title = def.description;
        traits.append(chip);
      }
    }
    if (traits.childElementCount === 0) {
      traits.append(el('span', 'muted', '无'));
    }
    frag.append(traits);

    frag.append(el('h4', 'detail-section', '技艺评级'));
    frag.append(el('div', 'detail-block', `${tier?.name ?? '?'} —— ${tier?.description ?? ''}`));

    frag.append(el('h4', 'detail-section', '装备(8 部位)'));
    const gearList = el('ul', 'gear-list');
    for (const item of member.gear) {
      const li = el('li', 'gear-row');
      li.append(el('span', 'gear-slot', item.slot));
      li.append(el('span', `gear-quality ${QUALITY_CLASS[item.quality]}`, item.quality));
      li.append(el('span', 'gear-ilvl', `装等 ${item.itemLevel}`));
      gearList.append(li);
    }
    frag.append(gearList);

    memberDetailEl.replaceChildren(frag);
  }

  /** 三维状态条(0-100;纯展示)。 */
  function vitalBar(label: string, value: number): HTMLElement {
    const row = el('div', 'vital-row');
    row.append(el('span', 'vital-label', label));
    const track = el('div', 'vital-track');
    const fill = el('div', `vital-fill${label === '疲劳' ? ' vital-fill-inverse' : ''}`);
    fill.style.width = `${clampPercent(value)}%`;
    track.append(fill);
    row.append(track, el('span', 'vital-value', String(value)));
    return row;
  }

  /** 出勤率条(0-100;纯展示)。 */
  function meterBar(label: string, value: number): HTMLElement {
    const row = el('div', 'vital-row');
    row.append(el('span', 'vital-label', label));
    const track = el('div', 'vital-track');
    const fill = el('div', 'vital-fill');
    fill.style.width = `${clampPercent(value)}%`;
    track.append(fill);
    row.append(track, el('span', 'vital-value', `${value}%`));
    return row;
  }

  function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, value));
  }

  return { render };
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

function requireElement<T extends HTMLElement>(root: HTMLElement, ref: string): T {
  const dom = root.querySelector<T>(`[data-ref="${ref}"]`);
  if (dom === null) {
    throw new Error(`应用外壳缺少节点:${ref}`);
  }
  return dom;
}
