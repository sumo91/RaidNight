import { ATTENDANCE_BY_ID } from '../content/attendance';
import { COMP } from '../content/comp';
import { CLASS_BY_ID } from '../content/classes';
import type { Quality } from '../content/gear';
import { LEVELING } from '../content/maps';
import { SKILL_TIER_BY_ID } from '../content/skill-tiers';
import { TRAIT_BY_ID } from '../content/traits';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from '../sim/clock';
import type { SimInput } from '../sim/facade';
import type { SimEvent } from '../sim/events';
import { squadCompositions, teamCheck, unassignedMembers } from '../sim/comp';
import { dungeonStatuses, squadDungeon, squadDungeonReadiness } from '../sim/dungeon';
import { levelingMapStatuses, squadLevelingMap, xpToNextLevel } from '../sim/leveling';
import { averageItemLevel, guildAverageLevel } from '../sim/roster';
import type { DungeonRunReport, GameState, Member } from '../sim/state';
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
  /** 清空本地存档并重开(装配层拥有持久化;UI 不关心存储介质)。 */
  wipeSave?: () => void;
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
        <div class="roster-browse" data-ref="roster-browse">
          <div class="pool-panel">
            <div class="pool-head">
              <h2 class="section-title">申请池</h2>
              <span class="pool-sub" data-ref="pool-sub"></span>
            </div>
            <p class="pool-full-hint" data-ref="pool-full-hint" hidden></p>
            <ul class="pool-list" data-ref="pool-list"></ul>
          </div>
          <h2 class="section-title">在册团员</h2>
          <ul class="roster-list" data-ref="roster-list"></ul>
        </div>
        <div class="member-detail" data-ref="member-detail" hidden></div>
      </section>
      <section class="pane" data-pane="squads" hidden>
        <div class="team-check" data-ref="team-check"></div>
        <div class="squad-toolbar">
          <button type="button" class="squad-create" data-action="create-squad">新建小队</button>
          <span class="squad-cap" data-ref="squad-cap"></span>
        </div>
        <ul class="squad-list" data-ref="squad-list"></ul>
        <div class="bench-panel">
          <div class="pool-head">
            <h2 class="section-title">待命团员</h2>
            <span class="pool-sub" data-ref="bench-sub"></span>
          </div>
          <ul class="bench-list" data-ref="bench-list"></ul>
        </div>
      </section>
      <section class="pane" data-pane="schedule" hidden>
        <div class="report-panel" data-ref="dungeon-report-wrap" hidden>
          <div class="pool-head">
            <h2 class="section-title">最近下本</h2>
          </div>
          <div class="dungeon-report" data-ref="dungeon-report"></div>
        </div>
        <div class="leveling-head">
          <h2 class="section-title">练级安排</h2>
          <span class="leveling-avg" data-ref="leveling-avg"></span>
        </div>
        <p class="leveling-note">高效区经验多、疲劳与阵亡损耗高;休闲区反之。未安排练级的小队回城休整,疲劳自然恢复。</p>
        <ul class="map-list" data-ref="map-list"></ul>
        <div class="pool-head assign-head">
          <h2 class="section-title">小队分配</h2>
        </div>
        <ul class="assign-list" data-ref="assign-list"></ul>
        <div class="leveling-head dungeon-head">
          <h2 class="section-title">5 人本</h2>
        </div>
        <p class="leveling-note">派满职能小队(5 人 + 至少 1 坦 1 奶)进驻;成败由装等、职能与光环共同决定,胜利掉落装备并自动择优穿戴。</p>
        <ul class="map-list dungeon-list" data-ref="dungeon-list"></ul>
        <div class="pool-head assign-head">
          <h2 class="section-title">下本分配</h2>
        </div>
        <ul class="assign-list dungeon-assign-list" data-ref="dungeon-assign-list"></ul>
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
      <button type="button" data-dev="wipe">清档重开</button>
    </div>
    <nav class="tab-bar">
      ${TABS.map((tab) => `<button type="button" data-tab="${tab.id}"${tab.id === 'roster' ? ' class="active"' : ''}>${tab.label}</button>`).join('\n')}
    </nav>
  `;

  const guildNameEl = requireElement<HTMLHeadingElement>(root, 'guild-name');
  const memberCountEl = requireElement<HTMLSpanElement>(root, 'member-count');
  const gameClockEl = requireElement<HTMLDivElement>(root, 'game-clock');
  const feedEl = requireElement<HTMLUListElement>(root, 'event-feed');
  const rosterBrowseEl = requireElement<HTMLDivElement>(root, 'roster-browse');
  const rosterListEl = requireElement<HTMLUListElement>(root, 'roster-list');
  const memberDetailEl = requireElement<HTMLDivElement>(root, 'member-detail');
  const poolSubEl = requireElement<HTMLSpanElement>(root, 'pool-sub');
  const poolFullHintEl = requireElement<HTMLParagraphElement>(root, 'pool-full-hint');
  const poolListEl = requireElement<HTMLUListElement>(root, 'pool-list');
  const teamCheckEl = requireElement<HTMLDivElement>(root, 'team-check');
  const squadCapEl = requireElement<HTMLSpanElement>(root, 'squad-cap');
  const squadListEl = requireElement<HTMLUListElement>(root, 'squad-list');
  const benchSubEl = requireElement<HTMLSpanElement>(root, 'bench-sub');
  const benchListEl = requireElement<HTMLUListElement>(root, 'bench-list');
  const levelingAvgEl = requireElement<HTMLSpanElement>(root, 'leveling-avg');
  const mapListEl = requireElement<HTMLUListElement>(root, 'map-list');
  const assignListEl = requireElement<HTMLUListElement>(root, 'assign-list');
  const dungeonReportWrapEl = requireElement<HTMLDivElement>(root, 'dungeon-report-wrap');
  const dungeonReportEl = requireElement<HTMLDivElement>(root, 'dungeon-report');
  const dungeonListEl = requireElement<HTMLUListElement>(root, 'dungeon-list');
  const dungeonAssignListEl = requireElement<HTMLUListElement>(root, 'dungeon-assign-list');

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
  const devWipe = root.querySelector<HTMLButtonElement>('[data-dev="wipe"]');
  devWipe?.addEventListener('click', () => {
    if (window.confirm('清空本地存档并重新开始?此操作不可撤销。')) {
      options.wipeSave?.();
    }
  });

  // 编成页操作:只是把「建队/编入/调离/解散」转交给门面裁决(规则一律在 sim)
  squadListEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const removeButton = target.closest<HTMLButtonElement>('[data-action="remove-member"]');
    if (removeButton !== null && !removeButton.disabled) {
      options.dispatch({
        command: { type: 'removeFromSquad', memberId: Number(removeButton.dataset.memberId) },
        deltaGameMinutes: 0,
      });
      return;
    }
    const disbandButton = target.closest<HTMLButtonElement>('[data-action="disband-squad"]');
    if (disbandButton !== null && !disbandButton.disabled) {
      options.dispatch({ command: { type: 'disbandSquad', squadId: Number(disbandButton.dataset.squadId) }, deltaGameMinutes: 0 });
    }
  });
  root.querySelector<HTMLButtonElement>('[data-action="create-squad"]')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    if (!button.disabled) {
      options.dispatch({ command: { type: 'createSquad' }, deltaGameMinutes: 0 });
    }
  });
  // 待命团员编入:目标小队来自行内选择框;「满员禁用」只是展示,门面仍做最终裁决
  benchListEl.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action="assign"]');
    if (button === null || button.disabled) {
      return;
    }
    const row = button.closest<HTMLElement>('[data-member-id]');
    const select = row?.querySelector<HTMLSelectElement>('select');
    if (row === undefined || row === null || select === undefined || select === null || select.value === '') {
      return;
    }
    options.dispatch({
      command: {
        type: 'assignToSquad',
        memberId: Number(row.dataset.memberId),
        squadId: Number(select.value),
      },
      deltaGameMinutes: 0,
    });
  });
  benchListEl.addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement;
    if (!select.matches('select')) {
      return;
    }
    const row = select.closest<HTMLElement>('[data-member-id]');
    const button = row?.querySelector<HTMLButtonElement>('[data-action="assign"]');
    if (row != null && button != null) {
      syncAssignEnabled(row, button);
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
    const target = event.target as HTMLElement;
    if (target.closest('[data-action="back"]') !== null) {
      selectedMemberId = null;
      renderRoster();
      return;
    }
    // 淘汰在册团员:确认弹窗是纯展示行为,裁决权在门面(会长角色会被门面拒绝)
    const dismiss = target.closest<HTMLButtonElement>('[data-action="dismiss"]');
    if (dismiss !== null && !dismiss.disabled) {
      const memberId = Number(dismiss.dataset.memberId);
      const member = latestState?.members.find((m) => m.id === memberId);
      if (member !== undefined && window.confirm(`确定淘汰「${member.name}」吗?此操作不可撤销。`)) {
        options.dispatch({ command: { type: 'dismissMember', memberId }, deltaGameMinutes: 0 });
      }
    }
  });

  // 练级分配操作:只是把「进驻/停止练级」转交给门面裁决
  // (解锁校验、地图存在性一律在 sim;此处不禁用、不做规则判断)
  assignListEl.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
    if (button === null || button.disabled) {
      return;
    }
    const row = button.closest<HTMLElement>('[data-squad-id]');
    if (row === null) {
      return;
    }
    const squadId = Number(row.dataset.squadId);
    if (button.dataset.action === 'stop-leveling') {
      options.dispatch({ command: { type: 'stopLeveling', squadId }, deltaGameMinutes: 0 });
      return;
    }
    if (button.dataset.action === 'assign-leveling') {
      const select = row.querySelector<HTMLSelectElement>('select');
      if (select === null || select.value === '') {
        return;
      }
      options.dispatch({
        command: { type: 'assignLevelingMap', squadId, mapId: select.value },
        deltaGameMinutes: 0,
      });
    }
  });

  // 下本分配操作:只是把「进驻/停止下本」转交给门面裁决
  // (解锁与满职能校验一律在 sim;此处不禁用、不做规则判断)
  dungeonAssignListEl.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
    if (button === null || button.disabled) {
      return;
    }
    const row = button.closest<HTMLElement>('[data-squad-id]');
    if (row === null) {
      return;
    }
    const squadId = Number(row.dataset.squadId);
    if (button.dataset.action === 'stop-dungeon') {
      options.dispatch({ command: { type: 'stopDungeon', squadId }, deltaGameMinutes: 0 });
      return;
    }
    if (button.dataset.action === 'assign-dungeon') {
      const select = row.querySelector<HTMLSelectElement>('select');
      if (select === null || select.value === '') {
        return;
      }
      options.dispatch({
        command: { type: 'assignDungeon', squadId, dungeonId: select.value },
        deltaGameMinutes: 0,
      });
    }
  });

  // 申请池操作:只是把「招入/拒绝」转交给门面裁决(规则一律在 sim;
  // 名册已满时按钮只作展示性禁用,门面仍会最终拒绝越界指令)
  poolListEl.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-application-id]');
    if (button === null || button.disabled) {
      return;
    }
    const applicationId = Number(button.dataset.applicationId);
    if (button.dataset.action === 'recruit') {
      options.dispatch({ command: { type: 'recruitApplicant', applicationId }, deltaGameMinutes: 0 });
    } else if (button.dataset.action === 'reject') {
      options.dispatch({ command: { type: 'rejectApplicant', applicationId }, deltaGameMinutes: 0 });
    }
  });

  const feed: SimEvent[] = [];

  function render(state: GameState, newEvents: readonly SimEvent[]): void {
    latestState = state;
    guildNameEl.textContent = state.guild.name;
    memberCountEl.textContent = `在册 ${state.members.length}/${state.rosterCap} 人`;
    gameClockEl.textContent = formatGameClock(state.clockGameMinutes);
    renderPool(state);
    renderRoster();
    renderSquads(state);
    renderSchedule(state);

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

  /** 名册区渲染:无选中 → 申请池 + 列表;有选中 → 详情(成员不存在时回退列表)。 */
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
      rosterBrowseEl.hidden = false;
      renderRosterList(state.members);
    } else {
      rosterBrowseEl.hidden = true;
      memberDetailEl.hidden = false;
      renderMemberDetail(selected);
    }
  }

  /** 申请池渲染:每张申请卡只展示画像数据,「招入/拒绝」交给门面裁决。 */
  function renderPool(state: GameState): void {
    const full = state.members.length >= state.rosterCap;
    poolSubEl.textContent = `${state.applicants.length} 份申请 · 每游戏日按声望刷新`;
    poolFullHintEl.hidden = !full;
    if (full) {
      poolFullHintEl.textContent = `名册已满(${state.members.length}/${state.rosterCap}),淘汰团员可腾出名额。`;
    }

    if (state.applicants.length === 0) {
      poolListEl.replaceChildren(
        el('li', 'pool-empty', '今日的申请都已处理 —— 申请池每游戏日刷新。'),
      );
      return;
    }
    poolListEl.replaceChildren(
      ...state.applicants.map((applicant) => {
        const profile = applicant.profile;
        const cls = CLASS_BY_ID.get(profile.classId);
        const spec = cls?.specs.find((s) => s.id === profile.specId);
        const tier = SKILL_TIER_BY_ID.get(profile.skillTierId);

        const top = el('div', 'row-top');
        const nameWrap = el('div', 'row-name');
        nameWrap.append(el('span', 'member-name', profile.name));
        top.append(nameWrap, el('span', 'row-summary', `Lv${profile.level} · 装等${averageItemLevel(profile)}`));

        const bottom = el('div', 'row-bottom');
        bottom.append(
          el(
            'span',
            'row-class',
            `${cls?.name ?? '?'} · ${spec?.name ?? '?'}${spec ? ` · ${spec.role}` : ''} · ${tier?.name ?? '?'}`,
          ),
        );
        bottom.append(el('span', 'row-vitals', `忠诚${profile.loyalty} 心情${profile.mood}`));

        const actions = el('div', 'pool-actions');
        const recruit = el('button', 'pool-btn pool-btn-recruit', '招入');
        recruit.type = 'button';
        recruit.dataset.action = 'recruit';
        recruit.dataset.applicationId = String(applicant.applicationId);
        if (full) {
          recruit.disabled = true; // 展示性禁用:真实裁决仍在门面
          recruit.title = '名册已满';
        }
        const reject = el('button', 'pool-btn pool-btn-reject', '拒绝');
        reject.type = 'button';
        reject.dataset.action = 'reject';
        reject.dataset.applicationId = String(applicant.applicationId);
        actions.append(recruit, reject);

        const card = el('li', 'pool-card');
        card.append(top, bottom, actions);
        return card;
      }),
    );
  }

  /** 编成页渲染:团队检查 + 小队卡(职能缺口/光环预览)+ 待命团员(验收标准 1–3)。 */
  function renderSquads(state: GameState): void {
    // 团队检查面板:通过/未通过的明确反馈(验收标准 3)
    const check = teamCheck(state);
    const panel = el('div', `team-check-card${check.passed ? ' team-check-pass' : ' team-check-fail'}`);
    const head = el('div', 'team-check-head');
    head.append(el('span', 'team-check-title', `团队检查:${check.passed ? '通过' : '未通过'}`));
    head.append(
      el(
        'span',
        'team-check-sub',
        `小队 ${check.totals.squads}/${COMP.maxSquads} · 满员 ${check.totals.fullSquads}/${COMP.teamCheck.requiredFullSquads} · 在编 ${check.totals.assigned}/${COMP.maxSquads * COMP.squadSize} · 坦克 ${check.totals.tanks}/${COMP.teamCheck.minTanks} · 治疗 ${check.totals.healers}/${COMP.teamCheck.minHealers} · 输出 ${check.totals.dps}`,
      ),
    );
    panel.append(head);
    if (check.passed) {
      panel.append(el('p', 'team-check-ok', '阵容齐整,随时可以开团。'));
    } else {
      const list = el('ul', 'team-check-failures');
      for (const failure of check.failures) {
        const li = el('li', `failure failure-${failure.kind}`);
        li.textContent = failure.text;
        list.append(li);
      }
      panel.append(list);
    }
    teamCheckEl.replaceChildren(panel);

    // 工具条:新建小队(达上限时展示性禁用,门面仍做最终裁决)
    const createButton = root.querySelector<HTMLButtonElement>('[data-action="create-squad"]');
    const capped = state.squads.length >= COMP.maxSquads;
    if (createButton !== null) {
      createButton.disabled = capped;
      createButton.title = capped ? `团队最多 ${COMP.maxSquads} 支小队` : '';
    }
    squadCapEl.textContent = `${state.squads.length}/${COMP.maxSquads} 支`;

    // 小队卡:成员增删、职能缺口标示、光环与加成预览(验收标准 1 与 2)
    const compositions = squadCompositions(state);
    if (compositions.length === 0) {
      squadListEl.replaceChildren(
        el('li', 'empty-hint', '还没有小队 —— 一切活动的出勤以小队为原子,先建一支吧。'),
      );
    } else {
      squadListEl.replaceChildren(...compositions.map(renderSquadCard));
    }

    // 待命团员:名册中不在任何小队的成员
    const bench = unassignedMembers(state);
    benchSubEl.textContent = `${bench.length} 人待命`;
    if (bench.length === 0) {
      benchListEl.replaceChildren(el('li', 'empty-hint', '名册全员都在小队中。'));
      return;
    }
    if (state.squads.length === 0) {
      benchListEl.replaceChildren(el('li', 'empty-hint', '先在上方新建小队,才能编入团员。'));
      return;
    }
    benchListEl.replaceChildren(...bench.map((member) => renderBenchRow(member, state.squads)));
  }

  /** 单支小队卡:职能结构实时检查 + 光环预览。 */
  function renderSquadCard(composition: ReturnType<typeof squadCompositions>[number]): HTMLLIElement {
    const card = el('li', 'squad-card');

    const head = el('div', 'squad-head');
    const title = el('span', 'squad-title', `第 ${composition.ordinal} 小队`);
    const size = el('span', 'squad-size', `${composition.members.length}/${COMP.squadSize}`);
    head.append(title, size);
    if (composition.members.length === 0) {
      const disband = el('button', 'squad-disband', '解散');
      disband.type = 'button';
      disband.dataset.action = 'disband-squad';
      disband.dataset.squadId = String(composition.squad.id);
      head.append(disband);
    }
    card.append(head);

    // 活动行:当前进驻的地图/副本(或休整);数值只读自内容表,安排在「日程」页
    const activeMap = squadLevelingMap(composition.squad);
    const activeDungeon = squadDungeon(composition.squad);
    const activity = el(
      'div',
      `squad-activity${activeMap || activeDungeon ? ' squad-activity-on' : ''}`,
    );
    if (activeMap !== undefined) {
      activity.append(el('span', 'squad-activity-text', `练级中:${activeMap.name}(${activeMap.tier}区)`));
      activity.append(
        el('span', 'squad-activity-sub', `经验 ${activeMap.xpPerDay}/日 · 疲劳 +${activeMap.fatiguePerDay}/日 · 阵亡率 ${Math.round(activeMap.deathChancePerDay * 100)}%`),
      );
    } else if (activeDungeon !== undefined) {
      activity.append(el('span', 'squad-activity-text', `下本中:${activeDungeon.name}(${activeDungeon.tier}档)`));
      activity.append(
        el('span', 'squad-activity-sub', `每日 ${activeDungeon.runsPerDay} 次 · 难度 ${activeDungeon.difficultyTarget} · 掉落装等 ${activeDungeon.dropItemLevel} 档`),
      );
    } else {
      activity.append(el('span', 'squad-activity-text squad-activity-idle', '待命休整 · 疲劳自然恢复'));
    }
    card.append(activity);

    // 职能结构:计数 + 缺口实时标示(验收标准 1)
    const roles = el('div', 'squad-roles');
    roles.append(el('span', 'role-count', `坦克 ${composition.roleCounts['坦克']}`));
    roles.append(el('span', 'role-count', `治疗 ${composition.roleCounts['治疗']}`));
    roles.append(el('span', 'role-count', `输出 ${composition.roleCounts['输出']}`));
    if (composition.gaps.length > 0) {
      for (const gap of composition.gaps) {
        const badge = el(
          'span',
          `gap-badge gap-${gap.kind === '满员' ? 'fill' : 'role'}`,
          gap.kind === '满员' ? `缺 ${gap.missing} 人` : `缺${gap.kind}×${gap.missing}`,
        );
        roles.append(badge);
      }
    } else {
      roles.append(el('span', 'gap-ok', '职能齐整'));
    }
    card.append(roles);

    // 光环面板:每种生效光环可见(验收标准 2)
    if (composition.auras.length > 0) {
      const auraWrap = el('div', 'squad-auras');
      for (const aura of composition.auras) {
        const chip = el('span', 'aura-chip', `${aura.def.name}·${aura.def.stat}+${aura.def.percent}%`);
        chip.title = `${aura.def.description}\n提供者:${aura.providers.join('、')}`;
        auraWrap.append(chip);
      }
      card.append(auraWrap);
      const preview = el('div', 'aura-preview');
      preview.append(el('span', 'aura-preview-label', '加成预览'));
      for (const stat of ['伤害', '生存', '治疗'] as const) {
        preview.append(el('span', `aura-stat${composition.auraBonus[stat] > 0 ? '' : ' aura-stat-zero'}`, `${stat}+${composition.auraBonus[stat]}%`));
      }
      card.append(preview);
    } else {
      card.append(el('div', 'aura-empty', '队内暂无职业光环 —— 编入不同职业即可点亮。'));
    }

    // 成员行:名字 + 职业·专精·职能 + 调离
    const list = el('ul', 'squad-members');
    if (composition.members.length === 0) {
      list.append(el('li', 'empty-hint', '空小队 —— 从下方待命团员编入。'));
    }
    for (const member of composition.members) {
      const cls = CLASS_BY_ID.get(member.classId);
      const spec = cls?.specs.find((s) => s.id === member.specId);
      const row = el('li', 'squad-member');
      const info = el('span', 'squad-member-info');
      const nameSpan = el('span', 'member-name', member.name);
      if (member.isChairman) {
        nameSpan.append(el('span', 'chairman-badge', '会长'));
      }
      info.append(nameSpan);
      info.append(el('span', 'squad-member-class', `${cls?.name ?? '?'} · ${spec?.name ?? '?'} · ${spec?.role ?? '?'}`));
      const remove = el('button', 'squad-remove', '调离');
      remove.type = 'button';
      remove.dataset.action = 'remove-member';
      remove.dataset.memberId = String(member.id);
      row.append(info, remove);
      list.append(row);
    }
    card.append(list);
    return card;
  }

  /** 日程页渲染:结果卡 + 练级地图一览 + 小队分配 + 5 人本一览与下本分配(规则一律在 sim)。 */
  function renderSchedule(state: GameState): void {
    levelingAvgEl.textContent = `公会平均等级 ${guildAverageLevel(state.members)}`;
    renderDungeonReport(state.lastDungeonRun);

    // 地图卡:收益/损耗差异明确标示,未解锁地图给出门槛(数值只读自内容表)
    const statuses = levelingMapStatuses(state.members);
    mapListEl.replaceChildren(
      ...statuses.map(({ def, unlocked }) => {
        const card = el('li', `map-card${unlocked ? '' : ' map-locked'}`);
        const head = el('div', 'map-head');
        head.append(el('span', 'map-name', def.name));
        head.append(
          el('span', `map-tier map-tier-${def.tier === '高效' ? 'intensive' : 'relaxed'}`, `${def.tier}区`),
        );
        card.append(head);
        card.append(el('p', 'map-desc', def.description));
        card.append(
          el(
            'div',
            'map-stats',
            `经验 ${def.xpPerDay}/日 · 疲劳 +${def.fatiguePerDay}/日 · 阵亡率 ${Math.round(def.deathChancePerDay * 100)}%`,
          ),
        );
        if (!unlocked) {
          card.append(el('div', 'map-lock', `未解锁 —— 需公会平均等级 ${def.unlockAverageLevel}(当前 ${guildAverageLevel(state.members)})`));
        }
        return card;
      }),
    );

    // 小队分配行:选择已解锁地图进驻,或停止练级回城休整
    if (state.squads.length === 0) {
      assignListEl.replaceChildren(
        el('li', 'empty-hint', '还没有小队 —— 一切活动的出勤以小队为原子,先去「编成」页建队。'),
      );
    } else {
      const unlocked = statuses.filter((status) => status.unlocked);
      assignListEl.replaceChildren(
        ...state.squads.map((squad, index) => {
          const current = squadLevelingMap(squad);
          const row = el('li', 'assign-row');
          row.dataset.squadId = String(squad.id);

          const info = el('div', 'assign-info');
          info.append(el('span', 'assign-name', `第 ${index + 1} 小队(${squad.memberIds.length}/${COMP.squadSize})`));
          info.append(
            el(
              'span',
              `assign-status${current !== undefined ? ' assign-status-active' : ''}`,
              current !== undefined ? `练级中:${current.name}(${current.tier}区)` : '休整中 · 疲劳自然恢复',
            ),
          );
          row.append(info);

          if (unlocked.length > 0) {
            const select = el('select', 'assign-select') as HTMLSelectElement;
            for (const { def } of unlocked) {
              const option = el('option', undefined, `${def.name}(${def.tier}区)`) as HTMLOptionElement;
              option.value = def.id;
              if (current?.id === def.id) {
                option.selected = true;
              }
              select.append(option);
            }
            const go = el('button', 'pool-btn pool-btn-recruit', '前往练级');
            go.type = 'button';
            go.dataset.action = 'assign-leveling';
            row.append(select, go);
          }
          if (current !== undefined) {
            const stop = el('button', 'pool-btn pool-btn-reject', '停止练级');
            stop.type = 'button';
            stop.dataset.action = 'stop-leveling';
            row.append(stop);
          }
          return row;
        }),
      );
    }

    // 5 人本一览:难度/掉落档位标示,未解锁给出门槛(数值只读自内容表)
    const dungeonStates = dungeonStatuses(state.members);
    dungeonListEl.replaceChildren(
      ...dungeonStates.map(({ def, unlocked }) => {
        const card = el('li', `map-card dungeon-card${unlocked ? '' : ' map-locked'}`);
        const head = el('div', 'map-head');
        head.append(el('span', 'map-name', def.name));
        head.append(el('span', 'map-tier map-tier-dungeon', `${def.tier}档`));
        card.append(head);
        card.append(el('p', 'map-desc', def.description));
        card.append(
          el(
            'div',
            'map-stats',
            `难度 ${def.difficultyTarget} · 每日 ${def.runsPerDay} 次 · 掉落装等 ${def.dropItemLevel} 档 · 疲劳 +${def.fatiguePerRun}/次`,
          ),
        );
        if (!unlocked) {
          card.append(
            el(
              'div',
              'map-lock',
              `未解锁 —— 需公会平均等级 ${def.unlockAverageLevel}(当前 ${guildAverageLevel(state.members)})`,
            ),
          );
        }
        return card;
      }),
    );

    // 下本分配行:选择已解锁副本进驻,或停止下本回城休整
    // (满职能与否只是展示性提示,裁决在门面)
    if (state.squads.length === 0) {
      dungeonAssignListEl.replaceChildren(
        el('li', 'empty-hint', '还没有小队 —— 满职能小队(5 人 + 1 坦 1 奶)才能下本,先去「编成」页建队。'),
      );
      return;
    }
    const unlockedDungeons = dungeonStates.filter((status) => status.unlocked);
    dungeonAssignListEl.replaceChildren(
      ...state.squads.map((squad, index) => {
        const current = squadDungeon(squad);
        const readiness = squadDungeonReadiness(squad, state.members);
        const row = el('li', 'assign-row');
        row.dataset.squadId = String(squad.id);

        const info = el('div', 'assign-info');
        info.append(el('span', 'assign-name', `第 ${index + 1} 小队(${squad.memberIds.length}/${COMP.squadSize})`));
        if (current !== undefined) {
          info.append(
            el('span', 'assign-status assign-status-active', `下本中:${current.name}(${current.tier}档)`),
          );
        } else if (!readiness.ready) {
          info.append(el('span', 'assign-status assign-status-blocked', `编成不齐:${readiness.reasons.join('、')}`));
        } else {
          info.append(el('span', 'assign-status', '休整中 · 可随时进本'));
        }
        row.append(info);

        if (unlockedDungeons.length > 0) {
          const select = el('select', 'assign-select') as HTMLSelectElement;
          for (const { def } of unlockedDungeons) {
            const option = el('option', undefined, `${def.name}(${def.tier}档)`) as HTMLOptionElement;
            option.value = def.id;
            if (current?.id === def.id) {
              option.selected = true;
            }
            select.append(option);
          }
          const go = el('button', 'pool-btn pool-btn-recruit', '前往下本');
          go.type = 'button';
          go.dataset.action = 'assign-dungeon';
          if (!readiness.ready) {
            go.disabled = true; // 展示性禁用:真实裁决仍在门面
            go.title = `编成不齐:${readiness.reasons.join('、')}`;
          }
          row.append(select, go);
        }
        if (current !== undefined) {
          const stop = el('button', 'pool-btn pool-btn-reject', '停止下本');
          stop.type = 'button';
          stop.dataset.action = 'stop-dungeon';
          row.append(stop);
        }
        return row;
      }),
    );
  }

  /** 结果卡:最近一次下本的成败、三要素与掉落去向(数据来自状态,规则都在 sim)。 */
  function renderDungeonReport(report: DungeonRunReport | undefined): void {
    if (report === undefined) {
      dungeonReportWrapEl.hidden = true;
      return;
    }
    dungeonReportWrapEl.hidden = false;

    const card = el('div', `dungeon-report-card${report.success ? ' report-win' : ' report-fail'}`);
    const head = el('div', 'report-head');
    head.append(el('span', 'report-title', `「${report.dungeonName}」· 第 ${report.squadOrdinal} 小队`));
    head.append(el('span', 'report-stamp', formatGameStamp(report.atGameMinutes)));
    card.append(head);

    const banner = el('div', 'report-banner');
    banner.append(el('span', 'report-verdict', report.success ? '速通' : '败退'));
    banner.append(
      el(
        'span',
        'report-odds',
        `战力 ${Math.round(report.power)} 对难度 ${report.target} · 胜率 ${Math.round(report.successChance * 100)}%(${report.band})`,
      ),
    );
    card.append(banner);

    const lineup = el('ul', 'report-lineup');
    for (const member of report.members) {
      const li = el('li', 'report-member');
      li.append(el('span', 'member-name', member.name));
      li.append(el('span', 'report-member-role', member.role));
      li.append(el('span', 'report-member-ilvl', `装等${member.itemLevel}`));
      lineup.append(li);
    }
    card.append(lineup);

    const drops = el('ul', 'report-drops');
    if (report.drops.length === 0) {
      drops.append(el('li', 'report-drop report-drop-none', '无掉落。'));
    }
    for (const drop of report.drops) {
      const li = el('li', 'report-drop');
      li.append(el('span', `gear-quality ${QUALITY_CLASS[drop.quality]}`, drop.quality));
      li.append(el('span', 'report-drop-item', `${drop.slot} · 装等 ${drop.itemLevel}`));
      li.append(
        el(
          'span',
          `report-drop-dest${drop.equipped ? ' report-drop-up' : ''}`,
          drop.equipped ? `${drop.assignedTo}(+${drop.upgradeDelta})` : '无人可提升,已分解',
        ),
      );
      drops.append(li);
    }
    card.append(el('div', 'report-drops-title', '战利品'));
    card.append(drops);

    dungeonReportEl.replaceChildren(card);
  }

  /** 待命团员行:选择目标小队并编入(满员禁用是展示行为,裁决在门面)。 */
  function renderBenchRow(member: Member, squads: readonly { id: number; memberIds: readonly number[] }[]): HTMLLIElement {
    const cls = CLASS_BY_ID.get(member.classId);
    const spec = cls?.specs.find((s) => s.id === member.specId);

    const row = el('li', 'bench-row');
    row.dataset.memberId = String(member.id);
    const info = el('div', 'bench-info');
    const nameSpan = el('span', 'member-name', member.name);
    if (member.isChairman) {
      nameSpan.append(el('span', 'chairman-badge', '会长'));
    }
    info.append(nameSpan);
    info.append(el('span', 'bench-class', `${cls?.name ?? '?'} · ${spec?.name ?? '?'} · ${spec?.role ?? '?'}`));
    row.append(info);

    if (squads.length > 0) {
      const select = el('select', 'bench-select') as HTMLSelectElement;
      let selectedSet = false;
      for (const squad of squads) {
        const full = squad.memberIds.length >= COMP.squadSize;
        const option = el('option', undefined, `第 ${squads.indexOf(squad) + 1} 小队${full ? '(已满)' : ''}`) as HTMLOptionElement;
        option.value = String(squad.id);
        option.disabled = full;
        if (!full && !selectedSet) {
          option.selected = true;
          selectedSet = true;
        }
        select.append(option);
      }
      const assign = el('button', 'pool-btn pool-btn-recruit', '编入');
      assign.type = 'button';
      assign.dataset.action = 'assign';
      row.append(select, assign);
      syncAssignEnabled(row, assign);
    }
    return row;
  }

  /** 按行内选择框当前目标小队是否满员,同步「编入」按钮的展示性禁用。 */
  function syncAssignEnabled(row: HTMLElement, button: HTMLButtonElement): void {
    const select = row.querySelector<HTMLSelectElement>('select');
    const squad = select === null ? undefined : latestState?.squads.find((s) => s.id === Number(select.value));
    const disabled = squad === undefined || squad.memberIds.length >= COMP.squadSize;
    button.disabled = disabled;
    button.title = disabled ? '目标小队已满' : '';
  }

  /** 名册列表:职业 / 等级 / 装等摘要(验收标准 1)。 */
  function renderRosterList(members: readonly Member[]): void {
    if (members.length === 0) {
      rosterListEl.replaceChildren(
        el('li', 'empty-hint', '名册空空如也 —— 会长角色不可淘汰。'),
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
        // 经验进度摘要:练级成长在名册列表即可观察(比例为纯展示换算)
        const xpPercent =
          member.level >= LEVELING.maxLevel
            ? '满'
            : `${Math.floor((member.experience / xpToNextLevel(member.level)) * 100)}%`;
        const summary = el('span', 'row-summary', `Lv${member.level} · 经验${xpPercent} · 装等${averageItemLevel(member)}`);
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

    const topRow = el('div', 'detail-top');
    const back = el('button', 'detail-back', '← 返回名册');
    back.type = 'button';
    back.dataset.action = 'back';
    topRow.append(back);

    // 淘汰入口:仅普通团员显示(会长角色不可淘汰,规则在门面)
    if (!member.isChairman) {
      const dismiss = el('button', 'detail-dismiss', '淘汰出会');
      dismiss.type = 'button';
      dismiss.dataset.action = 'dismiss';
      dismiss.dataset.memberId = String(member.id);
      topRow.append(dismiss);
    }
    frag.append(topRow);

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

    // 经验进度:升级所需经验读自 sim 派生公式(纯展示,不做规则)
    if (member.level >= LEVELING.maxLevel) {
      const maxed = el('div', 'detail-block detail-maxed', `已达等级上限(${LEVELING.maxLevel} 级),经验封顶。`);
      frag.append(maxed);
    } else {
      frag.append(xpBar('经验', member.experience, xpToNextLevel(member.level)));
    }

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

  /** 经验进度条:当前经验 / 升级所需经验(比例是纯展示换算)。 */
  function xpBar(label: string, value: number, required: number): HTMLElement {
    const row = el('div', 'vital-row');
    row.append(el('span', 'vital-label', label));
    const track = el('div', 'vital-track');
    const fill = el('div', 'vital-fill');
    fill.style.width = `${clampPercent(Math.floor((value / required) * 100))}%`;
    track.append(fill);
    row.append(track, el('span', 'vital-value vital-value-wide', `${value}/${required}`));
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
