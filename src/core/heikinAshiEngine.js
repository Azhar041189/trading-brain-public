/**
 * HeikinAshiEngine - Converts Standard OHLCV Candles to Heikin-Ashi Smoothed Candles.
 * 
 * Strict Governance Invariant:
 * - VISUALIZATION ONLY: Never use HA Open/Close to compute broker fills, stops, or take-profits.
 * - IMMUTABILITY: Deep-clones input data so the original raw candlestick stream remains untouched.
 * 
 * Formulas:
 * HA Close = (Open + High + Low + Close) / 4
 * HA Open = (Prev HA Open + Prev HA Close) / 2
 * HA High = Max(High, HA Open, HA Close)
 * HA Low = Min(Low, HA Open, HA Close)
 */
class HeikinAshiEngine {
  /**
   * Transform standard OHLCV candles to Heikin-Ashi format without mutating input
   * @param {Array} candles - Array of { open, high, low, close, volume, time/timestamp }
   * @returns {Array} Array of Heikin-Ashi candles with visualOnly metadata
   */
  transform(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return [];

    const haCandles = [];

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const timeVal = c.time || (c.timestamp ? Math.floor(new Date(c.timestamp).getTime() / 1000) : i);

      const rawOpen = parseFloat(c.open);
      const rawHigh = parseFloat(c.high);
      const rawLow = parseFloat(c.low);
      const rawClose = parseFloat(c.close);

      const haClose = (rawOpen + rawHigh + rawLow + rawClose) / 4;
      let haOpen;

      if (i === 0) {
        haOpen = (rawOpen + rawClose) / 2;
      } else {
        const prevHA = haCandles[i - 1];
        haOpen = (prevHA.open + prevHA.close) / 2;
      }

      const haHigh = Math.max(rawHigh, haOpen, haClose);
      const haLow = Math.min(rawLow, haOpen, haClose);

      haCandles.push({
        time: timeVal,
        open: parseFloat(haOpen.toFixed(4)),
        high: parseFloat(haHigh.toFixed(4)),
        low: parseFloat(haLow.toFixed(4)),
        close: parseFloat(haClose.toFixed(4)),
        volume: c.volume || 0,
        rawCandle: {
          open: rawOpen,
          high: rawHigh,
          low: rawLow,
          close: rawClose,
          volume: c.volume || 0
        },
        visualOnly: true,
        executionSafe: false
      });
    }

    return haCandles;
  }
}

module.exports = new HeikinAshiEngine();
