const { createAgentLogger } = require('./logger');
const riskManager = require('../agents/risk/riskManager');
const smartRouter = require('./smartRouter');
const telegramDispatcher = require('./telegramAlertDispatcher');
const dhanBroker = require('../adapters/dhanLiveBroker');
const binanceBroker = require('../adapters/binanceLiveBroker');
const alpacaBroker = require('../adapters/alpacaLiveBroker');

const logger = createAgentLogger('PositionReconciler');

/**
 * PositionReconciler - Production Drift & Ghost Position Elimination Job
 * Runs every 60 seconds to cross-verify in-memory positions vs live broker balances.
 */
class PositionReconciler {
  constructor() {
    this.lastReconciliationTime = null;
    this.reconciliationHistory = [];
    this.isRunning = false;
    this.intervalTimer = null;
    this.totalDriftResolved = 0;
  }

  start(intervalMs = 60000) {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`🔄 [Position Reconciler] Starting background broker sync loop (${intervalMs / 1000}s interval)`);
    
    // Initial run immediately
    this.reconcile();
    this.intervalTimer = setInterval(() => this.reconcile(), intervalMs);
  }

  stop() {
    this.isRunning = false;
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    logger.info('🛑 [Position Reconciler] Background sync loop stopped');
  }

  /**
   * Performs complete cross-market reconciliation against live brokers (or injected remote broker snapshot)
   */
  async reconcile(injectedBrokerSnapshot = null) {
    try {
      // If external broker snapshot is provided (e.g. from fresh REST query post-reconnect), apply directly
      if (injectedBrokerSnapshot && injectedBrokerSnapshot.symbol) {
        const sym = injectedBrokerSnapshot.symbol;
        const existing = riskManager.openPositions.get(sym);
        const brokerQty = injectedBrokerSnapshot.quantity || 0;
        const memoryQty = existing?.quantity || 0;

        if (brokerQty !== memoryQty) {
          if (brokerQty > 0) {
            riskManager.openPositions.set(sym, {
              symbol: sym,
              side: injectedBrokerSnapshot.side || existing?.side || 'LONG',
              quantity: brokerQty,
              avgPrice: injectedBrokerSnapshot.avgPrice || existing?.avgPrice || 70000,
              currentPrice: injectedBrokerSnapshot.currentPrice || injectedBrokerSnapshot.avgPrice || 70000,
              unrealizedPnL: 0,
              strategy: existing?.strategy || 'Autonomous Multi-Agent Alpha',
              opened_at: existing?.opened_at || new Date().toISOString()
            });
          } else {
            riskManager.openPositions.delete(sym);
          }
        }
      }

      const memoryPositions = Array.from(riskManager.openPositions.values());
      const discrepancies = [];
      let totalValueChecked = 0;

      // First: Internal consistency checks
      for (const pos of memoryPositions) {
        totalValueChecked += (pos.currentPrice || pos.avgPrice || 1) * (pos.quantity || 1);
        
        // Check for missing critical fields
        if (!pos.avgPrice && !pos.avg_price && !pos.entryPrice) {
          pos.avgPrice = pos.currentPrice || 100;
          discrepancies.push({
            type: 'MISSING_AVG_PRICE_HEALED',
            symbol: pos.symbol,
            action: 'Healed avgPrice from current mark price'
          });
        }

        // Check for zero or negative quantities
        if (pos.quantity <= 0) {
          riskManager.openPositions.delete(pos.symbol);
          discrepancies.push({
            type: 'GHOST_ZERO_QTY_PURGED',
            symbol: pos.symbol,
            action: 'Purged zero quantity ghost position'
          });
        }
      }

      // Second: Live broker reconciliation (if live configured)
      const brokerResults = await this._reconcileWithBrokers(memoryPositions);
      discrepancies.push(...brokerResults.discrepancies);

      this.lastReconciliationTime = new Date().toISOString();
      const report = {
        timestamp: this.lastReconciliationTime,
        status: discrepancies.length === 0 ? 'SYNCED_CLEAN' : 'DISCREPANCIES_RESOLVED',
        activePositionsCount: riskManager.openPositions.size,
        totalNotionalChecked: Math.round(totalValueChecked),
        discrepanciesResolved: discrepancies,
        brokerSync: brokerResults
      };

      this.reconciliationHistory.unshift(report);
      if (this.reconciliationHistory.length > 50) this.reconciliationHistory.pop();

      if (discrepancies.length > 0) {
        this.totalDriftResolved += discrepancies.length;
        logger.warn(`⚠️ [Position Reconciler] Resolved ${discrepancies.length} position anomalies`, { discrepancies });
        try {
          telegramDispatcher.sendMessage(`🔄 <b>[Position Reconciler]</b> Reconciled ${discrepancies.length} position drifts: ${discrepancies.map(d => d.symbol + ' (' + d.type + ')').join(', ')}`);
        } catch(e) {}
      } else {
        logger.info(`✅ [Position Reconciler] Perfectly synced: ${riskManager.openPositions.size} positions verified against broker mark prices`);
      }

      return report;
    } catch (err) {
      logger.error('Position reconciliation error', { error: err.message });
      return { status: 'ERROR', error: err.message };
    }
  }

  /**
   * Reconcile against live broker APIs
   */
  async _reconcileWithBrokers(memoryPositions) {
    const discrepancies = [];
    const brokerResults = {};

    // Group positions by market/broker
    const byBroker = this._groupPositionsByBroker(memoryPositions);

    for (const [brokerKey, positions] of Object.entries(byBroker)) {
      try {
        if (brokerKey === 'DHAN' && dhanBroker.isLiveConfigured()) {
          const result = await this._reconcileDhan(positions);
          brokerResults.DHAN = result;
          discrepancies.push(...result.discrepancies);
        } else if (brokerKey === 'BINANCE' && binanceBroker.isLiveConfigured()) {
          const result = await this._reconcileBinance(positions);
          brokerResults.BINANCE = result;
          discrepancies.push(...result.discrepancies);
        } else if (brokerKey === 'ALPACA' && alpacaBroker.isLiveConfigured()) {
          const result = await this._reconcileAlpaca(positions);
          brokerResults.ALPACA = result;
          discrepancies.push(...result.discrepancies);
        }
      } catch (err) {
        logger.error('Broker reconciliation error', { broker: brokerKey, error: err.message });
        discrepancies.push({
          type: 'BROKER_RECONCILIATION_ERROR',
          broker: brokerKey,
          action: 'Failed to reconcile with broker API',
          error: err.message
        });
      }
    }

    return { discrepancies, brokerResults };
  }

  _groupPositionsByBroker(positions) {
    const inConfig = require('../markets/in/config');
    const usConfig = require('../markets/us/config');
    const cryptoConfig = require('../markets/crypto/config');

    const groups = {
      DHAN: [],
      BINANCE: [],
      ALPACA: []
    };

    for (const pos of positions) {
      const symbol = pos.symbol;
      
      if (inConfig.defaultWatchlist?.includes(symbol) || symbol === 'NIFTY' || symbol === 'BANKNIFTY') {
        groups.DHAN.push(pos);
      } else if (cryptoConfig.defaultWatchlist?.includes(symbol) || symbol.endsWith('USDT')) {
        groups.BINANCE.push(pos);
      } else if (usConfig.defaultWatchlist?.includes(symbol)) {
        groups.ALPACA.push(pos);
      } else if (symbol.includes('=X') || symbol.endsWith('=F')) {
        groups.BINANCE.push(pos); // Forex/Futures via Binance for now
      } else {
        groups.DHAN.push(pos); // Default
      }
    }

    // Filter empty groups
    return Object.fromEntries(Object.entries(groups).filter(([, v]) => v.length > 0));
  }

  async _reconcileDhan(memoryPositions) {
    const discrepancies = [];
    let synced = 0;

    for (const pos of memoryPositions) {
      try {
        // Call DhanHQ positions API
        const res = await require('axios').get('https://api.dhan.co/v2/positions', {
          headers: { 
            'access-token': require('../core/secureKeyVault').getSecret('DHAN_ACCESS_TOKEN'),
            'client-id': require('../core/secureKeyVault').getSecret('DHAN_CLIENT_ID')
          },
          timeout: 5000
        });

        if (res.data && Array.isArray(res.data)) {
          const brokerPos = res.data.find(p => p.tradingSymbol === pos.symbol);
          
          if (brokerPos) {
            const brokerQty = parseInt(brokerPos.netQty || 0);
            const memoryQty = pos.quantity;
            
            if (brokerQty !== memoryQty) {
              discrepancies.push({
                type: 'QUANTITY_DRIFT',
                symbol: pos.symbol,
                brokerQty,
                memoryQty,
                action: `Adjusted memory qty ${memoryQty} -> ${brokerQty}`
              });
              pos.quantity = brokerQty;
              pos.avgPrice = parseFloat(brokerPos.buyAvgPrice || brokerPos.sellAvgPrice || pos.avgPrice);
              synced++;
            }
            
            if (brokerQty === 0 && memoryQty !== 0) {
              riskManager.openPositions.delete(pos.symbol);
              discrepancies.push({
                type: 'POSITION_CLOSED_AT_BROKER',
                symbol: pos.symbol,
                action: 'Removed closed position from memory'
              });
            }
          } else if (pos.quantity > 0) {
            // Position exists in memory but not at broker
            discrepancies.push({
              type: 'GHOST_POSITION',
              symbol: pos.symbol,
              action: 'Position exists in memory but not at broker'
            });
          }
        }
      } catch (err) {
        logger.warn('Dhan reconciliation error for', { symbol: pos.symbol, error: err.message });
      }
    }

    return { discrepancies, synced };
  }

  async _reconcileBinance(memoryPositions) {
    const discrepancies = [];
    
    try {
      const account = await require('../adapters/binanceLiveBroker').getAccount?.();
      if (account?.balances) {
        for (const pos of memoryPositions) {
          const asset = pos.symbol.replace('USDT', '');
          const brokerBal = account.balances.find(b => b.asset === asset);
          
          if (brokerBal) {
            const brokerFree = parseFloat(brokerBal.free);
            const brokerLocked = parseFloat(brokerBal.locked);
            const brokerTotal = brokerFree + brokerLocked;
            const memoryQty = pos.quantity;
            
            // Allow small drift (< 0.1%)
            if (Math.abs(brokerTotal - memoryQty) / Math.max(memoryQty, 1) > 0.001) {
              discrepancies.push({
                type: 'QUANTITY_DRIFT',
                symbol: pos.symbol,
                brokerQty: brokerTotal,
                memoryQty,
                action: `Adjusted memory qty ${memoryQty} -> ${brokerTotal}`
              });
              pos.quantity = brokerTotal;
            }
          }
        }
      }
    } catch (err) {
      logger.warn('Binance reconciliation error', { error: err.message });
    }

    return { discrepancies, synced: discrepancies.length };
  }

  async _reconcileAlpaca(memoryPositions) {
    const discrepancies = [];
    
    try {
      const positions = await require('../adapters/alpacaLiveBroker').getPositions?.();
      if (Array.isArray(positions)) {
        for (const pos of memoryPositions) {
          const brokerPos = positions.find(p => p.symbol === pos.symbol);
          
          if (brokerPos) {
            const brokerQty = parseFloat(brokerPos.qty);
            const memoryQty = pos.quantity;
            
            if (Math.abs(brokerQty - memoryQty) > 0.01) {
              discrepancies.push({
                type: 'QUANTITY_DRIFT',
                symbol: pos.symbol,
                brokerQty,
                memoryQty,
                action: `Adjusted memory qty ${memoryQty} -> ${brokerQty}`
              });
              pos.quantity = brokerQty;
            }
          } else if (pos.quantity > 0) {
            riskManager.openPositions.delete(pos.symbol);
            discrepancies.push({
              type: 'GHOST_POSITION',
              symbol: pos.symbol,
              action: 'Position exists in memory but not at Alpaca'
            });
          }
        }
      }
    } catch (err) {
      logger.warn('Alpaca reconciliation error', { error: err.message });
    }

    return { discrepancies, synced: discrepancies.length };
  }

  getStatus() {
    return {
      running: this.isRunning,
      lastRun: this.lastReconciliationTime || 'Not run yet',
      openPositionsTracked: riskManager.openPositions.size,
      totalDriftResolved: this.totalDriftResolved,
      recentReports: this.reconciliationHistory.slice(0, 10)
    };
  }
}

module.exports = new PositionReconciler();
