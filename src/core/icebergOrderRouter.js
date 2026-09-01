const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('IcebergRouter');

/**
 * IcebergOrderRouter - Slices large compounded orders into smaller stealth
 * TWAP / VWAP sub-orders to avoid market impact and slippage.
 */
class IcebergOrderRouter {
  /**
   * Slice order into stealth sub-clips
   */
  sliceOrder(symbol, totalQuantity, displayClips = 5) {
    const clipSize = Math.max(1, Math.floor(totalQuantity / displayClips));
    const remainder = totalQuantity % displayClips;

    const clips = [];
    for (let i = 0; i < displayClips; i++) {
      const qty = i === displayClips - 1 ? clipSize + remainder : clipSize;
      clips.push({
        clipNumber: i + 1,
        quantity: qty,
        delayMs: i * 800,
        status: 'READY'
      });
    }

    logger.info(`🧊 [Iceberg Router] Sliced ${totalQuantity}x ${symbol} into ${displayClips} stealth clips of ~${clipSize} qty each`);
    return {
      symbol,
      totalQuantity,
      displayClips,
      clips,
      strategy: 'STEALTH_TWAP_SLICING'
    };
  }
}

module.exports = new IcebergOrderRouter();
