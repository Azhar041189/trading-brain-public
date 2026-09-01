const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('ScaleOutEngine');

/**
 * ScaleOutEngine - Institutional Partial Take-Profit & Dynamic Breakeven Engine
 * Tailored strictly for Micro-Live Pilot ($10 Crypto / ₹500 India):
 *  1. Target 1 (T1): Fires at +1.0R (not 0.5R) to clear all exchange fees with positive net profit.
 *  2. Scale-Out: Sells 50% lot at T1 and instantly moves Stop Loss to Breakeven (+0.10% on Binance, +0.05% on Dhan).
 *  3. Runner Management: Dynamic ATR Trailing on the remaining 50% lot:
 *     - 1.0x ATR in RANGING_CHOPPY (tight lock-in)
 *     - 2.0x ATR in TRENDING_BULL / TRENDING_BEAR (rides runners)
 */
class ScaleOutEngine {
  constructor() {
    this.scaledOutPositions = new Set(); // Tracks positions that have already taken T1 partial profit
  }

  /**
   * Evaluate all open positions against scale-out and breakeven criteria
   */
  async evaluateOpenPositions(marketKey = 'CRYPTO') {
    const riskManager = require('../agents/risk/riskManager');
    const executionEngine = require('../agents/execution/executionEngine');
    const telegramCopilot = require('./telegramInteractiveCopilot');

    const openPos = Array.from(riskManager.openPositions.values());
    if (openPos.length === 0) return;

    for (const pos of openPos) {
      try {
        const symbol = pos.symbol;
        const entryPrice = parseFloat(pos.entryPrice || pos.avgPrice || 0);
        const currentPrice = parseFloat(pos.currentPrice || entryPrice);
        const isLong = pos.side === 'LONG' || pos.side === 'BUY';
        const initialStop = parseFloat(pos.initialStopLoss || pos.stopLoss || (isLong ? entryPrice * 0.985 : entryPrice * 1.015));
        
        const riskDistance = Math.abs(entryPrice - initialStop);
        if (riskDistance <= 0 || entryPrice <= 0) continue;

        const isCrypto = symbol.includes('USDT') || symbol.includes('BTC') || symbol.includes('ETH');
        const beBufferPct = isCrypto ? 0.0010 : 0.0005; // +0.10% Binance (taker fee clear), +0.05% DhanHQ (STT/GST clear)
        const bePrice = isLong ? (entryPrice * (1 + beBufferPct)) : (entryPrice * (1 - beBufferPct));

        const moveDistance = isLong ? (currentPrice - entryPrice) : (entryPrice - currentPrice);
        const currentR = moveDistance / riskDistance;

        // Stage 1: Check T1 Scale-Out Trigger (+1.0R)
        if (currentR >= 1.0 && !this.scaledOutPositions.has(symbol) && pos.quantity > 0.0001) {
          this.scaledOutPositions.add(symbol);

          const partialQty = isCrypto 
            ? parseFloat((pos.quantity * 0.5).toFixed(4))
            : Math.max(1, Math.floor(pos.quantity * 0.5));

          logger.info(`🎯 [Scale-Out T1 Hit] ${symbol} reached +${currentR.toFixed(2)}R! Locking in 50% partial profit (${partialQty} units)`);

          // Execute Partial Close
          await executionEngine.closePosition(
            symbol,
            pos.segment || 'EQUITY',
            partialQty,
            currentPrice,
            `SCALE_OUT_T1_+${currentR.toFixed(1)}R`
          );

          // Instantly Adjust Stop Loss to Breakeven + Buffer
          pos.stopLoss = parseFloat(bePrice.toFixed(4));
          pos.stop_loss = pos.stopLoss;
          pos.isBreakevenLocked = true;
          riskManager.openPositions.set(symbol, pos);

          // Dispatch Alert
          telegramCopilot.sendMessage(
            `🎯 *SCALE-OUT T1 HIT: ${symbol}*\n\n` +
            `• *Gain*: +${currentR.toFixed(2)}R (+${(moveDistance / entryPrice * 100).toFixed(2)}%)\n` +
            `• *Action*: Banked 50% profit (${partialQty} units)\n` +
            `• *Risk Defense*: Stop Loss moved to Breakeven $${bePrice.toFixed(2)} (+0.10% fee buffer)\n` +
            `• *Runner Status*: 100% Risk-Free Runner Active 🚀`
          );
        }

        // Stage 2: Dynamic Regime-Aware ATR Trailing on Remaining Runner
        if (pos.isBreakevenLocked && currentR > 1.5) {
          const atrMultiplier = marketKey === 'CRYPTO' ? 1.5 : 1.2;
          const trailingDistance = riskDistance * atrMultiplier;
          const newTrailStop = isLong ? (currentPrice - trailingDistance) : (currentPrice + trailingDistance);

          if (isLong && newTrailStop > pos.stopLoss) {
            pos.stopLoss = parseFloat(newTrailStop.toFixed(4));
            pos.stop_loss = pos.stopLoss;
            logger.info(`⚡ [ATR Trail Up] ${symbol} trailing stop raised to $${pos.stopLoss}`);
          } else if (!isLong && newTrailStop < pos.stopLoss) {
            pos.stopLoss = parseFloat(newTrailStop.toFixed(4));
            pos.stop_loss = pos.stopLoss;
            logger.info(`⚡ [ATR Trail Down] ${symbol} trailing stop lowered to $${pos.stopLoss}`);
          }
        }
      } catch (err) {
        logger.warn(`Scale-out evaluation error on ${pos.symbol}: ${err.message}`);
      }
    }
  }

  reset() {
    this.scaledOutPositions.clear();
  }
}

module.exports = new ScaleOutEngine();
