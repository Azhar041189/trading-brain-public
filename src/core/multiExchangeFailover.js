const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('MultiExchangeFailover');

class MultiExchangeFailover {
  constructor() {
    this.primaryExchange = 'BINANCE';
    this.failoverPriority = ['BINANCE', 'BYBIT', 'OKX', 'COINBASE_PRO'];
    this.exchangeHealth = new Map([
      ['BINANCE', { status: 'ONLINE', latencyMs: 24, lastHeartbeat: Date.now(), errorCount: 0 }],
      ['BYBIT', { status: 'STANDBY', latencyMs: 38, lastHeartbeat: Date.now(), errorCount: 0 }],
      ['OKX', { status: 'STANDBY', latencyMs: 45, lastHeartbeat: Date.now(), errorCount: 0 }],
      ['COINBASE_PRO', { status: 'STANDBY', latencyMs: 52, lastHeartbeat: Date.now(), errorCount: 0 }]
    ]);
    this.activeExchange = 'BINANCE';
  }

  recordHeartbeat(exchange, latencyMs = 25) {
    const curr = this.exchangeHealth.get(exchange) || { errorCount: 0 };
    this.exchangeHealth.set(exchange, {
      status: 'ONLINE',
      latencyMs,
      lastHeartbeat: Date.now(),
      errorCount: 0
    });
  }

  recordError(exchange, errorMsg = '') {
    const curr = this.exchangeHealth.get(exchange) || { errorCount: 0, status: 'ONLINE' };
    curr.errorCount += 1;
    logger.warn(`Exchange heartbeat error on ${exchange} (#${curr.errorCount}): ${errorMsg}`);

    if (curr.errorCount >= 3) {
      curr.status = 'DEGRADED';
      this.triggerFailover(exchange);
    }
  }

  triggerFailover(failedExchange) {
    logger.error(`🚨 [FAILOVER PROTOCOL TRIGGERED] Exchange ${failedExchange} degraded. Routing order execution to secondary venue...`);
    for (const ex of this.failoverPriority) {
      const h = this.exchangeHealth.get(ex);
      if (ex !== failedExchange && h && h.status !== 'DEGRADED') {
        this.activeExchange = ex;
        logger.info(`✅ [Failover Activated] Execution Gateway dynamically switched to ${ex} (Zero Downtime)`);
        break;
      }
    }
  }

  getActiveExchange() {
    return {
      active: this.activeExchange,
      health: Array.from(this.exchangeHealth.entries()).map(([k, v]) => ({ exchange: k, ...v }))
    };
  }
}

module.exports = new MultiExchangeFailover();
