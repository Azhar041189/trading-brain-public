/**
 * 📡 Yield Copier & Real-Time Signal Broadcaster (Stage 3)
 * 
 * Packages verified institutional signals into cryptographic, authenticated
 * trade payloads for downstream copiers, sub-accounts, or algorithmic execution nodes.
 */

const crypto = require('crypto');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('VaultSignalBroadcaster');

class VaultSignalBroadcaster {
  constructor(config = {}) {
    this.secretKey = config.secretKey || 'brain_vault_copier_secret_2026';
    this.signalHistory = [];
    this.maxHistory = 100;
  }

  /**
   * Package a trade decision into a copier broadcast signal
   */
  broadcastSignal(tradeData) {
    const payload = {
      signalId: `sig_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      venue: tradeData.venue || 'POLYMARKET',
      marketId: tradeData.marketId,
      question: tradeData.question,
      outcome: tradeData.outcome || 'YES',
      targetPrice: tradeData.price,
      maxSlippagePct: tradeData.maxSlippagePct || 1.5, // 1.5% max slippage allowed
      suggestedKellyFraction: tradeData.fractionalKellyFraction || 0.015,
      signature: ''
    };

    // Generate HMAC-SHA256 signature for tamper-proof copier ingestion
    const hash = crypto.createHmac('sha256', this.secretKey)
      .update(JSON.stringify({ marketId: payload.marketId, outcome: payload.outcome, price: payload.targetPrice, time: payload.timestamp }))
      .digest('hex')
      .slice(0, 32);

    payload.signature = hash;

    this.signalHistory.unshift(payload);
    if (this.signalHistory.length > this.maxHistory) {
      this.signalHistory.pop();
    }

    logger.info(`📡 [VaultCopier] Broadcasted trade signal ${payload.signalId} for "${payload.question}" (${payload.outcome} @ ${(payload.targetPrice * 100).toFixed(1)}¢)`);
    return payload;
  }

  getSignals() {
    return this.signalHistory;
  }
}

const vaultSignalBroadcaster = new VaultSignalBroadcaster();
module.exports = { VaultSignalBroadcaster, vaultSignalBroadcaster };
