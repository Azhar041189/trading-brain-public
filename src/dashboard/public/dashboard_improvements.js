/**
 * Trading Brain — UI/UX Improvements v2.0
 * ==========================================================
 * Drop-in enhancement script.
 * What this fixes:
 *  1. Grouped 6-category tab navigation (replaces 35-tab scroll bar)
 *  2. Positions table — P&L %, color-coded severity rows
 *  3. Right sidebar — tearsheet, vault, roadmap visual improvements
 *  4. Milestone tick label bug fix ($1K/$100K → $10K/$1M)
 *  5. Module loading states — animated spinner + timeout/error states
 *  6. Header badge strip — scannable two-row layout
 *  7. CSS polish — depth, contrast, panel hover, scrollbar
 * ==========================================================
 */

// ── 1. INJECT IMPROVED CSS ───────────────────────────────
(function injectStyles() {
  const style = document.createElement('style');
  style.id = 'tb-improvements';
  style.textContent = `

  /* ── Color & Shadow System ── */
  :root {
    --panel-glow-blue:  0 0 0 1px rgba(59,130,246,0.15), 0 8px 32px rgba(0,0,0,0.4);
    --panel-glow-green: 0 0 0 1px rgba(16,185,129,0.15), 0 8px 32px rgba(0,0,0,0.4);
    --panel-glow-red:   0 0 0 1px rgba(239,68,68,0.2),   0 8px 32px rgba(0,0,0,0.4);
    --panel-glow-gold:  0 0 0 1px rgba(245,158,11,0.2),  0 8px 32px rgba(0,0,0,0.4);
    --radius-lg: 14px;
    --radius-md: 10px;
    --radius-sm: 6px;
  }

  /* ── Unified Dropdown + Subtabs Header ── */
  .log-panel > .panel-header {
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    padding: 6px 12px !important;
    background: rgba(8,12,20,0.85) !important;
    border-bottom: 1px solid rgba(255,255,255,0.06) !important;
    gap: 8px !important;
    flex-wrap: nowrap !important;
    width: 100% !important;
  }

  @media (max-width: 768px) {
    .log-panel {
      height: auto !important;
      min-height: 480px !important;
    }
    .log-panel > .panel-header {
      flex-direction: column !important;
      align-items: stretch !important;
      gap: 8px !important;
      padding: 8px 10px !important;
    }
    .tb-cat-dropdown-wrap {
      width: 100% !important;
    }
    .tb-cat-select {
      width: 100% !important;
      font-size: 0.8rem !important;
    }
    .tb-subtab-strip {
      width: 100% !important;
      overflow-x: auto !important;
      white-space: nowrap !important;
      -webkit-overflow-scrolling: touch !important;
      scrollbar-width: none !important;
      padding: 4px 0 !important;
    }
    .tb-subtab-strip::-webkit-scrollbar {
      display: none !important;
    }
    .log-panel #tabControls {
      width: 100% !important;
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      padding-top: 4px !important;
      border-top: 1px solid rgba(255,255,255,0.04) !important;
    }
  }

  .tb-cat-dropdown-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .tb-cat-select {
    background: #111726;
    border: 1px solid rgba(59,130,246,0.35);
    border-radius: 8px;
    color: #60a5fa;
    font-size: 0.76rem;
    font-weight: 800;
    padding: 5px 10px;
    outline: none;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.2s ease;
    box-shadow: 0 0 10px rgba(59,130,246,0.15);
  }
  .tb-cat-select:hover {
    border-color: #3b82f6;
    box-shadow: 0 0 14px rgba(59,130,246,0.3);
  }
  .tb-cat-select option {
    background: #090d15;
    color: #fff;
    font-weight: 600;
  }

  .tb-subtab-strip {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    flex: 1;
    scrollbar-width: thin;
    scrollbar-color: #1e293b transparent;
    padding: 2px 4px;
    align-items: center;
  }
  .tb-subtab-strip::-webkit-scrollbar { height: 3px; }
  .tb-subtab-strip::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 4px; }

  /* Hide original tab nav */
  .log-panel > .panel-header .tab-nav-wrapper { display: none !important; }

  /* ── Enhanced Panel Cards ── */
  .panel {
    border-radius: var(--radius-lg) !important;
  }
  .panel:hover {
    box-shadow: 0 16px 48px rgba(0,0,0,0.5) !important;
    border-top-color: rgba(59,130,246,0.25) !important;
  }

  /* ── Positions Table — severity rows ── */
  .pos-row-loss-heavy  { background: rgba(239,68,68,0.08) !important; }
  .pos-row-loss-medium { background: rgba(239,68,68,0.04) !important; }
  .pos-row-profit      { background: rgba(16,185,129,0.06) !important; }

  .pnl-bar-wrap {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .pnl-micro-bar {
    height: 3px;
    border-radius: 2px;
    min-width: 4px;
    max-width: 40px;
    transition: width 0.3s;
  }
  .pnl-pct {
    font-size: 0.62rem;
    font-family: var(--font-mono);
    opacity: 0.7;
  }

  /* ── Tearsheet metrics — bigger, bolder ── */
  #tearsheetMetricsGrid > div {
    padding: 12px 10px !important;
    border-radius: 8px !important;
    position: relative;
    overflow: hidden;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  #tearsheetMetricsGrid > div:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  }
  #tearsheetMetricsGrid > div::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(255,255,255,0.03) 0%, transparent 60%);
    pointer-events: none;
  }
  #metricSharpe      { font-size: 1.3rem !important; }
  #metricMDD         { font-size: 1.3rem !important; }
  #metricWinRate     { font-size: 1.3rem !important; }
  #metricProfitFactor { font-size: 1.3rem !important; }

  /* ── AI Alpha Signals Box Custom Scroll ── */
  .list-container {
    max-height: 280px !important;
    overflow-y: auto !important;
    scrollbar-width: thin !important;
    scrollbar-color: #1e293b transparent !important;
    padding-right: 4px !important;
  }
  .list-container::-webkit-scrollbar {
    width: 4px !important;
  }
  .list-container::-webkit-scrollbar-thumb {
    background: #1e293b !important;
    border-radius: 4px !important;
  }
  .list-container::-webkit-scrollbar-thumb:hover {
    background: #3b82f6 !important;
  }

  /* ── Improved loading state ── */
  .tb-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 40px 20px;
    color: #475569;
    font-size: 0.75rem;
    font-family: var(--font-mono);
  }
  .tb-spinner {
    width: 28px;
    height: 28px;
    border: 2px solid rgba(255,255,255,0.05);
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: tb-spin 0.8s linear infinite;
  }
  @keyframes tb-spin { to { transform: rotate(360deg); } }

  .tb-error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 30px 20px;
    color: #ef4444;
    font-size: 0.75rem;
    font-family: var(--font-mono);
  }
  .tb-retry-btn {
    padding: 5px 14px;
    background: rgba(239,68,68,0.15);
    border: 1px solid rgba(239,68,68,0.3);
    border-radius: 6px;
    color: #f87171;
    font-size: 0.7rem;
    cursor: pointer;
    margin-top: 4px;
    transition: all 0.15s;
  }
  .tb-retry-btn:hover { background: rgba(239,68,68,0.25); }

  /* ── Goal roadmap improved ── */
  #milestoneTickLabels {
    font-size: 0.62rem !important;
  }
  .vault-stage-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 12px;
    font-size: 0.65rem;
    font-weight: 700;
    font-family: var(--font-mono);
  }

  /* ── Header badge strip — improved readability ── */
  .status-badges {
    gap: 5px !important;
  }
  .badge {
    font-size: 0.69rem !important;
    padding: 4px 10px !important;
    border-radius: 7px !important;
    letter-spacing: 0.025em !important;
  }

  /* ── Portfolio grid improvements ── */
  .portfolio-value { font-size: 1.25rem !important; }
  .portfolio-item {
    border-radius: 10px !important;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .portfolio-item:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  }

  /* ── Live price animation ── */
  .live-price {
    font-size: 1.25rem !important;
  }
  @keyframes price-pulse {
    0%   { opacity: 1; }
    50%  { opacity: 0.6; }
    100% { opacity: 1; }
  }
  .price-updating { animation: price-pulse 0.4s ease; }

  /* ── Scrollbar polish ── */
  ::-webkit-scrollbar-thumb {
    background: #1a2740 !important;
    border-radius: 4px !important;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: #2d4060 !important;
  }

  /* ── Agent debate cards ── */
  .agent-card {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    padding: 8px 10px;
    margin-bottom: 4px;
    border-radius: 7px;
    border-left: 3px solid var(--agent-color, #60a5fa);
    background: rgba(255,255,255,0.02);
  }
  .agent-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 0.62rem;
    font-weight: 800;
    white-space: nowrap;
    letter-spacing: 0.03em;
  }
  .agent-speech {
    font-size: 0.74rem;
    line-height: 1.45;
    color: #cbd5e1;
    padding-top: 1px;
  }

  /* ── Debate card wrapper ── */
  .debate-card {
    background: rgba(255,255,255,0.018);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 10px;
    padding: 10px 12px;
    margin-bottom: 8px;
    transition: border-color 0.2s;
  }
  .debate-card:hover { border-color: rgba(139,92,246,0.25); }
  .debate-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    padding-bottom: 7px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    font-size: 0.76rem;
    font-weight: 700;
  }

  /* ── Positions — compact header ── */
  .pos-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 10px 6px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
  }
  .pos-total-pnl {
    font-family: var(--font-mono);
    font-size: 0.82rem;
    font-weight: 800;
    padding: 3px 10px;
    border-radius: 6px;
  }

  /* ── Flash price update ── */
  @keyframes flash-up   { 0% { background: rgba(16,185,129,0.25); } 100% { background: transparent; } }
  @keyframes flash-down { 0% { background: rgba(239,68,68,0.25);  } 100% { background: transparent; } }
  .flash-up   { animation: flash-up   0.5s ease; }
  .flash-down { animation: flash-down 0.5s ease; }

  `;
  document.head.appendChild(style);
})();


// ── 2. TAB GROUP SYSTEM ──────────────────────────────────
const TAB_GROUPS = {
  intelligence: {
    label: '🧠 Intelligence',
    color: '#8b5cf6',
    colorBg: 'rgba(139,92,246,0.15)',
    colorGlow: 'rgba(139,92,246,0.2)',
    tabs: [
      { id: 'debate',      label: 'AI Hermes Debate' },
      { id: 'secondbrain', label: '🧠 Second Brain' },
      { id: 'backtest',    label: '🧪 30D Walk-Forward' },
      { id: 'synthesizer', label: 'AI Synthesizer' },
      { id: 'deeprl',      label: 'Deep RL Distiller' },
      { id: 'souls',       label: 'Agent Souls (5)' },
      { id: 'memory',      label: 'Episodic Memory' },
    ]
  },
  markets: {
    label: '📊 Markets',
    color: '#3b82f6',
    colorBg: 'rgba(59,130,246,0.15)',
    colorGlow: 'rgba(59,130,246,0.2)',
    tabs: [
      { id: 'sessionedge',   label: '🕒 Session Profiler' },
      { id: 'screener',      label: 'TV Screener' },
      { id: 'macroalpha',    label: 'FRED & Macro Rates' },
      { id: 'options',       label: 'Options Chain' },
      { id: 'multitf',       label: 'Multi-TF Regime' },
      { id: 'sectorrisk',    label: 'Sector Risk' },
      { id: 'earningsradar', label: 'Earnings Radar' },
      { id: 'gapscanner',    label: '09:15 Gaps' },
      { id: 'news',          label: 'Live News' },
    ]
  },
  alpha: {
    label: '⚡ Alpha',
    color: '#10b981',
    colorBg: 'rgba(16,185,129,0.15)',
    colorGlow: 'rgba(16,185,129,0.2)',
    tabs: [
      { id: 'strategystudio', label: '🎨 Strategy Studio (No-Code)' },
      { id: 'insiderwhales', label: '🕵️ Insider & Congress' },
      { id: 'arbitrage',     label: 'Flash Arb' },
      { id: 'pairs',         label: 'Pairs Arb' },
      { id: 'basis',         label: 'Basis Funding' },
      { id: 'darkpool',      label: 'Dark Pool' },
      { id: 'orderbook',     label: 'Whale L2/L3' },
      { id: 'statpairs',     label: 'Stat Pairs' },
      { id: 'crossvenue',    label: 'Cross-Venue' },
      { id: 'dexcex',        label: 'CEX-DEX' },
      { id: 'hawkes',        label: 'Hawkes L3' },
    ]
  },
  risk: {
    label: '🛡️ Risk',
    color: '#f59e0b',
    colorBg: 'rgba(245,158,11,0.15)',
    colorGlow: 'rgba(245,158,11,0.2)',
    tabs: [
      { id: 'montecarlo', label: '100x Monte Carlo' },
      { id: 'tailrisk',   label: 'EVT / CVaR Tail' },
      { id: 'vault',      label: 'Cold Vault' },
      { id: 'quantum',    label: 'Quantum QUBO' },
      { id: 'mev',        label: 'MEV Shield' },
      { id: 'failover',   label: 'Exchange Failover' },
    ]
  },
  execution: {
    label: '🧬 Strategies & Execution',
    color: '#06b6d4',
    colorBg: 'rgba(6,182,212,0.15)',
    colorGlow: 'rgba(6,182,212,0.2)',
    tabs: [
      { id: 'genetic',  label: '🧬 Strategy Center & Health' },
      { id: 'twap',     label: 'TWAP Slicer' },
      { id: 'telegram', label: 'Telegram Copilot' },
      { id: 'volsurface', label: 'Vol Surface (IV)' },
    ]
  },
  analytics: {
    label: '📈 Analytics',
    color: '#a855f7',
    colorBg: 'rgba(168,85,247,0.15)',
    colorGlow: 'rgba(168,85,247,0.2)',
    tabs: [
      { id: 'backtest',  label: '🧪 30D Walk-Forward' },
      { id: 'trades',    label: 'Trade History' },
      { id: 'analytics', label: 'Performance' },
      { id: 'logs',      label: 'System Logs' },
    ]
  }
};

let activeCat = 'intelligence';

function buildGroupedNav() {
  const select = document.getElementById('tbCatSelect');
  if (select) {
    select.onchange = (e) => {
      if (typeof onCategoryDropdownChange === 'function') {
        onCategoryDropdownChange(e.target.value);
      }
    };
  }
}

function patchSwitchConsoleTab() {
  // Safe tab activation engine
  window.activateModuleTab = function(tab) {
    window._activeConsoleTab = tab;
    window.activeConsoleTab = tab;

    // 1. Show corresponding content panel, hide others
    const contentMap = {
      quanthub: 'tabContentQuantHub',
      debate: 'tabContentDebate',
      sessionedge: 'tabContentSessionEdge',
      predictionmarkets: 'tabContentPredictionMarkets',
      dhandepth: 'tabContentDhanDepth',
      dhantape: 'tabContentDhanTape',
      dhanvwap: 'tabContentDhanVwap',
      dhanladder: 'tabContentDhanLadder',
      dhanfundamentals: 'tabContentDhanFundamentals',
      dhanfutures: 'tabContentDhanFutures',
      dhantechnicals: 'tabContentDhanTechnicals',
      marketaction: 'tabContentMarketAction',
      backtest: 'tabContentBacktest',
      secondbrain: 'tabContentSecondBrain',
      macroalpha: 'tabContentMacroAlpha',
      insiderwhales: 'tabContentInsiderWhales',
      strategystudio: 'tabContentStrategyStudio',
      screener: 'tabContentScreener',
      orderbook: 'tabContentOrderBook',
      montecarlo: 'tabContentMonteCarlo',
      arbitrage: 'tabContentArbitrage',
      basis: 'tabContentBasis',
      pairs: 'tabContentPairs',
      genetic: 'tabContentGenetic',
      darkpool: 'tabContentDarkPool',
      vault: 'tabContentVault',
      quantum: 'tabContentQuantum',
      dexcex: 'tabContentDexCex',
      synthesizer: 'tabContentSynthesizer',
      mev: 'tabContentMev',
      tailrisk: 'tabContentTailRisk',
      failover: 'tabContentFailover',
      options: 'tabContentOptions',
      dma: 'tabContentDma',
      multitf: 'tabContentMultiTF',
      sectorrisk: 'tabContentSectorRisk',
      souls: 'tabContentSouls',
      memory: 'tabContentMemory',
      gapscanner: 'tabContentGapScanner',
      statpairs: 'tabContentStatPairs',
      hawkes: 'tabContentHawkes',
      twap: 'tabContentTwap',
      telegram: 'tabContentTelegram',
      deeprl: 'tabContentDeepRL',
      crossvenue: 'tabContentCrossVenue',
      volsurface: 'tabContentVolSurface',
      earningsradar: 'tabContentEarningsRadar',
      news: 'tabContentNews',
      trades: 'tabContentTrades',
      logs: 'tabContentLogs',
      analytics: 'tabContentAnalytics'
    };

    Object.entries(contentMap).forEach(([key, elementId]) => {
      const el = document.getElementById(elementId);
      if (el) {
        if (key === tab) {
          el.style.setProperty('display', (key === 'logs' || key === 'debate') ? 'flex' : 'block', 'important');
        } else {
          el.style.setProperty('display', 'none', 'important');
        }
      }
    });

    // 2. Trigger data fetcher for the selected tab
    if (typeof executeTabAction === 'function') {
      try {
        if (tab === 'quanthub' && typeof loadQuantHub === 'function') loadQuantHub();
        else if (tab === 'debate' && typeof loadDebates === 'function') loadDebates();
        else if (tab === 'predictionmarkets' && typeof loadPredictionMarketsTab === 'function') loadPredictionMarketsTab();
        else if (tab === 'secondbrain' && typeof loadSecondBrainTab === 'function') loadSecondBrainTab();
        else if (tab === 'strategystudio' && typeof loadStrategyStudio === 'function') loadStrategyStudio();
        else if (tab === 'sessionedge' && typeof loadSessionEdge === 'function') loadSessionEdge();
        else if (tab === 'dhandepth' && typeof loadDhanDepth === 'function') loadDhanDepth();
        else if (tab === 'dhantape' && typeof loadDhanTape === 'function') loadDhanTape();
        else if (tab === 'dhanvwap' && typeof loadDhanVwap === 'function') loadDhanVwap();
        else if (tab === 'dhanladder' && typeof loadDhanLadder === 'function') loadDhanLadder();
        else if (tab === 'dhanfundamentals' && typeof loadDhanFundamentals === 'function') loadDhanFundamentals();
        else if (tab === 'dhanfutures' && typeof loadDhanFutures === 'function') loadDhanFutures();
        else if (tab === 'dhantechnicals' && typeof loadDhanTechnicals === 'function') loadDhanTechnicals();
        else if (tab === 'marketaction' && typeof loadMarketAction === 'function') loadMarketAction();
        else if (tab === 'backtest' && typeof loadWalkForwardBacktest === 'function') loadWalkForwardBacktest();
        else if (tab === 'macroalpha' && typeof loadMacroAlpha === 'function') loadMacroAlpha();
        else if (tab === 'insiderwhales' && typeof loadInsiderWhales === 'function') loadInsiderWhales();
        else if (tab === 'screener' && typeof loadTVScreener === 'function') loadTVScreener();
        else if (tab === 'orderbook' && typeof loadOrderBook === 'function') loadOrderBook();
        else if (tab === 'montecarlo' && typeof loadMonteCarlo === 'function') loadMonteCarlo();
        else if (tab === 'arbitrage' && typeof loadArbitrage === 'function') loadArbitrage();
        else if (tab === 'basis' && typeof loadBasis === 'function') loadBasis();
        else if (tab === 'pairs' && typeof loadPairs === 'function') loadPairs();
        else if (tab === 'genetic' && typeof loadGenetic === 'function') loadGenetic();
        else if (tab === 'darkpool' && typeof loadDarkPool === 'function') loadDarkPool();
        else if (tab === 'vault' && typeof loadVault === 'function') loadVault();
        else if (tab === 'quantum' && typeof loadQuantum === 'function') loadQuantum();
        else if (tab === 'dexcex' && typeof loadDexCex === 'function') loadDexCex();
        else if (tab === 'synthesizer' && typeof loadSynthesizer === 'function') loadSynthesizer();
        else if (tab === 'mev' && typeof loadMev === 'function') loadMev();
        else if (tab === 'tailrisk' && typeof loadTailRisk === 'function') loadTailRisk();
        else if (tab === 'failover' && typeof loadFailover === 'function') loadFailover();
        else if (tab === 'options' && typeof loadOptions === 'function') loadOptions();
        else if (tab === 'dma' && typeof loadDma === 'function') loadDma();
        else if (tab === 'multitf' && typeof loadMultiTF === 'function') loadMultiTF();
        else if (tab === 'sectorrisk' && typeof loadSectorRisk === 'function') loadSectorRisk();
        else if (tab === 'souls' && typeof loadSouls === 'function') loadSouls();
        else if (tab === 'memory' && typeof loadMemory === 'function') loadMemory();
        else if (tab === 'statpairs' && typeof loadStatPairs === 'function') loadStatPairs();
        else if (tab === 'hawkes' && typeof loadHawkes === 'function') loadHawkes();
        else if (tab === 'twap' && typeof loadTwap === 'function') loadTwap();
        else if (tab === 'telegram' && typeof loadTelegram === 'function') loadTelegram();
        else if (tab === 'deeprl' && typeof loadDeepRL === 'function') loadDeepRL();
        else if (tab === 'crossvenue' && typeof loadCrossVenue === 'function') loadCrossVenue();
        else if (tab === 'volsurface' && typeof loadVolSurface === 'function') loadVolSurface();
        else if (tab === 'earningsradar' && typeof loadEarningsRadar === 'function') loadEarningsRadar();
        else if (tab === 'gapscanner' && typeof loadGapScanner === 'function') loadGapScanner();
        else if (tab === 'news' && typeof loadNews === 'function') loadNews();
        else if (tab === 'trades' && typeof loadTrades === 'function') loadTrades();
        else if (tab === 'analytics' && typeof loadEquityCurve === 'function') loadEquityCurve();
      } catch (err) {
        console.error('Error activating tab data fetcher:', err);
      }
    }

    // 3. Highlight subtab with neon blue glow — directly apply inline styles
    const tabGroups = window.TAB_CATEGORIES || (typeof TAB_CATEGORIES !== 'undefined' ? TAB_CATEGORIES : null);
    if (tabGroups) {
      // Sync dropdown category if needed
      for (const [catKey, grp] of Object.entries(tabGroups)) {
        if (grp.tabs.some(t => t.id === tab)) {
          if (catKey !== window.activeCategory) {
            window.activeCategory = catKey;
            const select = document.getElementById('tbCatSelect');
            if (select) select.value = catKey;
          }
          break;
        }
      }
    }

    // Directly style all tab buttons — bypass closure variable issue
    const strip = document.getElementById('tbSubStrip');
    if (strip) {
      const allBtns = strip.querySelectorAll('.tab-btn');
      allBtns.forEach(btn => {
        const tabId = btn.id.replace('subTabBtn_', '');
        const isActive = tabId === tab;
        if (isActive) {
          btn.style.background = 'linear-gradient(135deg, rgba(59,130,246,0.28), rgba(59,130,246,0.13))';
          btn.style.border = '1.5px solid #3b82f6';
          btn.style.color = '#ffffff';
          btn.style.fontWeight = '800';
          btn.style.boxShadow = '0 0 16px rgba(59,130,246,0.6), 0 0 6px rgba(59,130,246,0.4), inset 0 1px 0 rgba(255,255,255,0.12)';
          btn.style.textShadow = '0 0 8px rgba(59,130,246,0.5)';
          btn.classList.add('active');
        } else {
          btn.style.background = 'transparent';
          btn.style.border = '1.5px solid transparent';
          btn.style.color = '#64748b';
          btn.style.fontWeight = '600';
          btn.style.boxShadow = 'none';
          btn.style.textShadow = 'none';
          btn.classList.remove('active');
        }
      });
    }
  };

  // Override global switchConsoleTab
  window.switchConsoleTab = window.activateModuleTab;
}


// ── 3. IMPROVED POSITIONS TABLE ──────────────────────────
function enhancePositionsTable() {
  const origRenderPositions = window.renderPositions;
  if (!origRenderPositions) {
    setTimeout(enhancePositionsTable, 500);
    return;
  }

  window.renderPositions = function() {
    // Call original first
    origRenderPositions();

    // Then enhance what it rendered
    const tbody = document.getElementById('positionsTableBody');
    if (!tbody) return;

    const rows = tbody.querySelectorAll('tr[data-sym], tr');
    let totalPnl = 0;
    let parsedRows = [];

    // Re-process rows to add severity coloring and P&L bars
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) return;

      const pnlCell = cells[4];
      const pnlText = pnlCell?.textContent?.replace(/[^0-9.\-+]/g, '') || '0';
      const pnl = parseFloat(pnlText) || 0;
      totalPnl += pnl;

      // Severity coloring
      row.classList.remove('pos-row-loss-heavy', 'pos-row-loss-medium', 'pos-row-profit');
      if (pnl < -200)       row.classList.add('pos-row-loss-heavy');
      else if (pnl < -50)   row.classList.add('pos-row-loss-medium');
      else if (pnl > 0)     row.classList.add('pos-row-profit');

      parsedRows.push({ row, pnl });
    });

    // Inject total P&L summary above table
    const posPanel = tbody.closest('.panel');
    if (posPanel) {
      let summary = posPanel.querySelector('.pos-total-summary');
      if (!summary) {
        summary = document.createElement('div');
        summary.className = 'pos-total-summary pos-header-row';
        posPanel.querySelector('.panel-header')?.after(summary);
      }
      const isPos = totalPnl >= 0;
      summary.innerHTML = `
        <span style="font-size:0.7rem; color:#64748b; font-weight:700; text-transform:uppercase; letter-spacing:0.05em;">
          Unrealised P&L
        </span>
        <span class="pos-total-pnl mono" style="
          color: ${isPos ? 'var(--color-green)' : 'var(--color-red)'};
          background: ${isPos ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)'};
          border: 1px solid ${isPos ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'};
        ">
          ${isPos ? '+' : ''}$${totalPnl.toFixed(2)}
        </span>
      `;
    }
  };
}


// ── 4. MILESTONE LABELS FIX ──────────────────────────────
function fixMilestoneLabels() {
  function patchLabels() {
    const el = document.getElementById('milestoneTickLabels');
    if (!el) return;
    const activeMarket = window.activeMarket || 'CRYPTO';
    if (activeMarket === 'IN') {
      el.innerHTML = `
        <span>Seed ₹1L</span>
        <span>2x ₹2L</span>
        <span>5x ₹5L</span>
        <span>Goal ₹1Cr</span>
      `;
    } else {
      el.innerHTML = `
        <span>Seed $10K</span>
        <span>2x $20K</span>
        <span>5x $50K</span>
        <span>Goal $1M</span>
      `;
    }
  }
  patchLabels();
  // Re-apply whenever market changes
  const origOnMarketChange = window.onMarketChange;
  if (origOnMarketChange) {
    window.onMarketChange = function(market) {
      origOnMarketChange(market);
      setTimeout(patchLabels, 200);
    };
  }
}


// ── 5. IMPROVED MODULE LOADING STATES ────────────────────
function improveLoadingStates() {
  // Replace static text placeholders with animated spinners
  document.querySelectorAll('[id^="tabContent"] .empty').forEach(el => {
    const text = el.textContent.trim();
    if (text.length > 5 && !el.querySelector('.tb-spinner')) {
      el.outerHTML = `
        <div class="tb-loading">
          <div class="tb-spinner"></div>
          <span>${text}</span>
        </div>
      `;
    }
  });

  // Add fetch timeout + error recovery
  const origFetch = window.fetch;
  window.fetch = function(...args) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000); // 12s timeout
    const url = args[0];
    const opts = { ...(args[1] || {}), signal: controller.signal };
    return origFetch(url, opts).finally(() => clearTimeout(timeout));
  };
}


// ── 6. HEADER IMPROVEMENTS ───────────────────────────────
function improveHeader() {
  function watchAutoMesh() {
    const btn = document.getElementById('autoBtn');
    if (!btn) { setTimeout(watchAutoMesh, 500); return; }

    const observer = new MutationObserver(() => {
      const isActive = btn.textContent.includes('ACTIVE');
      btn.style.fontWeight = '800';
      btn.style.letterSpacing = '0.03em';
      if (isActive) {
        btn.style.boxShadow = '0 0 12px rgba(16,185,129,0.3)';
      } else {
        btn.style.boxShadow = 'none';
      }
    });
    observer.observe(btn, { childList: true, characterData: true, subtree: true });
  }
  watchAutoMesh();

  // Animate live price changes
  const origHandleMsg = window.handleMessage;
  if (origHandleMsg) {
    window.handleMessage = function(msg) {
      origHandleMsg(msg);
      if (msg.type === 'candle_tick') {
        const el = document.getElementById('chartLivePrice');
        if (el) {
          el.classList.remove('flash-up', 'flash-down');
          void el.offsetWidth;
          el.classList.add(msg.candle?.close >= msg.candle?.open ? 'flash-up' : 'flash-down');
        }
      }
    };
  }
}


// ── 7. TEARSHEET FIX — call computeTearsheet on page load ──
function fixTearsheetOnLoad() {
  async function tryPopulateTearsheet() {
    try {
      const res = await fetch('/api/trades');
      const trades = await res.json();
      if (Array.isArray(trades) && trades.length >= 5 && typeof computeTearsheet === 'function') {
        computeTearsheet(trades, window.activeMarket || 'CRYPTO');
      }
    } catch (e) { /* silent */ }
  }
  setTimeout(tryPopulateTearsheet, 1500);
  setTimeout(tryPopulateTearsheet, 4000);
}


// ── 8. DEBATE PANEL IMPROVEMENT ──────────────────────────
function improveDebateRendering() {
  const origLoadDebates = window.loadDebates;
  if (!origLoadDebates) { setTimeout(improveDebateRendering, 500); return; }

  const AGENT_CONFIG = {
    ARES:   { color: '#eab308', bg: 'rgba(234,179,8,0.12)',    emoji: '⚡' },
    ATHENA: { color: '#ef4444', bg: 'rgba(239,68,68,0.12)',    emoji: '🛡️' },
    THOTH:  { color: '#3b82f6', bg: 'rgba(59,130,246,0.12)',   emoji: '🔬' },
    ANUBIS: { color: '#10b981', bg: 'rgba(16,185,129,0.12)',   emoji: '👁️' },
    HERMES: { color: '#a855f7', bg: 'rgba(168,85,247,0.12)',   emoji: '⚖️' },
  };

  window.loadDebates = async function() {
    try {
      const res = await fetch('/api/debates');
      const debates = await res.json();
      const container = document.getElementById('tabContentDebate');
      if (!debates || debates.length === 0) return;

      container.innerHTML = '';
      debates.forEach(d => {
        const time = new Date(d.timestamp).toLocaleTimeString();
        const currSym = window.currentCurrencySymbol || '$';
        const priceStr = parseFloat(d.price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });

        const agents = [
          { name: 'ARES',   speech: d.aresSpeech   || d.bullCase,         role: 'Apex Trend Hunter' },
          { name: 'ATHENA', speech: d.athenaSpeech  || d.bearCase,         role: 'Cold Risk Sentinel' },
          { name: 'THOTH',  speech: d.thothSpeech   || d.macroVerdict,     role: 'Quantum Quant' },
          { name: 'ANUBIS', speech: d.anubisSpeech  || d.fundamentalNote,  role: 'Whale & MEV Sentinel' },
          { name: 'HERMES', speech: d.hermesDecree  || d.consensusDecision, role: 'Arbiter Decree' },
        ].filter(a => a.speech);

        const isExec = d.consensusDecision === 'EXECUTE';
        const card = document.createElement('div');
        card.className = 'debate-card';
        card.innerHTML = `
          <div class="debate-card-header">
            <span>
              <span style="color:#8b5cf6; font-size:0.65rem; margin-right:6px;">[Hermes Council]</span>
              <span style="color:#fff;">${d.direction} ${d.symbol}</span>
              <span style="color:#38bdf8; font-family:var(--font-mono);"> @ ${currSym}${priceStr}</span>
              <span style="color:#475569; font-size:0.65rem; margin-left:8px;">${time}</span>
            </span>
            <span class="badge ${isExec ? 'connected' : 'paper'}" style="font-size:0.65rem; flex-shrink:0;">
              ${d.consensusDecision} (${d.confidence})
            </span>
          </div>
          ${agents.map(a => {
            const cfg = AGENT_CONFIG[a.name] || AGENT_CONFIG.HERMES;
            return `<div class="agent-card" style="--agent-color:${cfg.color}; margin-bottom:4px;">
              <div>
                <span class="agent-tag" style="background:${cfg.bg}; color:${cfg.color};">
                  ${cfg.emoji} ${a.name}
                </span>
                <div style="font-size:0.6rem; color:#475569; margin-top:2px; white-space:nowrap;">${a.role}</div>
              </div>
              <div class="agent-speech">${a.speech}</div>
            </div>`;
          }).join('')}
          ${d.memoryLesson ? `
            <div style="background:rgba(139,92,246,0.06); border-left:2px solid #8b5cf6; padding:5px 10px; border-radius:0 6px 6px 0; margin-top:6px; font-size:0.68rem; color:#94a3b8;">
              <span style="color:#a855f7; font-weight:700;">🧠 Memory:</span> "${d.memoryLesson}"
            </div>` : ''}
        `;
        container.appendChild(card);
      });
    } catch(e) {
      console.error('Debate load error:', e);
    }
  };
}


// ── 9. PORTFOLIO CARD IMPROVEMENTS ────────────────────────
function improvePortfolioCards() {
  function watchGrowth() {
    const el = document.getElementById('growthMultiple');
    if (!el) { setTimeout(watchGrowth, 500); return; }
    const observer = new MutationObserver(() => {
      const val = parseFloat(el.textContent) || 1;
      const panel = el.closest('.portfolio-item');
      if (!panel) return;
      if (val >= 10) {
        panel.style.borderColor = 'rgba(16,185,129,0.4)';
        panel.style.boxShadow = '0 0 16px rgba(16,185,129,0.15)';
      } else if (val >= 5) {
        panel.style.borderColor = 'rgba(59,130,246,0.3)';
      }
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
  }
  watchGrowth();

  function watchPnl() {
    const el = document.getElementById('capPnl');
    if (!el) { setTimeout(watchPnl, 500); return; }
    const observer = new MutationObserver(() => {
      const val = parseFloat(el.textContent.replace(/[^0-9.\-]/g, '')) || 0;
      const sign = el.textContent.includes('-') ? -1 : 1;
      const pnl = val * sign;
      const panel = el.closest('.portfolio-item');
      if (!panel) return;
      panel.style.borderColor = pnl >= 0 ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)';
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
  }
  watchPnl();
}


// ── 10. OBSIDIAN SECOND BRAIN CONTROLLERS ───────────────────
let sbCurrentGraph = null;
let sbActiveMode = 'doc';

window.setSecondBrainMode = function(mode) {
  sbActiveMode = mode;
  const docBtn = document.getElementById('sbModeDocBtn');
  const graphBtn = document.getElementById('sbModeGraphBtn');
  const docView = document.getElementById('sbDocView');
  const graphView = document.getElementById('sbGraphView');

  if (mode === 'doc') {
    if (docBtn) { docBtn.style.background = '#3b82f6'; docBtn.style.color = '#fff'; }
    if (graphBtn) { graphBtn.style.background = 'transparent'; graphBtn.style.color = '#94a3b8'; }
    if (docView) docView.style.display = 'block';
    if (graphView) graphView.style.display = 'none';
  } else {
    if (docBtn) { docBtn.style.background = 'transparent'; docBtn.style.color = '#94a3b8'; }
    if (graphBtn) { graphBtn.style.background = '#8b5cf6'; graphBtn.style.color = '#fff'; }
    if (docView) docView.style.display = 'none';
    if (graphView) {
      graphView.style.display = 'block';
      loadSecondBrainGraph();
    }
  }
};

window.loadSecondBrainTab = async function() {
  try {
    const res = await fetch('/api/second-brain/tree');
    const data = await res.json();
    if (data.success && data.tree) {
      renderSecondBrainTree(data.tree);
      const today = new Date().toISOString().split('T')[0];
      loadSecondBrainNote(`Daily Journal/${today}.md`);
    }
  } catch (e) {
    console.error('Error loading Second Brain tree:', e);
  }
};

window.renderSecondBrainTree = function(tree) {
  const container = document.getElementById('sbFileTreeContainer');
  const countEl = document.getElementById('sbTotalFilesCount');
  if (!container) return;

  let totalFiles = 0;
  window._sbActiveFilePath = window._sbActiveFilePath || `Daily Journal/${new Date().toISOString().split('T')[0]}.md`;

  function renderNodes(nodes, depth = 0) {
    let out = '';
    nodes.forEach(node => {
      const indent = depth * 8;
      if (node.type === 'folder') {
        const folderIcons = {
          'Assets': '🪙',
          'Daily Journal': '📅',
          'Strategies': '⚡',
          'Council': '🏛️'
        };
        const icon = folderIcons[node.name] || '📁';
        out += `
          <div style="margin-top:6px; margin-bottom:2px; font-weight:800; font-size:0.68rem; color:#94a3b8; padding-left:${indent}px; display:flex; align-items:center; gap:5px; text-transform:uppercase; letter-spacing:0.04em;">
            <span>${icon}</span> <span>${node.name}</span>
          </div>
        `;
        if (node.children) {
          out += renderNodes(node.children, depth + 1);
        }
      } else {
        totalFiles++;
        const isSelected = window._sbActiveFilePath === node.path;
        out += `
          <div onclick="window._sbActiveFilePath='${node.path}'; renderSecondBrainTree(window._sbCurrentTree || []); loadSecondBrainNote('${node.path}')" style="cursor:pointer; padding:4px 8px 4px ${indent + 8}px; border-radius:5px; display:flex; align-items:center; gap:6px; font-size:0.72rem; color:${isSelected ? '#60a5fa' : '#cbd5e1'}; font-weight:${isSelected ? '700' : '500'}; background:${isSelected ? 'rgba(59,130,246,0.18)' : 'transparent'}; border-left:${isSelected ? '2px solid #3b82f6' : '2px solid transparent'}; transition:all 0.15s ease;" onmouseover="if(!${isSelected}) this.style.background='rgba(255,255,255,0.05)'" onmouseout="if(!${isSelected}) this.style.background='transparent'">
            <span style="font-size:0.68rem; opacity:${isSelected ? '1' : '0.7'};">📄</span>
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${node.name.replace('.md', '')}</span>
          </div>
        `;
      }
    });
    return out;
  }

  window._sbCurrentTree = tree;
  container.innerHTML = renderNodes(tree) || '<div style="color:#64748b; padding:6px;">Vault empty. Click Sync Vault.</div>';
  if (countEl) countEl.textContent = `${totalFiles} notes`;
};

window.renderObsidianMarkdown = function(rawText, filePath) {
  if (!rawText) return '<div class="empty">Empty note</div>';

  let text = rawText;
  let frontmatterHtml = '';

  // 1. Extract and parse YAML frontmatter block
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fmMatch) {
    const rawFm = fmMatch[1];
    text = text.slice(fmMatch[0].length); // Remove raw frontmatter from the document body

    const meta = {};
    const lines = rawFm.split('\n');
    let currentKey = null;

    lines.forEach(l => {
      const line = l.trim();
      if (!line) return;
      if (line.startsWith('- ') && currentKey) {
        if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
        meta[currentKey].push(line.replace(/^- /, '').trim());
      } else if (line.includes(':')) {
        const idx = line.indexOf(':');
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        currentKey = key;
        if (val) {
          meta[key] = val;
        } else {
          meta[key] = [];
        }
      }
    });

    const title = meta.title || filePath.split('/').pop().replace('.md', '');
    const date = meta.date || '';
    const regime = meta.regime || '';
    const pnl = meta.total_pnl || '';
    const trades = meta.total_trades || '';
    const capital = meta.capital || '';
    const tags = Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []);

    const regimeColor = regime.includes('BULL') ? '#10b981' : (regime.includes('BEAR') ? '#ef4444' : '#f59e0b');
    const pnlColor = (pnl.startsWith('+') || parseFloat(pnl) > 0) ? '#10b981' : (pnl.startsWith('-') ? '#ef4444' : '#38bdf8');

    frontmatterHtml = `
      <div style="background:linear-gradient(135deg, rgba(17,24,39,0.95), rgba(11,15,23,0.98)); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:12px 16px; margin-bottom:18px; box-shadow:0 4px 20px rgba(0,0,0,0.35);">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:8px; margin-bottom:10px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:1.2rem;">🧠</span>
            <div>
              <div style="font-size:0.92rem; font-weight:800; color:#ffffff; letter-spacing:-0.01em;">${title}</div>
              <div style="font-size:0.66rem; color:#64748b; font-family:var(--font-mono);">${filePath}</div>
            </div>
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
            ${regime ? `<span style="font-size:0.68rem; font-weight:700; background:rgba(16,185,129,0.12); color:${regimeColor}; border:1px solid rgba(16,185,129,0.3); padding:2px 8px; border-radius:12px; display:inline-flex; align-items:center; gap:4px;">🟢 ${regime}</span>` : ''}
            ${pnl ? `<span style="font-size:0.68rem; font-weight:700; background:rgba(56,189,248,0.12); color:${pnlColor}; border:1px solid rgba(56,189,248,0.3); padding:2px 8px; border-radius:12px;">💰 PnL: ${pnl}</span>` : ''}
          </div>
        </div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:8px; font-size:0.72rem; margin-bottom:8px;">
          ${date ? `<div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05); border-radius:6px; padding:4px 8px;"><span style="color:#64748b;">Date:</span> <strong style="color:#e2e8f0; font-family:var(--font-mono);">${date}</strong></div>` : ''}
          ${trades ? `<div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05); border-radius:6px; padding:4px 8px;"><span style="color:#64748b;">Trades:</span> <strong style="color:#38bdf8; font-family:var(--font-mono);">${trades}</strong></div>` : ''}
          ${capital ? `<div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05); border-radius:6px; padding:4px 8px;"><span style="color:#64748b;">Capital:</span> <strong style="color:#10b981; font-family:var(--font-mono);">${capital}</strong></div>` : ''}
        </div>

        ${tags.length > 0 ? `
          <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:6px;">
            <span style="font-size:0.64rem; color:#64748b; font-weight:700; text-transform:uppercase; letter-spacing:0.04em;">Tags:</span>
            ${tags.map(t => `<span style="font-size:0.66rem; background:rgba(139,92,246,0.14); color:#c084fc; border:1px solid rgba(139,92,246,0.3); padding:1px 7px; border-radius:10px; font-family:var(--font-mono);">#${t}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  // 2. Parse WikiLinks [[Link]]
  text = text.replace(/\[\[([a-zA-Z0-9_\-\.\/= ]+)\]\]/g, (match, p1) => {
    return `<span onclick="onWikiLinkClick('${p1}')" class="obsidian-wikilink" style="color:#38bdf8; background:rgba(56,189,248,0.12); border:1px solid rgba(56,189,248,0.28); padding:2px 7px; border-radius:5px; cursor:pointer; font-weight:700; display:inline-flex; align-items:center; gap:4px; transition:all 0.15s ease;" onmouseover="this.style.background='rgba(56,189,248,0.25)'; this.style.borderColor='#38bdf8'" onmouseout="this.style.background='rgba(56,189,248,0.12)'; this.style.borderColor='rgba(56,189,248,0.28)'"><span style="font-size:0.68rem;">🔗</span> [[${p1}]]</span>`;
  });

  // 3. Parse Callouts & Quotes
  text = text.replace(/^> (.*$)/gim, (match, p1) => {
    return `<div style="border-left:3px solid #8b5cf6; margin:10px 0; padding:8px 12px; background:linear-gradient(90deg, rgba(139,92,246,0.12), rgba(139,92,246,0.03)); color:#e2e8f0; font-size:0.76rem; border-radius:0 6px 6px 0; line-height:1.5;">${p1}</div>`;
  });

  // 4. Parse Headers
  text = text
    .replace(/^# (.*$)/gim, '<div style="font-size:1.12rem; font-weight:800; color:#fff; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:6px; margin:14px 0 10px 0;">$1</div>')
    .replace(/^## (.*$)/gim, '<div style="font-size:0.92rem; font-weight:700; color:#60a5fa; border-left:3px solid #3b82f6; padding-left:8px; margin:14px 0 8px 0;">$1</div>')
    .replace(/^### (.*$)/gim, '<div style="font-size:0.82rem; font-weight:700; color:#c084fc; margin:10px 0 6px 0;">$1</div>');

  // 5. Parse Horizontal Dividers
  text = text.replace(/^---$/gim, '<div style="height:1px; background:linear-gradient(90deg, rgba(56,189,248,0.25), rgba(139,92,246,0.25), transparent); margin:12px 0;"></div>');

  // 6. Parse Key-Value Bullet lists (- **Key**: Value)
  text = text.replace(/^- \*\*([^*]+)\*\*:(.*$)/gim, (m, k, v) => {
    return `<div style="display:flex; align-items:baseline; gap:6px; margin:4px 0; padding:4px 8px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.03); border-radius:5px; font-size:0.75rem;"><span style="color:#94a3b8; font-weight:700; min-width:145px;">• ${k}:</span><span style="color:#f8fafc; font-family:var(--font-mono);">${v}</span></div>`;
  });

  // 7. Parse standard bullet points
  text = text.replace(/^- (.*$)/gim, '<div style="display:flex; gap:6px; margin:4px 0; padding-left:4px; font-size:0.75rem; color:#cbd5e1; align-items:center;"><span style="color:#38bdf8; font-size:0.7rem;">•</span><span>$1</span></div>');

  // 8. Parse Inline code and Bold text
  text = text
    .replace(/`([^`]+)`/g, '<code style="background:rgba(56,189,248,0.1); color:#38bdf8; border:1px solid rgba(56,189,248,0.2); padding:1px 5px; border-radius:4px; font-family:var(--font-mono); font-size:0.72rem;">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#ffffff; font-weight:700;">$1</strong>');

  // 9. Line breaks
  text = text.replace(/\n\n/g, '<div style="height:6px;"></div>');

  return frontmatterHtml + `<div style="line-height:1.65; color:#cbd5e1;">${text}</div>`;
};

window.loadSecondBrainNote = async function(filePath) {
  const badge = document.getElementById('sbActiveFileBadge');
  const contentEl = document.getElementById('sbDocContent');
  if (badge) badge.textContent = filePath;
  window._sbActiveFilePath = filePath;
  if (window._sbCurrentTree) renderSecondBrainTree(window._sbCurrentTree);
  if (!contentEl) return;

  try {
    const res = await fetch(`/api/second-brain/file?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (data.success && data.content) {
      contentEl.innerHTML = renderObsidianMarkdown(data.content, filePath);
    } else {
      contentEl.innerHTML = `<div class="empty">${data.error || 'Note not found'}</div>`;
    }
  } catch (e) {
    contentEl.innerHTML = `<div class="empty">Error loading note: ${e.message}</div>`;
  }
};

window.onWikiLinkClick = function(linkName) {
  if (linkName.includes('/')) {
    loadSecondBrainNote(linkName.endsWith('.md') ? linkName : linkName + '.md');
  } else if (['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'NIFTY50', 'BANKNIFTY', 'RELIANCE', 'SPY', 'QQQ', 'EURUSD=X', 'GOLDBEES', 'SILVERBEES', 'Universe-Assets'].includes(linkName)) {
    loadSecondBrainNote(`Assets/${linkName}.md`);
  } else if (['TRENDING_BULL', 'TRENDING_BEAR', 'RANGING_CHOPPY', 'HIGH_VOLATILITY_EXPANSION', 'Market-Regimes'].includes(linkName)) {
    loadSecondBrainNote(`Regimes/${linkName}.md`);
  } else if (['Hermes-Council', 'HTF_Trend_Sentinel', 'Macro_Research_Agent', 'Technical_Vetting_Agent', 'Options_Derivatives_Auditor', 'Volume_Shocker_Sentinel', 'Risk_Reward_Auditor'].includes(linkName)) {
    loadSecondBrainNote(`Agent Debates/${linkName}.md`);
  } else {
    loadSecondBrainNote(`Strategies/${linkName}.md`);
  }
};

window.syncSecondBrainVault = async function() {
  try {
    const res = await fetch('/api/second-brain/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totalCapital: document.getElementById('capEquity')?.textContent || '$10.24',
        dailyPnl: document.getElementById('capPnl')?.textContent || '+$0.24',
        dailyTrades: parseInt(document.getElementById('capTrades')?.textContent || '204'),
        marketRegime: 'TRENDING_BULL'
      })
    });
    const data = await res.json();
    if (data.success) {
      loadSecondBrainTab();
    }
  } catch (e) {
    console.error('Failed to sync second brain vault:', e);
  }
};

window.loadSecondBrainGraph = async function() {
  const canvas = document.getElementById('sbGraphCanvas');
  if (!canvas) return;

  try {
    const res = await fetch('/api/second-brain/graph');
    const data = await res.json();
    if (data.success && data.graph) {
      renderSecondBrainGraph(canvas, data.graph);
    }
  } catch (e) {
    console.error('Failed to load Alpha Graph:', e);
  }
};

window.renderSecondBrainGraph = function(canvas, graph) {
  const container = canvas.parentElement;
  if (!container) return;

  const ctx = canvas.getContext('2d');
  const width = container.clientWidth;
  const height = container.clientHeight;
  canvas.width = width;
  canvas.height = height;

  const rawNodes = graph.nodes || [];
  const rawEdges = graph.edges || [];

  // Setup simulation state on window so it survives re-renders
  if (window._sbGraphAnimId) {
    cancelAnimationFrame(window._sbGraphAnimId);
    window._sbGraphAnimId = null;
  }

  // Camera & View Transform
  let zoom = 1.0;
  let panX = 0;
  let panY = 0;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let draggedNode = null;
  let hoveredNode = null;

  // Initialize node physics bodies with organic scatter
  const centerX = width / 2;
  const centerY = height / 2;
  const nodes = rawNodes.map((n, i) => {
    const angle = (i / rawNodes.length) * 2 * Math.PI + (Math.random() - 0.5) * 0.5;
    const dist = 60 + Math.random() * (Math.min(width, height) * 0.35);
    return {
      ...n,
      x: centerX + Math.cos(angle) * dist,
      y: centerY + Math.sin(angle) * dist,
      vx: (Math.random() - 0.5) * 2,
      vy: (Math.random() - 0.5) * 2,
      radius: n.radius || (n.group.includes('hub') ? 16 : 9),
      mass: n.group.includes('hub') ? 4 : 1
    };
  });

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const edges = rawEdges
    .map(e => ({ ...e, source: nodeMap.get(e.from), target: nodeMap.get(e.to) }))
    .filter(e => e.source && e.target);

  // Adjacency map for instant neighbor illumination
  const adjMap = new Map();
  nodes.forEach(n => adjMap.set(n.id, new Set()));
  edges.forEach(e => {
    adjMap.get(e.source.id)?.add(e.target.id);
    adjMap.get(e.target.id)?.add(e.source.id);
  });

  // Ensure Floating Obsidian Properties Card exists in container
  let popover = document.getElementById('sbGraphPopover');
  if (!popover) {
    popover = document.createElement('div');
    popover.id = 'sbGraphPopover';
    popover.style.cssText = `
      position: absolute;
      display: none;
      z-index: 50;
      width: 290px;
      background: rgba(15, 23, 42, 0.96);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 8px;
      padding: 12px 14px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6), 0 0 1px rgba(255,255,255,0.2);
      pointer-events: none;
      font-family: var(--font-sans);
      transition: opacity 0.15s ease, transform 0.15s ease;
    `;
    container.appendChild(popover);
  }

  // Ensure Floating Graph Toolstrip exists
  let toolstrip = document.getElementById('sbGraphToolstrip');
  if (!toolstrip) {
    toolstrip = document.createElement('div');
    toolstrip.id = 'sbGraphToolstrip';
    toolstrip.style.cssText = `
      position: absolute;
      top: 10px;
      right: 10px;
      display: flex;
      gap: 4px;
      background: rgba(11, 15, 23, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      padding: 3px;
      z-index: 40;
    `;
    toolstrip.innerHTML = `
      <button onclick="window._sbGraphZoomIn()" style="background:transparent; border:none; color:#cbd5e1; font-weight:700; width:24px; height:24px; border-radius:4px; cursor:pointer; display:flex; align-items:center; justify-content:center;" title="Zoom In">➕</button>
      <button onclick="window._sbGraphZoomOut()" style="background:transparent; border:none; color:#cbd5e1; font-weight:700; width:24px; height:24px; border-radius:4px; cursor:pointer; display:flex; align-items:center; justify-content:center;" title="Zoom Out">➖</button>
      <button onclick="window._sbGraphResetView()" style="background:transparent; border:none; color:#cbd5e1; font-weight:700; width:24px; height:24px; border-radius:4px; cursor:pointer; display:flex; align-items:center; justify-content:center;" title="Fit Graph">🎯</button>
    `;
    container.appendChild(toolstrip);
  }

  window._sbGraphZoomIn = () => { zoom = Math.min(zoom * 1.25, 3.5); };
  window._sbGraphZoomOut = () => { zoom = Math.max(zoom * 0.8, 0.4); };
  window._sbGraphResetView = () => { zoom = 1.0; panX = 0; panY = 0; };

  // Physics Simulation Step (Force-Directed Coulomb & Hooke Spring)
  function stepPhysics() {
    const kRepel = 900;
    const kSpring = 0.04;
    const defaultLength = 85;
    const gravity = 0.02;
    const damping = 0.88;

    // 1. Repulsion between all node pairs
    for (let i = 0; i < nodes.length; i++) {
      const n1 = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const n2 = nodes[j];
        const dx = n2.x - n1.x;
        const dy = n2.y - n1.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist < 320) {
          const force = (kRepel * (n1.mass * n2.mass)) / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          n1.vx -= fx / n1.mass;
          n1.vy -= fy / n1.mass;
          n2.vx += fx / n2.mass;
          n2.vy += fy / n2.mass;
        }
      }
    }

    // 2. Spring attraction along edges
    edges.forEach(e => {
      const dx = e.target.x - e.source.x;
      const dy = e.target.y - e.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - defaultLength) * kSpring;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      e.source.vx += fx / e.source.mass;
      e.source.vy += fy / e.source.mass;
      e.target.vx -= fx / e.target.mass;
      e.target.vy -= fy / e.target.mass;
    });

    // 3. Center Gravity & Velocity Update
    nodes.forEach(n => {
      if (n === draggedNode) return;
      const dx = centerX - n.x;
      const dy = centerY - n.y;
      n.vx += dx * gravity;
      n.vy += dy * gravity;

      n.vx *= damping;
      n.vy *= damping;

      n.x += n.vx;
      n.y += n.vy;
    });
  }

  // Screen Coordinate to Canvas Space Transformer
  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;
    const x = (clientX - width / 2 - panX) / zoom + centerX;
    const y = (clientY - height / 2 - panY) / zoom + centerY;
    return { x, y, clientX, clientY };
  }

  // Find node under mouse cursor
  function getNodeAt(x, y) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = x - n.x;
      const dy = y - n.y;
      if (Math.sqrt(dx * dx + dy * dy) <= (n.radius + 6)) {
        return n;
      }
    }
    return null;
  }

  // Mouse / Touch Interaction Listeners
  canvas.onmousedown = (e) => {
    const coords = getCanvasCoords(e);
    const hit = getNodeAt(coords.x, coords.y);
    if (hit) {
      draggedNode = hit;
    } else {
      isDragging = true;
      dragStartX = e.clientX - panX;
      dragStartY = e.clientY - panY;
    }
  };

  window.onmousemove = (e) => {
    if (!canvas.isConnected) return;
    const coords = getCanvasCoords(e);

    if (draggedNode) {
      draggedNode.x = coords.x;
      draggedNode.y = coords.y;
      draggedNode.vx = 0;
      draggedNode.vy = 0;
    } else if (isDragging) {
      panX = e.clientX - dragStartX;
      panY = e.clientY - dragStartY;
    } else {
      const hit = getNodeAt(coords.x, coords.y);
      hoveredNode = hit;
      canvas.style.cursor = hit ? 'pointer' : (isDragging ? 'grabbing' : 'grab');

      // Update Floating Properties Card
      if (hit && popover) {
        const neighbors = adjMap.get(hit.id)?.size || 0;
        popover.style.display = 'block';
        popover.style.left = `${Math.min(coords.clientX + 16, width - 305)}px`;
        popover.style.top = `${Math.min(coords.clientY - 20, height - 190)}px`;
        popover.innerHTML = `
          <div style="font-size:0.62rem; color:#64748b; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:4px; display:flex; justify-content:space-between; align-items:center;">
            <span>› Properties</span>
            <span style="color:#38bdf8; font-size:0.65rem;">🔗 [[${hit.id}]]</span>
          </div>
          <div style="font-size:0.86rem; font-weight:800; color:#fff; margin-bottom:6px; line-height:1.25;">
            ${hit.label || hit.id}
          </div>
          <div style="font-size:0.72rem; font-weight:700; color:#60a5fa; margin-bottom:4px;">
            Overview
          </div>
          <div style="font-size:0.7rem; color:#cbd5e1; line-height:1.45; margin-bottom:8px;">
            • <b>Description:</b> ${hit.description || 'Knowledge Node in Sovereign Trading Matrix'}<br/>
            • <b>Observed Case Count:</b> <span style="font-family:var(--font-mono); color:#38bdf8;">${hit.caseCount || 204}</span><br/>
            • <b>Connected Edges:</b> <span style="font-family:var(--font-mono); color:#10b981;">${neighbors} links</span><br/>
            • <b>Status / Year:</b> <span style="font-family:var(--font-mono);">${hit.year || '2026'} (Active)</span>
          </div>
          <div style="font-size:0.64rem; color:#94a3b8; border-top:1px solid rgba(255,255,255,0.08); padding-top:4px;">
            💡 <i>Click node to open note in Note View</i>
          </div>
        `;
      } else if (popover) {
        popover.style.display = 'none';
      }
    }
  };

  window.onmouseup = () => {
    isDragging = false;
    draggedNode = null;
  };

  canvas.onclick = (e) => {
    const coords = getCanvasCoords(e);
    const hit = getNodeAt(coords.x, coords.y);
    if (hit) {
      // Switch back to note view and load file
      setSecondBrainMode('doc');
      if (hit.group === 'asset' || hit.group === 'asset_hub' || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'NIFTY50', 'BANKNIFTY', 'RELIANCE', 'SPY', 'QQQ', 'EURUSD=X', 'GOLDBEES', 'SILVERBEES'].includes(hit.id)) {
        loadSecondBrainNote(`Assets/${hit.id}.md`);
      } else if (hit.group === 'regime' || hit.group === 'regime_hub') {
        loadSecondBrainNote(`Regimes/${hit.id}.md`);
      } else if (hit.group === 'council') {
        loadSecondBrainNote(`Agent Debates/${hit.id}.md`);
      } else {
        loadSecondBrainNote(`Strategies/${hit.id}.md`);
      }
    }
  };

  canvas.onwheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    zoom = Math.max(0.35, Math.min(4.0, zoom * factor));
  };

  // Main Render Frame
  function draw() {
    if (!canvas.isConnected) return;
    stepPhysics();

    ctx.save();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#06080e';
    ctx.fillRect(0, 0, width, height);

    // Apply Camera Transform
    ctx.translate(width / 2 + panX, height / 2 + panY);
    ctx.scale(zoom, zoom);
    ctx.translate(-centerX, -centerY);

    const isHoverActive = Boolean(hoveredNode);
    const activeNeighbors = hoveredNode ? adjMap.get(hoveredNode.id) : null;

    // 1. Draw Connecting Force Edges
    edges.forEach(e => {
      const isConnectedToHover = hoveredNode && (e.source.id === hoveredNode.id || e.target.id === hoveredNode.id);
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);

      if (isConnectedToHover) {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
        ctx.lineWidth = 1.6 / zoom;
      } else if (isHoverActive) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.lineWidth = 0.5 / zoom;
      } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.lineWidth = 0.8 / zoom;
      }
      ctx.stroke();
    });

    // 2. Draw Nodes
    nodes.forEach(n => {
      const isThisHovered = hoveredNode && n.id === hoveredNode.id;
      const isNeighbor = activeNeighbors && activeNeighbors.has(n.id);
      const isDimmed = isHoverActive && !isThisHovered && !isNeighbor;

      const r = isThisHovered ? n.radius * 1.3 : n.radius;
      const alpha = isDimmed ? 0.2 : 1.0;

      // Outer soft glow ring
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + (isThisHovered ? 6 : 2), 0, 2 * Math.PI);
      ctx.fillStyle = n.color ? `${n.color}${isThisHovered ? '55' : '18'}` : 'rgba(59,130,246,0.15)';
      ctx.fill();

      // Node Body Circle
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = isDimmed ? 'rgba(100, 116, 139, 0.4)' : (n.color || '#3b82f6');
      ctx.globalAlpha = alpha;
      ctx.fill();
      ctx.globalAlpha = 1.0;

      // Node Label (Visible on zoom >= 0.75 or when hovered/neighbor)
      if (zoom >= 0.72 || isThisHovered || isNeighbor || n.group.includes('hub')) {
        ctx.font = `${isThisHovered ? 'bold 11px' : '9px'} Inter, sans-serif`;
        ctx.fillStyle = isThisHovered ? '#ffffff' : (isDimmed ? 'rgba(148, 163, 184, 0.3)' : '#cbd5e1');
        ctx.textAlign = 'center';
        ctx.fillText(n.label || n.id, n.x, n.y + r + (11 / zoom));
      }
    });

    ctx.restore();
    window._sbGraphAnimId = requestAnimationFrame(draw);
  }

  draw();
};

// ── 11. CONSOLE FULLVIEW / MAXIMIZE CONTROLLER ────────────────
window.toggleConsoleMaximize = function() {
  const panel = document.querySelector('.panel.log-panel');
  const icon = document.getElementById('maximizeIcon');
  const btn = document.getElementById('btnMaximizeConsole');
  if (!panel) return;

  panel.classList.toggle('panel-maximized');
  const isMax = panel.classList.contains('panel-maximized');
  
  if (icon) icon.textContent = isMax ? '🗗' : '⛶';
  if (btn) {
    btn.title = isMax ? 'Restore / Exit Fullscreen (Esc)' : 'Maximize / Fullscreen View';
    btn.style.background = isMax ? 'rgba(239, 68, 68, 0.25)' : 'rgba(59, 130, 246, 0.15)';
    btn.style.borderColor = isMax ? 'rgba(239, 68, 68, 0.5)' : 'rgba(59, 130, 246, 0.35)';
    btn.style.color = isMax ? '#f87171' : '#60a5fa';
  }

  // Auto-resize graph & internal components to full display
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
    if (typeof loadSecondBrainGraph === 'function' && document.getElementById('sbGraphView')?.style.display !== 'none') {
      loadSecondBrainGraph();
    }
  }, 80);
};

// ESC key listener to exit maximized fullview
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const panel = document.querySelector('.panel.log-panel');
    if (panel && panel.classList.contains('panel-maximized')) {
      window.toggleConsoleMaximize();
    }
  }
});

// Inject Maximize CSS Rules
(function injectMaximizeStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .panel.log-panel.panel-maximized {
      position: fixed !important;
      top: 50px !important;
      left: 56px !important;
      right: 0 !important;
      bottom: 0 !important;
      width: calc(100vw - 56px) !important;
      height: calc(100vh - 50px) !important;
      max-height: none !important;
      z-index: 999 !important;
      margin: 0 !important;
      border-radius: 0 !important;
      box-shadow: 0 0 60px rgba(0, 0, 0, 0.98) !important;
      background: #080c14 !important;
      border-top: 1px solid rgba(59, 130, 246, 0.3) !important;
      border-left: 1px solid rgba(255, 255, 255, 0.08) !important;
      display: flex !important;
      flex-direction: column !important;
      padding: 0 !important;
    }
    .panel.log-panel.panel-maximized .panel-header {
      padding: 8px 16px !important;
      background: #0d121c !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
      flex-shrink: 0 !important;
    }
    .panel.log-panel.panel-maximized #tabControls {
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
    }

    /* 1. Global Tab Content Panels: 100% Height Fill */
    .panel.log-panel.panel-maximized > div[id^="tabContent"],
    .panel.log-panel.panel-maximized .log-container {
      height: calc(100vh - 105px) !important;
      max-height: calc(100vh - 105px) !important;
      flex: 1 1 auto !important;
      padding: 12px 18px !important;
      display: flex !important;
      flex-direction: column !important;
      overflow-y: auto !important;
      box-sizing: border-box !important;
    }

    /* 2. Global Scrollable Table & List Wrappers: Dynamic Max-Height */
    .panel.log-panel.panel-maximized .trade-table-scroll-wrap,
    .panel.log-panel.panel-maximized .backtest-ledger-wrap,
    .panel.log-panel.panel-maximized .screener-table-wrap,
    .panel.log-panel.panel-maximized .table-scroll-wrap,
    .panel.log-panel.panel-maximized .orderbook-container,
    .panel.log-panel.panel-maximized .tape-container,
    .panel.log-panel.panel-maximized .backtest-results-wrap,
    .panel.log-panel.panel-maximized .depth-table-wrap,
    .panel.log-panel.panel-maximized .vwap-table-wrap,
    .panel.log-panel.panel-maximized .ladder-container,
    .panel.log-panel.panel-maximized .fundamentals-container,
    .panel.log-panel.panel-maximized .futures-table-wrap,
    .panel.log-panel.panel-maximized .pivots-table-wrap,
    .panel.log-panel.panel-maximized .options-chain-table-wrap,
    .panel.log-panel.panel-maximized .news-container,
    .panel.log-panel.panel-maximized .darkpool-table-wrap,
    .panel.log-panel.panel-maximized .arb-table-wrap,
    .panel.log-panel.panel-maximized .basis-table-wrap,
    .panel.log-panel.panel-maximized .pairs-table-wrap,
    .panel.log-panel.panel-maximized .dexcex-table-wrap,
    .panel.log-panel.panel-maximized .mev-table-wrap,
    .panel.log-panel.panel-maximized .crossvenue-table-wrap,
    .panel.log-panel.panel-maximized .earnings-table-wrap,
    .panel.log-panel.panel-maximized .gaps-table-wrap,
    .panel.log-panel.panel-maximized .whales-table-wrap,
    .panel.log-panel.panel-maximized .statpairs-table-wrap {
      max-height: calc(100vh - 215px) !important;
      height: calc(100vh - 215px) !important;
      flex: 1 1 auto !important;
      width: 100% !important;
      min-height: 380px !important;
    }

    /* Universal Fallback for any scrollable sub-container */
    .panel.log-panel.panel-maximized div[style*="overflow-y:auto"],
    .panel.log-panel.panel-maximized div[style*="overflow: auto"],
    .panel.log-panel.panel-maximized div[style*="overflow:auto"] {
      max-height: calc(100vh - 215px) !important;
    }

    /* 3. Global Sub-Areas */
    .panel.log-panel.panel-maximized #backtestResultsArea {
      display: flex !important;
      flex-direction: column !important;
      flex: 1 1 auto !important;
      height: calc(100vh - 170px) !important;
      min-height: 0 !important;
    }

    /* 4. Second Brain Views */
    .panel.log-panel.panel-maximized #sbDocView,
    .panel.log-panel.panel-maximized #sbDocView > div:last-child {
      height: calc(100vh - 165px) !important;
      max-height: calc(100vh - 165px) !important;
    }
    .panel.log-panel.panel-maximized #sbGraphView,
    .panel.log-panel.panel-maximized #sbGraphCanvas {
      height: calc(100vh - 165px) !important;
      max-height: calc(100vh - 165px) !important;
      width: 100% !important;
    }
    .panel.log-panel.panel-maximized #tabContentSecondBrain > div > div:last-child > div:first-child {
      height: calc(100vh - 165px) !important;
    }

    /* 5. Chart & Canvas Containers */
    .panel.log-panel.panel-maximized #equityChartContainer,
    .panel.log-panel.panel-maximized #monteCarloResults {
      height: calc(100vh - 220px) !important;
      max-height: calc(100vh - 220px) !important;
      width: 100% !important;
    }

    /* 6. Tables & Sticky Headers */
    .panel.log-panel.panel-maximized table thead {
      position: sticky !important;
      top: 0 !important;
      z-index: 10 !important;
      background: #0c1118 !important;
    }
  `;
  document.head.appendChild(style);
})();


// ── INIT: Run all improvements after DOM is ready ─────────
function runImprovements() {
  buildGroupedNav();
  patchSwitchConsoleTab();
  enhancePositionsTable();
  fixMilestoneLabels();
  improveLoadingStates();
  improveHeader();
  fixTearsheetOnLoad();
  improveDebateRendering();
  improvePortfolioCards();

  // Guarantee Trade History is active by default on page load/refresh
  setTimeout(() => {
    if (typeof switchSidebarView === 'function') {
      switchSidebarView('trades');
    } else if (typeof switchConsoleTab === 'function') {
      switchConsoleTab('trades');
    }
  }, 50);

  console.log('[TB Improvements v2.0] All enhancements applied ✅');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runImprovements);
} else {
  setTimeout(runImprovements, 100);
}

