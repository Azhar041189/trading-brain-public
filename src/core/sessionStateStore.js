const fs = require('fs');
const path = require('path');
const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('StateStore');

const DATA_DIR = path.join(__dirname, '../../data');
const STATE_FILE = path.join(DATA_DIR, 'session_state.json');

/**
 * SessionStateStore - Persists all trades, logs, PnL balances, vault milestones,
 * and positions to disk so sessions resume seamlessly upon server restart or login.
 */
class SessionStateStore {
  constructor() {
    this._ensureDataDir();
    this.state = this._loadState();
  }

  _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {
      logger.warn('Could not load session state, starting fresh:', { error: e.message });
    }

    return {
      trades: [],
      signals: [],
      debates: [],
      positions: {},
      logs: [],
      milestones: {
        userSavingsVault: 0,
        agentTradingPool: 10,
        principalReturned: false,
        consecutiveWins: 0,
        consecutiveLosses: 0
      },
      marketPnL: {
        IN: 0,
        CRYPTO: 0,
        US: 0,
        FOREX: 0,
        FUTURES: 0
      },
      compoundedEquity: 10,
      realizedPnL: 0,
      lastSaved: new Date().toISOString()
    };
  }

  saveState(updates = {}) {
    try {
      this.state = {
        ...this.state,
        ...updates,
        lastSaved: new Date().toISOString()
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), 'utf8');
      return { success: true, state: this.state };
    } catch (e) {
      logger.warn('Could not save session state:', { error: e.message });
      return { success: false, error: e.message };
    }
  }

  resetState() {
    const currentRisk = this.state?.maxRiskPerTrade || 0.01;
    const currentConsensus = this.state?.consensusThreshold || 0.82;
    const currentKelly = this.state?.kellyFraction || 0.25;

    this.state = {
      trades: [],
      signals: [],
      debates: [],
      positions: {},
      logs: [],
      milestones: {
        userSavingsVault: 0,
        agentTradingPool: 10,
        principalReturned: false,
        consecutiveWins: 0,
        consecutiveLosses: 0
      },
      marketPnL: {
        IN: 0,
        CRYPTO: 0,
        US: 0,
        FOREX: 0,
        FUTURES: 0
      },
      compoundedEquity: 10,
      realizedPnL: 0,
      maxRiskPerTrade: currentRisk,
      consensusThreshold: currentConsensus,
      kellyFraction: currentKelly,
      lastSaved: new Date().toISOString()
    };
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), 'utf8');
    } catch(e) {}
    return this.state;
  }

  loadState() {
    return this._loadState();
  }

  getState() {
    return this.state;
  }
}

module.exports = new SessionStateStore();
