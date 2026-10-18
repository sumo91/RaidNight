import { ATTENDANCE_BY_ID } from '../content/attendance';
import { COMP } from '../content/comp';
import { CLASS_BY_ID } from '../content/classes';
import {
  LOOT_SYSTEMS,
  LOOT_SYSTEM_BY_ID,
  VAULT,
  type LootSystemId,
} from '../content/economy';
import type { Quality } from '../content/gear';
import { LEVELING } from '../content/maps';
import { RAID_BY_ID, RAID_SETTLEMENT } from '../content/raids';
import { RENOWN_RUNG_COUNT, RENOWN_TIERS } from '../content/reputation';
import { SKILL_TIER_BY_ID } from '../content/skill-tiers';
import { TRAIT_BY_ID } from '../content/traits';
import { RIVAL_GUILD_BY_NAME, WORLD } from '../content/world';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK, gameMinutesToRealMs } from '../sim/clock';
import type { SimInput } from '../sim/facade';
import type { SimEvent } from '../sim/events';
import { squadCompositions, teamCheck, unassignedMembers } from '../sim/comp';
import { dungeonStatuses, squadDungeon, squadDungeonReadiness } from '../sim/dungeon';
import { externalActivityStatuses, squadExternalActivity } from '../sim/economy';
import { levelingMapStatuses, squadLevelingMap, xpToNextLevel } from '../sim/leveling';
import { raidStatuses } from '../sim/raid';
import {
  hallDeedsLine,
  renownLabel,
  renownRung,
  renownStanding,
  rosterCapForRung,
  rungThreshold,
} from '../sim/reputation';
import { averageItemLevel, guildAverageItemLevel, guildAverageLevel } from '../sim/roster';
import { activityQueue, nextRaidNight, nextSettlement } from '../sim/schedule';
import { serverLadder, serverRanking } from '../sim/world';
import type {
  DungeonRunReport,
  GameState,
  Member,
  RaidBossOutcome,
  RaidNightReport,
} from '../sim/state';
import { formatGameClock, formatGameDuration, formatGameStamp, formatRealDuration } from './format';

/**
 * 薄渲染层:只读状态、派发输入,不含任何业务规则。
 * 一切规则(校验、结算、时间推进、派生数值)都在 sim 门面内;
 * 这里只做「状态 → DOM」的映射与纯展示行为(页签/选中)。
 * 倒计时的「现实还需多久」用 sim/clock 的换算函数(常量同源),仅作展示。
 */

/** 离线归来摘要:装配层由离线补结算的事件流统计而来,UI 只渲染不统计。 */
export interface OfflineHarvestView {
  /** 离线了多久(现实时长文案,如「2.1天」) */
  readonly awayText: string;
  /** 离线期间推进的游戏时长文案(如「2游戏周」) */
  readonly advancedText: string;
  /** 离线起止的游戏历时间戳(如「第2周周五 03:17 → 第4周周五 03:17」)的两端 */
  readonly fromStamp: string;
  readonly toStamp: string;
  /** 期间补记的事件总数 */
  readonly eventCount: number;
  /** 关键结果统计文案(速通次数/掉落穿戴数等,装配层拼好) */
  readonly highlights: readonly string[];
}

export interface AppHandle {
  /** 用新状态重渲染;newEvents 追加进滚动日志缓冲。 */
  render(state: GameState, newEvents: readonly SimEvent[]): void;
  /** 清空滚动日志缓冲(导入存档恢复另一进度时调用;事件日志不在存档内)。 */
  clearFeed(): void;
  /** 展示离线归来摘要卡(传 null 收起);数据由装配层统计。 */
  showOfflineHarvest(view: OfflineHarvestView | null): void;
}

export interface MountOptions {
  /** 把门面输入(指令/时间增量)交给装配层转发给门面。 */
  dispatch: (input: SimInput) => void;
  /** 清空本地存档并重开(装配层拥有持久化;UI 不关心存储介质)。 */
  wipeSave?: () => void;
  /** 导出存档文件(装配层负责编码与下载;UI 只触发)。 */
  exportSave?: () => void;
  /** 导入存档文本,返回是否恢复成功(解码/迁移规则一律在 sim,UI 不做校验)。 */
  importSave?: (text: string) => boolean;
  /** 模拟离线(调试条):把一段现实时长交给装配层做离线补结算。 */
  simulateOffline?: (realMs: number) => void;
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
      <div class="save-row">
        <span class="save-hint">进度自动保存在本机</span>
        <button type="button" class="save-btn" data-action="export-save">导出存档</button>
        <button type="button" class="save-btn" data-action="import-save">导入存档</button>
      </div>
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
        <div class="raid-open" data-ref="raid-open"></div>
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
        <div class="offline-harvest" data-ref="offline-harvest" hidden></div>
        <div class="raid-night">
          <div class="pool-head">
            <h2 class="section-title">团本夜</h2>
            <span class="pool-sub" data-ref="raid-night-sub"></span>
          </div>
          <div class="raid-plan" data-ref="raid-plan"></div>
          <div class="raid-live-wrap" data-ref="raid-live-wrap" hidden></div>
        </div>
        <div class="settlement-panel">
          <div class="settlement-head">
            <h2 class="section-title">下一场结算</h2>
            <span class="settlement-tag" data-ref="settlement-tag"></span>
          </div>
          <div class="settlement-countdown" data-ref="settlement-countdown"></div>
          <div class="settlement-dual" data-ref="settlement-dual"></div>
        </div>
        <div class="queue-panel">
          <div class="pool-head">
            <h2 class="section-title">活动队列</h2>
            <span class="pool-sub" data-ref="queue-sub"></span>
          </div>
          <ul class="queue-list" data-ref="queue-list"></ul>
        </div>
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
        <div class="leveling-head dungeon-head">
          <h2 class="section-title">外快(个人金)</h2>
        </div>
        <p class="leveling-note">满职能小队出坞打工/跑野团,收入归团员个人金 —— GKP 制下团本出价的底气。制度与钱包见「金库·荣誉」页。</p>
        <ul class="map-list external-list" data-ref="external-list"></ul>
        <div class="pool-head assign-head">
          <h2 class="section-title">外快分配</h2>
        </div>
        <ul class="assign-list external-assign-list" data-ref="external-assign-list"></ul>
      </section>
      <section class="pane" data-pane="world" hidden>
        <div class="world-overview" data-ref="world-overview"></div>
        <div class="market-banner" data-ref="market-banner" hidden></div>
        <div class="world-section">
          <div class="pool-head">
            <h2 class="section-title">服务器首杀榜</h2>
            <span class="pool-sub" data-ref="first-kill-sub"></span>
          </div>
          <ul class="first-kill-list" data-ref="first-kill-list"></ul>
        </div>
        <div class="world-section">
          <div class="pool-head">
            <h2 class="section-title">竞争公会</h2>
            <span class="pool-sub">有成长曲线的高层公会 —— 橡皮筋约束:你推进时他们慢半拍</span>
          </div>
          <ul class="rival-list" data-ref="rival-list"></ul>
        </div>
        <div class="world-section">
          <div class="pool-head">
            <h2 class="section-title">服务器排名</h2>
            <span class="pool-sub" data-ref="ranking-sub"></span>
          </div>
          <ul class="ranking-list" data-ref="ranking-list"></ul>
        </div>
        <div class="world-section">
          <div class="pool-head">
            <h2 class="section-title">全服新闻</h2>
            <span class="pool-sub" data-ref="news-sub"></span>
          </div>
          <ul class="world-news-list" data-ref="world-news-list"></ul>
        </div>
      </section>
      <section class="pane" data-pane="vault" hidden>
        <div class="vault-balance" data-ref="vault-balance"></div>
        <div class="loot-system-panel">
          <div class="pool-head">
            <h2 class="section-title">分配制度</h2>
            <span class="pool-sub">公会团装备归属,三选一、可更换有转换成本</span>
          </div>
          <ul class="loot-system-list" data-ref="loot-system-list"></ul>
        </div>
        <div class="self-deal-panel" data-ref="self-deal-panel" hidden></div>
        <div class="wallet-panel">
          <div class="pool-head">
            <h2 class="section-title">团员钱包</h2>
            <span class="pool-sub" data-ref="wallet-sub"></span>
          </div>
          <ul class="wallet-list" data-ref="wallet-list"></ul>
        </div>
        <div class="renown-panel" data-ref="renown-card"></div>
        <div class="honor-panel">
          <div class="pool-head">
            <h2 class="section-title">荣誉墙</h2>
            <span class="pool-sub" data-ref="honor-sub"></span>
          </div>
          <div class="honor-wall" data-ref="honor-wall"></div>
        </div>
        <div class="hall-panel">
          <div class="pool-head">
            <h2 class="section-title">名人堂</h2>
            <span class="pool-sub" data-ref="hall-sub"></span>
          </div>
          <ul class="hall-list" data-ref="hall-list"></ul>
        </div>
      </section>
    </main>
    <section class="event-panel">
      <h2 class="panel-title">事件日志</h2>
      <ul class="event-feed" data-ref="event-feed">
        <li class="feed-empty">暂无事件 —— 游戏时间推进后会在这里出现日更与周更。</li>
      </ul>
    </section>
    <p class="save-toast" data-ref="save-toast" hidden></p>
    <div class="dev-strip">
      <span class="dev-label">调试</span>
      <button type="button" data-dev="day">+1 游戏日</button>
      <button type="button" data-dev="week">+1 游戏周</button>
      <button type="button" data-dev="offline">模拟离线</button>
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
  const saveToastEl = requireElement<HTMLParagraphElement>(root, 'save-toast');
  const feedEl = requireElement<HTMLUListElement>(root, 'event-feed');
  const rosterBrowseEl = requireElement<HTMLDivElement>(root, 'roster-browse');
  const rosterListEl = requireElement<HTMLUListElement>(root, 'roster-list');
  const memberDetailEl = requireElement<HTMLDivElement>(root, 'member-detail');
  const poolSubEl = requireElement<HTMLSpanElement>(root, 'pool-sub');
  const poolFullHintEl = requireElement<HTMLParagraphElement>(root, 'pool-full-hint');
  const poolListEl = requireElement<HTMLUListElement>(root, 'pool-list');
  const teamCheckEl = requireElement<HTMLDivElement>(root, 'team-check');
  const raidOpenEl = requireElement<HTMLDivElement>(root, 'raid-open');
  const raidNightSubEl = requireElement<HTMLSpanElement>(root, 'raid-night-sub');
  const raidPlanEl = requireElement<HTMLDivElement>(root, 'raid-plan');
  const raidLiveWrapEl = requireElement<HTMLDivElement>(root, 'raid-live-wrap');
  const squadCapEl = requireElement<HTMLSpanElement>(root, 'squad-cap');
  const squadListEl = requireElement<HTMLUListElement>(root, 'squad-list');
  const benchSubEl = requireElement<HTMLSpanElement>(root, 'bench-sub');
  const benchListEl = requireElement<HTMLUListElement>(root, 'bench-list');
  const levelingAvgEl = requireElement<HTMLSpanElement>(root, 'leveling-avg');
  const mapListEl = requireElement<HTMLUListElement>(root, 'map-list');
  const assignListEl = requireElement<HTMLUListElement>(root, 'assign-list');
  const offlineHarvestEl = requireElement<HTMLDivElement>(root, 'offline-harvest');
  const settlementTagEl = requireElement<HTMLSpanElement>(root, 'settlement-tag');
  const settlementCountdownEl = requireElement<HTMLDivElement>(root, 'settlement-countdown');
  const settlementDualEl = requireElement<HTMLDivElement>(root, 'settlement-dual');
  const queueSubEl = requireElement<HTMLSpanElement>(root, 'queue-sub');
  const queueListEl = requireElement<HTMLUListElement>(root, 'queue-list');
  const dungeonReportWrapEl = requireElement<HTMLDivElement>(root, 'dungeon-report-wrap');
  const dungeonReportEl = requireElement<HTMLDivElement>(root, 'dungeon-report');
  const dungeonListEl = requireElement<HTMLUListElement>(root, 'dungeon-list');
  const dungeonAssignListEl = requireElement<HTMLUListElement>(root, 'dungeon-assign-list');
  const externalListEl = requireElement<HTMLUListElement>(root, 'external-list');
  const externalAssignListEl = requireElement<HTMLUListElement>(root, 'external-assign-list');
  const vaultBalanceEl = requireElement<HTMLDivElement>(root, 'vault-balance');
  const lootSystemListEl = requireElement<HTMLUListElement>(root, 'loot-system-list');
  const selfDealPanelEl = requireElement<HTMLDivElement>(root, 'self-deal-panel');
  const walletSubEl = requireElement<HTMLSpanElement>(root, 'wallet-sub');
  const walletListEl = requireElement<HTMLUListElement>(root, 'wallet-list');
  const renownCardEl = requireElement<HTMLDivElement>(root, 'renown-card');
  const honorSubEl = requireElement<HTMLSpanElement>(root, 'honor-sub');
  const honorWallEl = requireElement<HTMLDivElement>(root, 'honor-wall');
  const hallSubEl = requireElement<HTMLSpanElement>(root, 'hall-sub');
  const hallListEl = requireElement<HTMLUListElement>(root, 'hall-list');
  const worldOverviewEl = requireElement<HTMLDivElement>(root, 'world-overview');
  const marketBannerEl = requireElement<HTMLDivElement>(root, 'market-banner');
  const firstKillSubEl = requireElement<HTMLSpanElement>(root, 'first-kill-sub');
  const firstKillListEl = requireElement<HTMLUListElement>(root, 'first-kill-list');
  const rivalListEl = requireElement<HTMLUListElement>(root, 'rival-list');
  const rankingSubEl = requireElement<HTMLSpanElement>(root, 'ranking-sub');
  const rankingListEl = requireElement<HTMLUListElement>(root, 'ranking-list');
  const newsSubEl = requireElement<HTMLSpanElement>(root, 'news-sub');
  const worldNewsListEl = requireElement<HTMLUListElement>(root, 'world-news-list');

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
  // 模拟离线(调试):输入现实小时数,交装配层走真实离线补结算路径(输入采集是纯 UI 行为)
  const devOffline = root.querySelector<HTMLButtonElement>('[data-dev="offline"]');
  devOffline?.addEventListener('click', () => {
    const answer = window.prompt('模拟离线多久?(现实小时数,如 12、72):');
    if (answer === null) {
      return;
    }
    const hours = Number(answer);
    if (!Number.isFinite(hours) || hours <= 0) {
      showSaveToast('模拟离线需要一个正的小时数。', false);
      return;
    }
    options.simulateOffline?.(hours * 3_600_000);
  });
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

  // 存档操作:导出/导入都是装配层的事(编码、下载、解码、迁移、恢复);
  // UI 只做触发、文件选择与结果提示 —— 不含任何存档规则
  root.querySelector<HTMLButtonElement>('[data-action="export-save"]')?.addEventListener('click', () => {
    options.exportSave?.();
    showSaveToast('存档已导出为文件。', true);
  });
  root.querySelector<HTMLButtonElement>('[data-action="import-save"]')?.addEventListener('click', () => {
    if (!window.confirm('导入存档将覆盖当前进度,确定继续?')) {
      return;
    }
    // 文件选择与读取是纯输入采集;文本交给装配层 → sim 解码迁移
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file === undefined) {
        return;
      }
      void file.text().then((text) => {
        const ok = options.importSave?.(text) ?? false;
        showSaveToast(ok ? '存档导入成功,进度已恢复。' : '导入失败:不是有效的存档文件。', ok);
      });
    };
    input.click();
  });

  /** 存档操作结果提示(纯展示;自动消退)。 */
  let toastTimer: number | undefined;
  function showSaveToast(text: string, ok: boolean): void {
    saveToastEl.textContent = text;
    saveToastEl.classList.toggle('save-toast-fail', !ok);
    saveToastEl.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      saveToastEl.hidden = true;
    }, 2600);
  }

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

  // 外快分配操作(日程页):只是把「出坞打工/跑野团/停止」转交给门面裁决
  // (解锁与满职能校验一律在 sim;此处不禁用、不做规则判断)
  externalAssignListEl.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
    if (button === null || button.disabled) {
      return;
    }
    const row = button.closest<HTMLElement>('[data-squad-id]');
    if (row === null) {
      return;
    }
    const squadId = Number(row.dataset.squadId);
    if (button.dataset.action === 'stop-external') {
      const stop = button.dataset.activity === 'carry' ? 'stopCarry' : 'stopWildRaid';
      options.dispatch({
        command: { type: stop, squadId } as { type: 'stopCarry' | 'stopWildRaid'; squadId: number },
        deltaGameMinutes: 0,
      });
      return;
    }
    if (button.dataset.action === 'assign-external') {
      const select = row.querySelector<HTMLSelectElement>('select');
      if (select === null || select.value === '') {
        return;
      }
      const command = {
        type: (select.value === 'carry' ? 'assignCarry' : 'assignWildRaid') as 'assignCarry' | 'assignWildRaid',
        squadId,
      };
      options.dispatch({ command, deltaGameMinutes: 0 });
    }
  });

  // 金库·荣誉页操作(换制/自肥):转交门面裁决 —— 成本校验与忠诚摩擦都在 sim;
  // 确认弹窗是纯展示行为,「金库不足」的禁用也只是展示(门面仍做最终裁决)
  lootSystemListEl.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action="switch-loot-system"]');
    if (button === null || button.disabled) {
      return;
    }
    const def = LOOT_SYSTEM_BY_ID.get(button.dataset.system as LootSystemId);
    if (def === undefined) {
      return;
    }
    const cost =
      def.switchCostGold > 0 ? `立规支出 ${def.switchCostGold} 金(金库)、` : '';
    const extra = def.id === 'dkp' ? ',且全员 DKP 清零重记' : '';
    if (!window.confirm(`换用「${def.name}」?${cost}全员忠诚 −${def.switchLoyaltyHit}${extra}。`)) {
      return;
    }
    options.dispatch({ command: { type: 'setLootSystem', system: def.id }, deltaGameMinutes: 0 });
  });
  selfDealPanelEl.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action="toggle-self-deal"]');
    if (button === null || button.disabled) {
      return;
    }
    const enabled = button.dataset.enabled === 'true';
    const def = LOOT_SYSTEM_BY_ID.get('chairman')!;
    if (
      enabled &&
      !window.confirm(
        `开启自肥?团本掉落将优先装进会长角色 —— 每件自肥,出席团员忠诚 −${def.selfDealLoyaltyCost}、声望 −${def.selfDealReputationCost},代价逐件累积。`,
      )
    ) {
      return;
    }
    options.dispatch({ command: { type: 'setSelfDealing', enabled }, deltaGameMinutes: 0 });
  });

  // 开团操作(编成页):转交门面裁决 —— 内容门槛/团队检查的最终裁决都在 sim,
  // 此处只做展示性禁用与提示
  raidOpenEl.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
    if (button === null || button.disabled) {
      return;
    }
    if (button.dataset.action === 'open-raid' && button.dataset.raidId !== undefined) {
      options.dispatch({ command: { type: 'openRaid', raidId: button.dataset.raidId }, deltaGameMinutes: 0 });
    } else if (button.dataset.action === 'cancel-raid') {
      options.dispatch({ command: { type: 'cancelRaid' }, deltaGameMinutes: 0 });
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

  /** 清空滚动日志缓冲,恢复「暂无事件」占位(导入存档恢复另一进度时调用)。 */
  function clearFeed(): void {
    feed.length = 0;
    feedEl.replaceChildren(
      el('li', 'feed-empty', '暂无事件 —— 游戏时间推进后会在这里出现日更与周更。'),
    );
  }

  function render(state: GameState, newEvents: readonly SimEvent[]): void {
    latestState = state;
    guildNameEl.textContent = state.guild.name;
    memberCountEl.textContent = `在册 ${state.members.length}/${state.rosterCap} 人`;
    gameClockEl.textContent = formatGameClock(state.clockGameMinutes);
    renderPool(state);
    renderRoster();
    renderSquads(state);
    renderSchedule(state);
    renderVault(state);
    renderWorld(state);

    if (newEvents.length > 0) {
      // 逐条入缓冲:超长离线补结算的一次性事件可达数万条,展开传参会爆调用栈
      for (const event of newEvents) {
        feed.push(event);
      }
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
    poolSubEl.textContent = `${state.applicants.length} 份申请 · 声望:${renownLabel(
      renownRung(state.renownPoints),
    )} · 每游戏日刷新`;
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

    // 团本开团面板(T10):团队检查的裁决结果直接决定开团可用性
    renderRaidOpen(state);

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

    // 活动行:当前进驻的地图/副本/外快(或休整);数值只读自内容表,安排在「日程」页
    const activeMap = squadLevelingMap(composition.squad);
    const activeDungeon = squadDungeon(composition.squad);
    const activeExternal = squadExternalActivity(composition.squad);
    const activity = el(
      'div',
      `squad-activity${activeMap || activeDungeon || activeExternal ? ' squad-activity-on' : ''}`,
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
    } else if (activeExternal !== undefined) {
      activity.append(el('span', 'squad-activity-text', `外快中:${activeExternal.name}`));
      activity.append(
        el('span', 'squad-activity-sub', `每人每日 +${activeExternal.goldPerMemberPerDay} 金(个人金) · 疲劳 +${activeExternal.fatiguePerMemberPerDay}/日`),
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

  /** 日程页渲染:下一场倒计时 + 活动队列 + 结果卡 + 练级/下本一览与分配(规则一律在 sim)。 */
  function renderSchedule(state: GameState): void {
    const averageLevel = guildAverageLevel(state.members);
    const averageItemLevel = guildAverageItemLevel(state.members);
    levelingAvgEl.textContent = `公会平均等级 ${averageLevel} · 平均装等 ${averageItemLevel}`;
    renderCountdown(state);
    renderRaidNight(state);
    renderQueue(state);
    renderDungeonReport(state.lastDungeonRun);

    // 地图卡:等级带与收益/损耗差异明确标示,未解锁地图给出带下限门槛(数值只读自内容表)
    const statuses = levelingMapStatuses(state.members);
    mapListEl.replaceChildren(
      ...statuses.map(({ def, unlocked }) => {
        const card = el('li', `map-card${unlocked ? '' : ' map-locked'}`);
        const head = el('div', 'map-head');
        head.append(el('span', 'map-name', def.name));
        head.append(
          el('span', `map-tier map-tier-${def.tier === '高效' ? 'intensive' : 'relaxed'}`, `${def.tier}区`),
        );
        head.append(el('span', 'map-band', `Lv${def.levelBand.min}–${def.levelBand.max}`));
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
          card.append(
            el('div', 'map-lock', `未解锁 —— 需公会平均等级 ${def.levelBand.min}(当前 ${averageLevel})`),
          );
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

    // 5 人本一览:难度档与门槛标示,未解锁给出未达标项(判定与文案在 sim,此处只渲染)
    const dungeonStates = dungeonStatuses(state.members);
    dungeonListEl.replaceChildren(
      ...dungeonStates.map(({ def, unlocked, unmet }) => {
        const card = el('li', `map-card dungeon-card${unlocked ? '' : ' map-locked'}`);
        const head = el('div', 'map-head');
        head.append(el('span', 'map-name', def.name));
        head.append(el('span', 'map-tier map-tier-dungeon', `${def.tier}档`));
        head.append(
          el('span', 'map-band', `门槛 Lv≥${def.unlock.averageLevel} · 装等≥${def.unlock.averageItemLevel}`),
        );
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
              `未解锁 —— 需${unmet.join('、')}(当前 等级 ${averageLevel} · 装等 ${averageItemLevel})`,
            ),
          );
        }
        return card;
      }),
    );

    // 下本分配行:选择已解锁副本进驻,或停止下本回城休整
    // (满职能与否只是展示性提示,裁决在门面;无小队只给提示,不提前返回 —— 后面还有外快区)
    const unlockedDungeons = dungeonStates.filter((status) => status.unlocked);
    if (state.squads.length === 0) {
      dungeonAssignListEl.replaceChildren(
        el('li', 'empty-hint', '还没有小队 —— 满职能小队(5 人 + 1 坦 1 奶)才能下本,先去「编成」页建队。'),
      );
    } else {
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

    // 外快一览(打工/野团):门槛与收益标示,未解锁给出未达标项(判定在 sim,此处只渲染)
    const externalStates = externalActivityStatuses(state.members);
    externalListEl.replaceChildren(
      ...externalStates.map(({ def, unlocked, unmet }) => {
        const card = el('li', `map-card external-card${unlocked ? '' : ' map-locked'}`);
        const head = el('div', 'map-head');
        head.append(el('span', 'map-name', def.name));
        head.append(el('span', 'map-tier map-tier-external', '外快'));
        head.append(
          el('span', 'map-band', `门槛 Lv≥${def.unlock.averageLevel} · 装等≥${def.unlock.averageItemLevel}`),
        );
        card.append(head);
        card.append(el('p', 'map-desc', def.description));
        card.append(
          el(
            'div',
            'map-stats',
            `每人每日 +${def.goldPerMemberPerDay} 金(入个人金) · 疲劳 +${def.fatiguePerMemberPerDay}/日`,
          ),
        );
        if (!unlocked) {
          card.append(
            el(
              'div',
              'map-lock',
              `未解锁 —— 需${unmet.join('、')}(当前 等级 ${averageLevel} · 装等 ${averageItemLevel})`,
            ),
          );
        }
        return card;
      }),
    );

    // 外快分配行:选择已解锁活动出坞,或停止回城休整(满职能校验在门面)
    const unlockedExternal = externalStates.filter((status) => status.unlocked);
    if (state.squads.length === 0) {
      externalAssignListEl.replaceChildren(
        el('li', 'empty-hint', '还没有小队 —— 外快以小队为单位出坞,先去「编成」页建队。'),
      );
      return;
    }
    externalAssignListEl.replaceChildren(
      ...state.squads.map((squad, index) => {
        const current = squadExternalActivity(squad);
        const readiness = squadDungeonReadiness(squad, state.members);
        const row = el('li', 'assign-row');
        row.dataset.squadId = String(squad.id);

        const info = el('div', 'assign-info');
        info.append(el('span', 'assign-name', `第 ${index + 1} 小队(${squad.memberIds.length}/${COMP.squadSize})`));
        if (current !== undefined) {
          info.append(
            el('span', 'assign-status assign-status-active', `外快中:${current.name}(每人每日 +${current.goldPerMemberPerDay} 金)`),
          );
        } else if (!readiness.ready) {
          info.append(el('span', 'assign-status assign-status-blocked', `编成不齐:${readiness.reasons.join('、')}`));
        } else {
          info.append(el('span', 'assign-status', '休整中 · 可随时出坞'));
        }
        row.append(info);

        if (unlockedExternal.length > 0) {
          const select = el('select', 'assign-select') as HTMLSelectElement;
          for (const { def } of unlockedExternal) {
            const option = el('option', undefined, `${def.name}(+${def.goldPerMemberPerDay} 金/人·日)`) as HTMLOptionElement;
            option.value = def.id;
            if (current?.id === def.id) {
              option.selected = true;
            }
            select.append(option);
          }
          const go = el('button', 'pool-btn pool-btn-recruit', '出坞外快');
          go.type = 'button';
          go.dataset.action = 'assign-external';
          if (!readiness.ready) {
            go.disabled = true; // 展示性禁用:真实裁决仍在门面
            go.title = `编成不齐:${readiness.reasons.join('、')}`;
          }
          row.append(select, go);
        }
        if (current !== undefined) {
          const stop = el('button', 'pool-btn pool-btn-reject', '停止外快');
          stop.type = 'button';
          stop.dataset.action = 'stop-external';
          stop.dataset.activity = current.id;
          row.append(stop);
        }
        return row;
      }),
    );
  }

  /** 团本开团面板(编成页):门槛/团队检查状态 + 开团与取消(裁决一律在 sim)。 */
  function renderRaidOpen(state: GameState): void {
    const check = teamCheck(state);
    const statuses = raidStatuses(state.members);
    const plan = state.raidPlan;

    const wrap = el('div', 'raid-open-card');
    const head = el('div', 'pool-head');
    head.append(el('h2', 'section-title', '团本'));
    // 经济可见面:金库余额 + 现行分配制度(制度详情与换制在「金库·荣誉」页)
    head.append(
      el(
        'span',
        'pool-sub',
        `金库 ${state.vault.gold} 金 · 制度:${LOOT_SYSTEM_BY_ID.get(state.economy.system)?.name ?? '?'}${
          state.economy.selfDealing ? '(自肥中)' : ''
        }`,
      ),
    );
    wrap.append(head);

    if (plan !== undefined) {
      const raid = RAID_BY_ID.get(plan.raidId);
      wrap.append(
        el(
          'p',
          'raid-plan-line',
          raid !== undefined
            ? `已开团:「${raid.name}」—— 团本夜在下一个周边界打响,按首领顺序结算,赛中只观赛。`
            : '已开团:安排的团本已不在内容表,团本夜将自动撤销。',
        ),
      );
    } else {
      wrap.append(el('p', 'raid-plan-line raid-plan-idle', '本周未开团 —— 团队检查通过后即可安排团本夜。'));
    }

    const list = el('ul', 'raid-list');
    for (const { def, unlocked, unmet } of statuses) {
      const card = el('li', `raid-card${unlocked ? '' : ' map-locked'}`);
      const cardHead = el('div', 'map-head');
      cardHead.append(el('span', 'map-name', def.name));
      cardHead.append(el('span', 'map-tier map-tier-dungeon', `第 ${def.tier} 档`));
      cardHead.append(
        el(
          'span',
          'map-band',
          `门槛 Lv≥${def.unlock.averageLevel} · 装等≥${def.unlock.averageItemLevel} · 首领 ${def.bosses.length} 名`,
        ),
      );
      card.append(cardHead);
      card.append(el('p', 'map-desc', def.description));

      // 首领表预览:难度与硬门槛(赛前决策的信息面)
      const bosses = el('ul', 'raid-boss-list');
      def.bosses.forEach((boss, i) => {
        const row = el('li', 'raid-boss-row');
        row.append(el('span', 'raid-boss-order', String(i + 1)));
        row.append(el('span', 'raid-boss-name', boss.name));
        row.append(el('span', 'raid-boss-meta', `难度 ${boss.difficultyTarget}`));
        if (boss.hardGateItemLevel !== undefined) {
          row.append(el('span', 'raid-boss-gate', `硬门槛 装等≥${boss.hardGateItemLevel}`));
        }
        bosses.append(row);
      });
      card.append(bosses);

      if (!unlocked) {
        card.append(
          el(
            'div',
            'map-lock',
            `未解锁 —— 需${unmet.join('、')}(当前 等级 ${guildAverageLevel(state.members)} · 装等 ${guildAverageItemLevel(state.members)})`,
          ),
        );
      }

      const actions = el('div', 'pool-actions');
      if (plan?.raidId === def.id) {
        const cancel = el('button', 'pool-btn pool-btn-reject', '取消开团');
        cancel.type = 'button';
        cancel.dataset.action = 'cancel-raid';
        actions.append(cancel);
      } else {
        const open = el('button', 'pool-btn pool-btn-recruit', '开团');
        open.type = 'button';
        open.dataset.action = 'open-raid';
        open.dataset.raidId = def.id;
        if (!unlocked) {
          open.disabled = true; // 展示性禁用:真实裁决仍在门面
          open.title = `未解锁:需${unmet.join('、')}`;
        } else if (!check.passed) {
          open.disabled = true;
          open.title = `团队检查未通过:${check.failures[0]?.text ?? ''}`;
        }
        actions.append(open);
      }
      card.append(actions);
      list.append(card);
    }
    wrap.append(list);
    raidOpenEl.replaceChildren(wrap);
  }

  // ———— 团本夜直播视图(T10):首领血条 + 40 人点阵 + 滚动战斗日志 ————
  // 演出是纯表现:回放结构化 RaidNightReport(战斗胜负在 sim 已写定),
  // 不推进游戏时间、不做任何业务规则;重播/跳过是展示行为。

  /** 播放节拍(毫秒)与演出常量:血条下坠步长、团灭残值、日志保留条数。 */
  const RAID_TICK_MS = 90;
  const RAID_HP_STEP = 5;
  const RAID_WIPE_FLOOR = 40;
  const RAID_LOG_LIMIT = 40;
  /** 演出闲笔(纯 UI 文案,轮换使用;模拟内容一律在 src/content)。 */
  const RAID_FLAVOR = [
    '坦克稳住仇恨,仇恨链没有断。',
    '治疗链一刻不停。',
    '输出全开,首领血条肉眼可见地下坠。',
    '首领狂怒,团队阵型微收。',
    '远程拉开距离,近战贴身补刀。',
  ] as const;

  // 播放器闭包状态(纯演出,不进 GameState)
  let raidPlayerReport: RaidNightReport | null = null;
  let raidPlayerTimer: number | undefined;
  let raidBossIndex = 0;
  let raidHp = 100;
  let raidTick = 0;
  let raidFinished = false;
  let raidDots: HTMLSpanElement[] = [];
  let raidHpFillEl: HTMLDivElement | null = null;
  let raidHpTextEl: HTMLSpanElement | null = null;
  let raidBossNameEl: HTMLSpanElement | null = null;
  let raidBossGateEl: HTMLSpanElement | null = null;
  let raidLogEl: HTMLUListElement | null = null;
  let raidSummaryEl: HTMLDivElement | null = null;

  /** 团本夜面板(日程页):赛前安排预览 + 最近一夜的直播回放。 */
  function renderRaidNight(state: GameState): void {
    const night = nextRaidNight(state);
    if (night === undefined) {
      raidNightSubEl.textContent = '未开团';
      raidPlanEl.replaceChildren(
        el(
          'p',
          'empty-hint',
          '通过团队检查后在「编成」页开团 —— 团本夜在每周边界打响,按首领顺序结算,全程只观赛。',
        ),
      );
    } else {
      const raid = RAID_BY_ID.get(state.raidPlan?.raidId ?? '');
      raidNightSubEl.textContent = raid !== undefined ? `${formatGameStamp(night.atGameMinutes)} 开打` : '安排失效';
      if (raid === undefined) {
        raidPlanEl.replaceChildren(
          el('p', 'empty-hint', '开团安排指向的团本已不在内容表,团本夜将自动撤销。'),
        );
      } else {
        const card = el('div', 'raid-plan-card');
        card.append(el('p', 'raid-plan-title', `已开团:「${raid.name}」—— ${raid.bosses.length} 名首领,按顺序结算`));
        card.append(
          el(
            'p',
            'raid-plan-stamp',
            `团本夜:${formatGameStamp(night.atGameMinutes)}(还有 ${formatGameDuration(night.remainingGameMinutes)} · 约 ${formatRealDuration(
              gameMinutesToRealMs(night.remainingGameMinutes),
            )} 现实时)`,
          ),
        );
        card.append(el('p', 'raid-plan-note', '赛前决策:此刻还能调整编成与光环;开战后只观赛,不可介入。'));
        raidPlanEl.replaceChildren(card);
      }
    }

    // 直播视图:报告变化才重建并自动重播;同一报告的重渲染不打断进行中的播放
    const report = state.lastRaidNight;
    if (report === undefined) {
      stopRaidPlayer();
      raidPlayerReport = null;
      raidLiveWrapEl.hidden = true;
      raidLiveWrapEl.replaceChildren();
      return;
    }
    if (report !== raidPlayerReport) {
      stopRaidPlayer();
      raidPlayerReport = report;
      buildRaidLive(report);
      startRaidPlayback();
    }
  }

  /** 搭建直播视图骨架(首领血条 / 40 人点阵 / 滚动日志 / 控制)。 */
  function buildRaidLive(report: RaidNightReport): void {
    raidLiveWrapEl.hidden = false;
    const card = el('div', `raid-live${report.cleared ? ' raid-live-win' : ' raid-live-wipe'}`);

    const head = el('div', 'raid-live-head');
    head.append(el('span', 'raid-live-title', `「${report.raidName}」团本夜直播`));
    head.append(el('span', 'raid-live-stamp', formatGameStamp(report.atGameMinutes)));
    card.append(head);

    // 首领血条
    raidBossNameEl = el('span', 'raid-boss-name', '……');
    raidBossGateEl = el('span', 'raid-boss-gate-live', '');
    raidHpTextEl = el('span', 'raid-hp-text', '100%');
    const bossTop = el('div', 'raid-boss-top');
    bossTop.append(raidBossNameEl, raidBossGateEl, raidHpTextEl);
    raidHpFillEl = el('div', 'raid-hp-fill');
    const hpTrack = el('div', 'raid-hp');
    hpTrack.append(raidHpFillEl);
    const bossBar = el('div', 'raid-boss');
    bossBar.append(bossTop, hpTrack);
    card.append(bossBar);

    // 40 人状态点阵:一行 = 一支小队(颜色 = 职能;灰 = 倒下)
    const dots = el('div', 'raid-dots');
    raidDots = report.lineup.map((entry) => {
      const dot = el('span', `raid-dot dot-${entry.role}`);
      dot.title = `第${entry.squadOrdinal}队 · ${entry.name} · ${entry.role} · 装等${entry.itemLevel}`;
      dots.append(dot);
      return dot;
    });
    const dotsPanel = el('div', 'raid-dots-panel');
    dotsPanel.append(
      el('span', 'raid-dots-label', `出战 ${report.lineup.length} 人 · 平均装等 ${Math.round(report.teamItemLevel)}`),
    );
    dotsPanel.append(dots);
    card.append(dotsPanel);

    // 滚动战斗日志
    const logPanel = el('div', 'raid-log-panel');
    logPanel.append(el('span', 'raid-dots-label', '战斗日志'));
    raidLogEl = el('ul', 'raid-log');
    logPanel.append(raidLogEl);
    card.append(logPanel);

    // 战后小结(播放结束填入)
    raidSummaryEl = el('div', 'raid-summary');
    card.append(raidSummaryEl);

    // 控制:重播 / 跳到结果 —— 观赛工具,不是决策
    const controls = el('div', 'raid-live-controls');
    controls.append(el('span', 'raid-live-hint', '赛中只观赛 —— 胜负已由装等、职能与光环写定。'));
    const replay = el('button', 'save-btn', '重播');
    replay.type = 'button';
    replay.addEventListener('click', () => startRaidPlayback());
    const skip = el('button', 'save-btn', '跳到结果');
    skip.type = 'button';
    skip.addEventListener('click', () => finishRaidPlayback());
    controls.append(replay, skip);
    card.append(controls);

    raidLiveWrapEl.replaceChildren(card);
  }

  /** 开始(或重播)一段团本夜演出:回到开场,逐首领推进。 */
  function startRaidPlayback(): void {
    const report = raidPlayerReport;
    if (report === null || raidLogEl === null) {
      return;
    }
    stopRaidPlayer();
    raidFinished = false;
    raidBossIndex = 0;
    raidTick = 0;
    raidLogEl.replaceChildren(
      el(
        'li',
        'raid-log-line raid-log-sys',
        `团队进入「${report.raidName}」,全团 ${report.lineup.length} 人列阵,平均装等 ${Math.round(report.teamItemLevel)}。`,
      ),
    );
    for (const dot of raidDots) {
      dot.classList.remove('dot-down');
    }
    raidSummaryEl?.replaceChildren();
    if (report.bosses.length === 0) {
      finishRaidPlayback(); // 防御:空首领表直接收束(内容表校验兜底)
      return;
    }
    enterRaidBoss(report.bosses[0]!);
    raidPlayerTimer = window.setInterval(raidPlaybackTick, RAID_TICK_MS);
  }

  /** 停止演出计时器(不清画面;重播与收束共用)。 */
  function stopRaidPlayer(): void {
    if (raidPlayerTimer !== undefined) {
      window.clearInterval(raidPlayerTimer);
      raidPlayerTimer = undefined;
    }
  }

  /** 进入一名首领的战斗段:更新血条头部与开场日志。 */
  function enterRaidBoss(outcome: RaidBossOutcome): void {
    raidHp = 100;
    raidTick = 0;
    if (raidBossNameEl !== null && raidHpTextEl !== null && raidBossGateEl !== null) {
      raidBossNameEl.textContent = outcome.name;
      raidBossGateEl.textContent =
        outcome.hardGateItemLevel !== undefined
          ? `硬门槛 装等≥${outcome.hardGateItemLevel} · ${outcome.hardGateMet ? '达标' : '未达标'}`
          : '';
    }
    setRaidHp(100);
    pushRaidLog(`首领「${outcome.name}」开打!`, 'raid-log-sys');
    if (raidBossIndex > 0) {
      for (const dot of raidDots) {
        dot.classList.remove('dot-down'); // 倒下的队员被复活,重整旗鼓
      }
    }
  }

  /** 演出一拍:血条下坠;击杀到 0 收招,团灭停在残值。 */
  function raidPlaybackTick(): void {
    const report = raidPlayerReport;
    const outcome = report?.bosses[raidBossIndex];
    if (report === null || outcome === undefined || raidFinished) {
      finishRaidPlayback();
      return;
    }
    raidTick += 1;
    raidHp -= RAID_HP_STEP;
    if (raidTick % 4 === 2) {
      pushRaidLog(RAID_FLAVOR[raidTick % RAID_FLAVOR.length] ?? '', '');
    }
    if (outcome.killed && raidHp <= 0) {
      setRaidHp(0);
      resolveRaidBoss(outcome);
      return;
    }
    if (!outcome.killed && raidHp <= RAID_WIPE_FLOOR) {
      setRaidHp(RAID_WIPE_FLOOR);
      resolveRaidBoss(outcome);
      return;
    }
    setRaidHp(Math.max(raidHp, outcome.killed ? 0 : RAID_WIPE_FLOOR));
  }

  /** 一名首领的战斗段收束:结果与掉落入日志,点阵标倒下;团灭或全通则收夜。 */
  function resolveRaidBoss(outcome: RaidBossOutcome): void {
    const report = raidPlayerReport;
    if (report === null) {
      return;
    }
    if (outcome.killed) {
      const chancePercent = Math.round(outcome.successChance * 100);
      pushRaidLog(
        `「${outcome.name}」倒下!(胜率 ${chancePercent}%${outcome.fallen > 0 ? `,${outcome.fallen} 人倒下又被拉起` : ''})`,
        'raid-log-win',
      );
      for (const drop of outcome.drops) {
        pushRaidLog(
          drop.equipped
            ? `战利品:${drop.quality}·${drop.slot}(装等 ${drop.itemLevel})→ ${drop.assignedTo}(+${drop.upgradeDelta})`
            : `战利品:${drop.quality}·${drop.slot}(装等 ${drop.itemLevel})无人可提升,分解`,
          '',
        );
      }
      // 点阵标倒下(演出:从队尾数起;下一场开打时复活)
      for (let i = 0; i < outcome.fallen && i < raidDots.length; i++) {
        raidDots[raidDots.length - 1 - i]?.classList.add('dot-down');
      }
      if (raidBossIndex + 1 < report.bosses.length) {
        raidBossIndex += 1;
        enterRaidBoss(report.bosses[raidBossIndex]!);
        return;
      }
    } else {
      // 团灭:全员倒下,血条停在这里
      for (const dot of raidDots) {
        dot.classList.add('dot-down');
      }
      const chancePercent = Math.round(outcome.successChance * 100);
      pushRaidLog(`团灭于「${outcome.name}」(胜率 ${chancePercent}%)—— 血条停在了这里。`, 'raid-log-wipe');
      pushRaidLog(
        `团灭代价:修理金 ${report.wipe?.repairGold ?? 0} 金,全员疲劳 +${(report.wipe?.fatigue ?? 0) + RAID_SETTLEMENT.attemptFatiguePerBoss},士气 -${report.wipe?.moodHit ?? 0};无人退会,下周再战。`,
        'raid-log-wipe',
      );
    }
    finishRaidPlayback();
  }

  /** 收束演出:日志全量回放、血条定格、点阵收尾、小结填入。 */
  function finishRaidPlayback(): void {
    stopRaidPlayer();
    raidFinished = true;
    const report = raidPlayerReport;
    if (report === null || raidLogEl === null) {
      return;
    }

    // 日志全量回放(开场 → 逐首领开场/结果/掉落 → 收夜)
    const lines: HTMLLIElement[] = [
      el(
        'li',
        'raid-log-line raid-log-sys',
        `团队进入「${report.raidName}」,全团 ${report.lineup.length} 人列阵,平均装等 ${Math.round(report.teamItemLevel)}。`,
      ),
    ];
    report.bosses.forEach((outcome) => {
      lines.push(el('li', 'raid-log-line raid-log-sys', `首领「${outcome.name}」开打!`));
      if (outcome.killed) {
        const chancePercent = Math.round(outcome.successChance * 100);
        lines.push(
          el(
            'li',
            'raid-log-line raid-log-win',
            `「${outcome.name}」倒下!(胜率 ${chancePercent}%${outcome.fallen > 0 ? `,${outcome.fallen} 人倒下又被拉起` : ''})`,
          ),
        );
        for (const drop of outcome.drops) {
          lines.push(
            el(
              'li',
              'raid-log-line',
              drop.equipped
                ? `战利品:${drop.quality}·${drop.slot}(装等 ${drop.itemLevel})→ ${drop.assignedTo}(+${drop.upgradeDelta})`
                : `战利品:${drop.quality}·${drop.slot}(装等 ${drop.itemLevel})无人可提升,分解`,
            ),
          );
        }
      } else {
        const chancePercent = Math.round(outcome.successChance * 100);
        lines.push(el('li', 'raid-log-line raid-log-wipe', `团灭于「${outcome.name}」(胜率 ${chancePercent}%)—— 血条停在了这里。`));
        lines.push(
          el(
            'li',
            'raid-log-line raid-log-wipe',
            `团灭代价:修理金 ${report.wipe?.repairGold ?? 0} 金,全员疲劳 +${(report.wipe?.fatigue ?? 0) + RAID_SETTLEMENT.attemptFatiguePerBoss},士气 -${report.wipe?.moodHit ?? 0};无人退会,下周再战。`,
          ),
        );
      }
    });
    raidLogEl.replaceChildren(...lines);

    // 画面定格:最后一战(全通 = 0 血;团灭 = 残值)
    const last = report.bosses[report.bosses.length - 1]!;
    if (raidBossNameEl !== null && raidBossGateEl !== null) {
      raidBossNameEl.textContent = last.name;
      raidBossGateEl.textContent =
        last.hardGateItemLevel !== undefined
          ? `硬门槛 装等≥${last.hardGateItemLevel} · ${last.hardGateMet ? '达标' : '未达标'}`
          : '';
    }
    setRaidHp(last.killed ? 0 : RAID_WIPE_FLOOR);
    for (const dot of raidDots) {
      dot.classList.toggle('dot-down', !report.cleared);
    }

    // 战后小结
    const kills = report.bosses.filter((boss) => boss.killed).length;
    const dropCount = report.bosses.reduce((sum, boss) => sum + boss.drops.length, 0);
    const equippedCount = report.bosses.reduce(
      (sum, boss) => sum + boss.drops.filter((drop) => drop.equipped).length,
      0,
    );
    raidSummaryEl?.replaceChildren(
      el(
        'p',
        `raid-summary-line${report.cleared ? ' raid-summary-win' : ' raid-summary-wipe'}`,
        report.cleared
          ? `「${report.raidName}」全通:击杀 ${kills}/${report.bosses.length} 名首领,缴获 ${dropCount} 件装备(穿上 ${equippedCount} 件),士气大振。`
          : `止步第 ${report.wipe?.bossIndex ?? report.bosses.length} 首领「${report.wipe?.bossName ?? ''}」:击杀 ${kills}/${report.bosses.length},修理金 ${report.repairGold} 金,全员疲劳与士气受损 —— 无永久损失,下周再战。`,
      ),
    );
  }

  /** 血条更新(百分比文本 + 宽度)。 */
  function setRaidHp(percent: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    if (raidHpFillEl !== null) {
      raidHpFillEl.style.width = `${clamped}%`;
    }
    if (raidHpTextEl !== null) {
      raidHpTextEl.textContent = `${clamped}%`;
    }
  }

  /** 追加一条战斗日志并滚到底(超长裁剪)。 */
  function pushRaidLog(text: string, extraClass: string): void {
    if (raidLogEl === null || text === '') {
      return;
    }
    raidLogEl.append(el('li', `raid-log-line${extraClass === '' ? '' : ` ${extraClass}`}`, text));
    while (raidLogEl.childElementCount > RAID_LOG_LIMIT) {
      raidLogEl.firstElementChild?.remove();
    }
    raidLogEl.scrollTop = raidLogEl.scrollHeight;
  }

  /** 下一场结算倒计时:游戏时间/现实时间双显(派生量来自 sim/schedule,换算常量在 sim/clock)。 */
  function renderCountdown(state: GameState): void {
    const countdown = nextSettlement(state);
    settlementTagEl.textContent = countdown.isWeekBoundary ? '周更 · 团本 CD 重置' : '日更';
    settlementCountdownEl.textContent = formatGameDuration(countdown.remainingGameMinutes);
    settlementDualEl.textContent = `${formatGameStamp(countdown.atGameMinutes)} · 约 ${formatRealDuration(
      gameMinutesToRealMs(countdown.remainingGameMinutes),
    )}(现实)后结算`;
  }

  /** 活动队列:全部已排活动按编成顺序(派生量来自 sim/schedule)。 */
  function renderQueue(state: GameState): void {
    const entries = activityQueue(state);
    queueSubEl.textContent = entries.length > 0 ? `${entries.length} 项进行中` : '空闲';
    if (entries.length === 0) {
      queueListEl.replaceChildren(
        el('li', 'empty-hint', '暂无进行中的活动 —— 在下方安排小队练级或下本,队列会显示在这里。'),
      );
      return;
    }
    queueListEl.replaceChildren(
      ...entries.map((entry) => {
        const row = el('li', 'queue-row');
        const info = el('div', 'queue-info');
        info.append(el('span', 'queue-squad', `第 ${entry.squadOrdinal} 小队`));
        const title = el('span', 'queue-name');
        const kindClass =
          entry.kind === '练级' ? 'leveling' : entry.kind === '下本' ? 'dungeon' : 'external';
        title.append(el('span', `queue-kind queue-kind-${kindClass}`, entry.kind));
        title.append(document.createTextNode(entry.name));
        info.append(title);
        row.append(info);
        row.append(
          el(
            'span',
            'queue-cadence',
            entry.kind === '练级'
              ? `${entry.tier}区 · 经验 ${entry.perDay}/日`
              : entry.kind === '下本'
                ? `${entry.tier}档 · 每日 ${entry.perDay} 次`
                : `${entry.perDay} 金/人·日(个人金)`,
          ),
        );
        return row;
      }),
    );
  }

  /** 离线归来摘要卡:数据全部由装配层统计,此处只渲染(验收标准 1 的呈现面)。 */
  function showOfflineHarvest(view: OfflineHarvestView | null): void {
    if (view === null) {
      offlineHarvestEl.hidden = true;
      return;
    }
    const card = el('div', 'harvest-card');
    const head = el('div', 'harvest-head');
    head.append(el('span', 'harvest-title', '离线归来'));
    head.append(el('span', 'harvest-away', `离线 ${view.awayText}(现实)`));
    card.append(head);
    card.append(
      el(
        'p',
        'harvest-line',
        `离开期间公会同速运转:推进了 ${view.advancedText}(游戏时间),${view.fromStamp} → ${view.toStamp}。`,
      ),
    );
    if (view.highlights.length > 0) {
      const list = el('ul', 'harvest-highlights');
      for (const line of view.highlights) {
        list.append(el('li', 'harvest-highlight', line));
      }
      card.append(list);
    }
    card.append(
      el('p', 'harvest-note', `期间共 ${view.eventCount} 条事件,已按发生顺序记入下方日志(展示最近条目)。`),
    );
    const close = el('button', 'harvest-close', '知道了');
    close.type = 'button';
    close.addEventListener('click', () => {
      offlineHarvestEl.hidden = true; // 收起是纯展示行为
    });
    card.append(close);
    offlineHarvestEl.replaceChildren(card);
    offlineHarvestEl.hidden = false;
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

  /** 金库·荣誉页渲染(T11):金库余额 + 分配制度(三选一可换)+ 自肥面板 + 团员钱包。 */
  function renderVault(state: GameState): void {
    // 金库卡:双钱包的公家一侧(数值只读自状态)
    const balance = el('div', 'vault-card');
    const balanceHead = el('div', 'pool-head');
    balanceHead.append(el('h2', 'section-title', '公会金库'));
    balanceHead.append(el('span', 'pool-sub', '建会起始 ' + VAULT.startingGold + ' 金'));
    balance.append(balanceHead);
    balance.append(el('p', 'vault-gold-line', `余额 ${state.vault.gold} 金`));
    balance.append(
      el(
        'p',
        'vault-sub-line',
        `历史收入 ${state.vault.incomeTotal} 金 · 历史修理支出 ${state.vault.repairSpent} 金`,
      ),
    );
    const lastLoot = state.lastRaidNight?.loot;
    if (lastLoot !== undefined) {
      const systemName = LOOT_SYSTEM_BY_ID.get(lastLoot.system)?.name ?? '?';
      balance.append(
        el(
          'p',
          'vault-sub-line',
          `最近团本夜(${systemName}):入金库 ${lastLoot.vaultGoldIn} 金 · 自肥 ${lastLoot.selfDealtCount} 件`,
        ),
      );
    }
    vaultBalanceEl.replaceChildren(balance);

    // 分配制度三卡:名称/风格/详解/效果摘要/换入成本(数值只读自内容表)
    const signed = (value: number): string => (value >= 0 ? `+${value}` : `${value}`);
    lootSystemListEl.replaceChildren(
      ...LOOT_SYSTEMS.map((def) => {
        const current = def.id === state.economy.system;
        const card = el('li', `loot-system-card${current ? ' loot-system-current' : ''}`);
        const head = el('div', 'loot-system-head');
        head.append(el('span', 'loot-system-name', def.name));
        head.append(el('span', 'loot-system-tag', def.tagline));
        card.append(head);
        card.append(el('p', 'loot-system-desc', def.description));
        const effects = el('div', 'loot-system-effects');
        effects.append(el('span', 'effect-chip', `每夜出席者忠诚 ${signed(def.attendeeLoyaltyPerNight)}`));
        effects.append(el('span', 'effect-chip', `每夜出席者心情 ${signed(def.attendeeMoodPerNight)}`));
        effects.append(
          el(
            'span',
            'effect-chip',
            def.id === 'gkp'
              ? `成交价 ${def.gkpVaultCutPercent}% 入金库、其余全团均分`
              : '金币不流动',
          ),
        );
        if (def.selfDealLoyaltyCost !== undefined) {
          effects.append(
            el(
              'span',
              'effect-chip effect-chip-warn',
              `自肥每件:忠诚 −${def.selfDealLoyaltyCost} · 声望 −${def.selfDealReputationCost}`,
            ),
          );
        }
        card.append(effects);
        const actions = el('div', 'pool-actions loot-system-actions');
        actions.append(
          el(
            'span',
            'loot-switch-cost',
            `换入成本:${def.switchCostGold > 0 ? `金库 ${def.switchCostGold} 金 + ` : ''}全员忠诚 −${def.switchLoyaltyHit}${
              def.id === 'dkp' ? ' · DKP 清零重记' : ''
            }`,
          ),
        );
        if (current) {
          actions.append(el('span', 'loot-current-badge', '现行制度'));
        } else {
          const button = el('button', 'pool-btn pool-btn-recruit', '换用此制度');
          button.type = 'button';
          button.dataset.action = 'switch-loot-system';
          button.dataset.system = def.id;
          if (state.vault.gold < def.switchCostGold) {
            button.disabled = true; // 展示性禁用:真实裁决仍在门面
            button.title = `金库余额不足(立规需 ${def.switchCostGold} 金)`;
          }
          actions.append(button);
        }
        card.append(actions);
        return card;
      }),
    );

    // 自肥面板:仅会长裁量制下存在(开启/停止 + 累积代价)
    const chairmanDef = LOOT_SYSTEM_BY_ID.get('chairman')!;
    if (state.economy.system === 'chairman') {
      const card = el('div', `self-deal-card${state.economy.selfDealing ? ' self-deal-on' : ''}`);
      const head = el('div', 'pool-head');
      head.append(el('h2', 'section-title', '自肥'));
      head.append(
        el('span', 'pool-sub', state.economy.selfDealing ? '已开启 —— 掉落优先装进会长角色' : '未开启'),
      );
      card.append(head);
      card.append(
        el(
          'p',
          'self-deal-desc',
          `会长利用分配权把装备分给自己的会长角色:每件自肥,出席团员忠诚 −${chairmanDef.selfDealLoyaltyCost}、声望 −${chairmanDef.selfDealReputationCost},代价逐件累积(声望档位与星级见下方声望卡)。`,
        ),
      );
      card.append(
        el(
          'p',
          'self-deal-accum',
          `已累积:自肥 ${state.economy.selfDealtCount} 件 · 声望代价累计 ${state.economy.selfDealReputationPaid}`,
        ),
      );
      const button = el(
        'button',
        `pool-btn ${state.economy.selfDealing ? 'pool-btn-reject' : 'pool-btn-recruit'}`,
        state.economy.selfDealing ? '停止自肥' : '开启自肥',
      );
      button.type = 'button';
      button.dataset.action = 'toggle-self-deal';
      button.dataset.enabled = state.economy.selfDealing ? 'false' : 'true';
      card.append(button);
      selfDealPanelEl.replaceChildren(card);
      selfDealPanelEl.hidden = false;
    } else {
      selfDealPanelEl.hidden = true;
      selfDealPanelEl.replaceChildren();
    }

    // 团员钱包:个人金(打工/野团所得)与 DKP 余额
    walletSubEl.textContent = '打工/野团收入归个人金;GKP 制下用来出价';
    walletListEl.replaceChildren(
      ...state.members.map((member) => {
        const row = el('li', 'wallet-row');
        const name = el('span', 'member-name', member.name);
        if (member.isChairman) {
          name.append(el('span', 'chairman-badge', '会长'));
        }
        row.append(name);
        row.append(el('span', 'wallet-gold', `${member.personalGold} 金`));
        row.append(el('span', 'wallet-dkp', `DKP ${member.dkp}`));
        return row;
      }),
    );

    // 声望卡 + 荣誉墙 + 名人堂(T12):全部只读状态与 sim 派生量
    renderRenownCard(state);
    renderHonorWall(state);
    renderHallOfFame(state);
  }

  /** 声望卡:档位名 + 星级 + 升阶进度 + 名册上限联动与挖版权限(派生量来自 sim/reputation)。 */
  function renderRenownCard(state: GameState): void {
    const rung = renownRung(state.renownPoints);
    const standing = renownStanding(rung);
    const stars = '★'.repeat(standing.stars) + '☆'.repeat(3 - standing.stars);

    const card = el('div', 'renown-card');
    const head = el('div', 'pool-head');
    head.append(el('h2', 'section-title', '声望'));
    head.append(el('span', 'pool-sub', '首杀与里程碑加分 · 自肥扣分 · 档位驱动申请池与名册上限'));
    card.append(head);

    const titleRow = el('div', 'renown-title');
    titleRow.append(el('span', 'renown-tier-name', standing.tier.name));
    titleRow.append(el('span', 'renown-stars', stars));
    card.append(titleRow);
    card.append(el('p', 'renown-blurb', standing.tier.blurb));

    // 升阶进度:当前声望值距下一阶(满阶显示封顶;门槛与数值换算都在 sim)
    if (rung >= RENOWN_RUNG_COUNT) {
      card.append(el('p', 'renown-progress', `声望值 ${state.renownPoints} —— 已至顶档,传说仍在续写。`));
    } else {
      const current = rungThreshold(rung);
      const next = rungThreshold(rung + 1);
      const gained = state.renownPoints - current;
      const needed = next - current;
      const track = el('div', 'vital-track renown-track');
      const fill = el('div', 'vital-fill');
      fill.style.width = `${clampPercent(Math.floor((gained / needed) * 100))}%`;
      track.append(fill);
      const row = el('div', 'renown-progress-row');
      row.append(track);
      row.append(el('span', 'renown-progress-text', `${gained}/${needed} → ${renownLabel(rung + 1)}`));
      card.append(row);
    }

    const effects = el('div', 'loot-system-effects');
    effects.append(el('span', 'effect-chip', `名册上限 ${state.rosterCap}/${rosterCapForRung(RENOWN_RUNG_COUNT)} 人`));
    const poachTier = RENOWN_TIERS.find((tier) => tier.poachUnlocked);
    effects.append(
      el(
        'span',
        'effect-chip',
        standing.tier.poachUnlocked
          ? '挖角:可对背景公会出手'
          : `挖角:${poachTier === undefined ? '暂未开放' : `${poachTier.name}起解锁`}`,
      ),
    );
    card.append(effects);
    renownCardEl.replaceChildren(card);
  }

  /** 荣誉墙:首杀徽章(带日期)/ 里程碑 / 稀有陈列,全部可追溯(数据来自状态)。 */
  function renderHonorWall(state: GameState): void {
    const wall = state.honorWall;
    const total = wall.firstKills.length + wall.milestones.length + wall.rareDrops.length;
    honorSubEl.textContent = `首杀 ${wall.firstKills.length} · 里程碑 ${wall.milestones.length} · 稀有 ${wall.rareDrops.length}`;

    if (total === 0) {
      honorWallEl.replaceChildren(
        el('p', 'empty-hint', '墙上还空着 —— 首杀一名团本首领、达成里程碑或穿上一件紫装,都会挂上这面墙。'),
      );
      return;
    }

    const frag = document.createDocumentFragment();
    if (wall.firstKills.length > 0) {
      frag.append(el('h4', 'honor-section-title', '首杀徽章'));
      const list = el('ul', 'honor-list');
      for (const badge of [...wall.firstKills].reverse()) {
        const row = el('li', 'honor-item honor-kill');
        row.append(el('span', 'honor-kill-boss', badge.bossName));
        row.append(el('span', 'honor-kill-raid', badge.raidName));
        row.append(el('span', 'honor-stamp', formatGameStamp(badge.atGameMinutes)));
        list.append(row);
      }
      frag.append(list);
    }

    if (wall.milestones.length > 0) {
      frag.append(el('h4', 'honor-section-title', '里程碑'));
      const list = el('ul', 'honor-list');
      for (const record of [...wall.milestones].reverse()) {
        const row = el('li', 'honor-item honor-milestone');
        row.append(el('span', 'honor-kill-boss', record.name));
        row.append(el('span', 'honor-stamp', formatGameStamp(record.atGameMinutes)));
        list.append(row);
      }
      frag.append(list);
    }

    if (wall.rareDrops.length > 0) {
      frag.append(el('h4', 'honor-section-title', '稀有陈列'));
      const list = el('ul', 'honor-list');
      for (const record of [...wall.rareDrops].reverse()) {
        const row = el('li', 'honor-item honor-rare');
        row.append(el('span', `gear-quality ${QUALITY_CLASS[record.quality]}`, record.quality));
        row.append(el('span', 'honor-rare-item', `${record.slot} · 装等 ${record.itemLevel}`));
        row.append(el('span', 'honor-rare-dest', `→ ${record.holder}(${record.source})`));
        row.append(el('span', 'honor-stamp', formatGameStamp(record.atGameMinutes)));
        list.append(row);
      }
      frag.append(list);
    }
    honorWallEl.replaceChildren(frag);
  }

  /** 名人堂:离会团员的去向与功绩(数据来自状态;台词/去向在离会时已定)。 */
  function renderHallOfFame(state: GameState): void {
    hallSubEl.textContent = `${state.hallOfFame.length} 位离会团员`;
    if (state.hallOfFame.length === 0) {
      hallListEl.replaceChildren(el('li', 'empty-hint', '还没有人离开 —— 淘汰与自动退会的团员会在这里留下去向与功绩。'));
      return;
    }
    hallListEl.replaceChildren(
      ...[...state.hallOfFame].reverse().map((entry) => {
        const cls = CLASS_BY_ID.get(entry.classId);
        const spec = cls?.specs.find((s) => s.id === entry.specId);
        const card = el('li', `hall-card hall-${entry.reason === '会长淘汰' ? 'dismissed' : 'resigned'}`);
        const head = el('div', 'hall-head');
        const name = el('span', 'member-name', entry.name);
        name.append(el('span', 'hall-reason', entry.reason));
        head.append(name);
        head.append(el('span', 'hall-stamp', formatGameStamp(entry.leftAtGameMinutes)));
        card.append(head);
        card.append(el('p', 'hall-classline', `${cls?.name ?? '?'} · ${spec?.name ?? '?'} · Lv${entry.level}(装等 ${entry.itemLevel})`));
        card.append(el('p', 'hall-farewell', `离会台词:「${entry.farewell}」`));
        card.append(el('p', 'hall-destination', `去向:${entry.destination}`));
        card.append(el('p', 'hall-deeds', `功绩:${hallDeedsLine(entry)}`));
        return card;
      }),
    );
  }

  // ———— 世界页(T13,GLOSSARY:虚拟服务器):排名、首杀榜、竞争公会动态与全服新闻 ————
  // 全部只读状态与 sim 派生量(serverRanking/serverLadder);规则一律在 sim/world。

  /** 世界页渲染:概览与玩家排名 → 行情条 → 首杀榜 → 竞争公会 → 排名榜 → 新闻流。 */
  function renderWorld(state: GameState): void {
    const world = state.world;
    const ranking = serverRanking(state);
    const playerEntry = ranking.entries[ranking.playerRank - 1]!;
    const ladderLength = serverLadder().length;

    // 概览卡:服务器名 + 公会规模 + 本会排名与进度(数值全部来自派生量)
    const overview = el('div', 'world-card');
    const overviewHead = el('div', 'pool-head');
    overviewHead.append(el('h2', 'section-title', WORLD.serverName));
    overviewHead.append(el('span', 'pool-sub', `${ranking.total} 支公会同场竞技`));
    overview.append(overviewHead);
    const rankRow = el('div', 'world-rank-row');
    rankRow.append(el('span', 'world-rank-position', `第 ${ranking.playerRank} 位`));
    rankRow.append(
      el(
        'span',
        'world-rank-sub',
        `「${state.guild.name}」· 进度分 ${playerEntry.score} · 团本推进 ${playerEntry.ladderProgress}/${ladderLength}`,
      ),
    );
    overview.append(rankRow);
    overview.append(
      el(
        'p',
        'world-note',
        '竞争公会受橡皮筋约束:你正常推进时他们慢半拍;长期停滞才会被超车 —— 内容永不锁,本会首杀永远是你的。',
      ),
    );
    worldOverviewEl.replaceChildren(overview);

    // 行情条:抬价波进行中才显示(幅度与天数读自状态与内容表)
    const wave = world.marketWave;
    if (wave === undefined) {
      marketBannerEl.hidden = true;
    } else {
      marketBannerEl.hidden = false;
      marketBannerEl.replaceChildren(
        el(
          'span',
          'market-banner-text',
          `行情看涨:团灭修理金 +${WORLD.market.repairMarkupPercent}%(「${wave.guildName}」在扫货,还剩 ${wave.daysLeft} 日)`,
        ),
      );
    }

    // 服务器首杀榜:按夺得顺序倒序(最新在前);归属带「本会/竞争」标记
    firstKillSubEl.textContent = `${world.serverFirstKills.length}/${ladderLength} 名首领已有归属`;
    if (world.serverFirstKills.length === 0) {
      firstKillListEl.replaceChildren(
        el('li', 'empty-hint', '首杀榜还空着 —— 第一个杀死新首领的公会将在全服留名。'),
      );
    } else {
      firstKillListEl.replaceChildren(
        ...[...world.serverFirstKills].reverse().map((kill) => {
          const row = el('li', `first-kill-row${kill.byPlayer ? ' first-kill-mine' : ''}`);
          row.append(el('span', 'first-kill-boss', kill.bossName));
          row.append(el('span', 'first-kill-raid', kill.raidName));
          row.append(el('span', `first-kill-owner${kill.byPlayer ? ' owner-player' : ''}`, kill.guildName));
          row.append(el('span', 'honor-stamp', formatGameStamp(kill.atGameMinutes)));
          return row;
        }),
      );
    }

    // 竞争公会:推进进度条 + 服务器首杀数 + 行事风格(风格文案在内容表)
    rivalListEl.replaceChildren(
      ...world.guilds
        .filter((guild) => guild.kind === 'rival')
        .map((guild) => {
          const def = RIVAL_GUILD_BY_NAME.get(guild.name);
          const kills = world.serverFirstKills.filter((kill) => kill.guildName === guild.name).length;
          const card = el('li', 'rival-card');
          const head = el('div', 'rival-head');
          head.append(el('span', 'rival-name', guild.name));
          head.append(el('span', 'rival-kills', `服务器首杀 ${kills}`));
          card.append(head);
          const track = el('div', 'vital-track rival-track');
          const fill = el('div', 'vital-fill rival-fill');
          fill.style.width = `${clampPercent(Math.floor((guild.ladderProgress / Math.max(1, ladderLength)) * 100))}%`;
          track.append(fill);
          const progressRow = el('div', 'rival-progress-row');
          progressRow.append(track);
          progressRow.append(el('span', 'rival-progress-text', `${guild.ladderProgress}/${ladderLength}`));
          card.append(progressRow);
          card.append(el('p', 'rival-style', def?.style ?? ''));
          return card;
        }),
    );

    // 排名榜:整榜可浏览(竖屏滚动);本会行高亮,竞争/背景带标记
    const rivalCount = world.guilds.filter((guild) => guild.kind === 'rival').length;
    rankingSubEl.textContent = `共 ${ranking.total} 会(竞争 ${rivalCount} · 背景 ${ranking.total - 1 - rivalCount})`;
    rankingListEl.replaceChildren(
      ...ranking.entries.map((entry, index) => {
        const row = el('li', `ranking-row${entry.isPlayer ? ' ranking-player' : ''}`);
        row.append(el('span', 'ranking-position', String(index + 1)));
        row.append(el('span', 'ranking-name', entry.name));
        row.append(el('span', `ranking-kind kind-${entry.kind}`, entry.kind));
        row.append(el('span', 'ranking-score', String(entry.score)));
        return row;
      }),
    );

    // 全服新闻流:最新在前(状态内保留上限由 sim 裁;此处再限显示条数)
    newsSubEl.textContent = `${world.news.length} 条(保留最近 ${WORLD.newsKeepCount})`;
    if (world.news.length === 0) {
      worldNewsListEl.replaceChildren(el('li', 'empty-hint', '服务器刚开,还没有新闻。'));
    } else {
      worldNewsListEl.replaceChildren(
        ...[...world.news]
          .reverse()
          .slice(0, 40)
          .map((item) => {
            const row = el('li', 'news-row');
            const stamp = el('span', 'stamp');
            stamp.textContent = `[${formatGameStamp(item.atGameMinutes)}]`;
            row.append(stamp, document.createTextNode(item.text));
            return row;
          }),
      );
    }
  }

  /** 待命团员行:选择目标小队并编入(满员禁用是展示行为,裁决在门面)。 */  function renderBenchRow(member: Member, squads: readonly { id: number; memberIds: readonly number[] }[]): HTMLLIElement {
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
            `心情${member.mood} 忠诚${member.loyalty} 疲劳${member.fatigue} 金${member.personalGold}`,
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
      el('div', 'stat', `个人金 ${member.personalGold}`),
      el('div', 'stat', `DKP ${member.dkp}`),
      el('div', 'stat', `击杀 ${member.bossKills}`),
      el('div', 'stat', `紫装 ${member.rareLootWon}`),
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

  return { render, clearFeed, showOfflineHarvest };
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
