const config = require('../../config');
const { createAgentLogger } = require('../../core/logger');
const database = require('../../core/database');

const logger = createAgentLogger('RiskManager');

class RiskManager {
  constructor() {
    this.dailyPnL = 0;
    this.dailyTrades = 0;
    this.openPositions = new Map();
    this.sectorExposure = new Map();
    this.correlationMatrix = new Map();
    this.lastResetDate = null;
    this.cooldownMap = new Map(); // Symbol -> Timestamp of last exit
  }

  recordCooldown(symbol, seconds = 300) {
    if (!symbol) return;
    this.cooldownMap.set(symbol, Date.now() + (seconds * 1000));
  }

  isSymbolInCooldown(symbol) {
    if (!symbol || !this.cooldownMap.has(symbol)) return false;
    const expiresAt = this.cooldownMap.get(symbol);
    if (Date.now() < expiresAt) {
      return { inCooldown: true, remainingSecs: Math.ceil((expiresAt - Date.now()) / 1000) };
    }
    this.cooldownMap.delete(symbol);
    return false;
  }

  async initialize() {
    // Load today's state from database
    await this.loadDailyState();
    logger.info('Risk manager initialized');
  }

  async loadDailyState() {
    const today = new Date().toISOString().split('T')[0];
    
    try {
      // 1. Try restoring from persistent sessionStateStore disk file
      const sessionStateStore = require('../../core/sessionStateStore');
      const persisted = sessionStateStore.getState();
      if (persisted) {
        // Only restore daily counters if saved state matches TODAY's date
        if (persisted.date === today || persisted.lastResetDate === today) {
          if (persisted.realizedPnL !== undefined) this.dailyPnL = parseFloat(persisted.realizedPnL);
          if (persisted.dailyTrades !== undefined) this.dailyTrades = parseInt(persisted.dailyTrades);
        } else {
          logger.info(`🌅 [Fresh Day Startup] Resetting daily counters (Previous state was from ${persisted.date || 'prior session'})`);
          this.dailyTrades = 0;
          this.dailyPnL = 0;
        }
        if (persisted.positions && typeof persisted.positions === 'object') {
          for (const [sym, pos] of Object.entries(persisted.positions)) {
            const actualSymbol = pos.symbol || (/^\d+$/.test(sym) ? (pos.securityId || pos.name || sym) : sym);
            const entry = parseFloat(pos.avgPrice || pos.avg_price || pos.entryPrice || pos.entry_price || pos.currentPrice || 0);
            const cur = parseFloat(pos.currentPrice || pos.current_price || entry || 0);
            const isLong = pos.side === 'LONG' || pos.side === 'BUY';
            const pnl = isLong ? (cur - entry) * (pos.quantity || 1) : (entry - cur) * (pos.quantity || 1);
            const pnlPct = entry > 0 ? (isLong ? ((cur - entry) / entry) * 100 : ((entry - cur) / entry) * 100) : 0;

            this.openPositions.set(actualSymbol, {
              symbol: actualSymbol,
              side: isLong ? 'LONG' : 'SHORT',
              quantity: pos.quantity || 1,
              avgPrice: entry,
              avg_price: entry,
              entryPrice: entry,
              entry_price: entry,
              currentPrice: cur,
              current_price: cur,
              unrealizedPnL: parseFloat(pnl.toFixed(2)),
              unrealized_pnl: parseFloat(pnl.toFixed(2)),
              pnl_pct: parseFloat(pnlPct.toFixed(2)),
              strategy: pos.strategy || 'Autonomous Multi-Agent Alpha',
              stopLoss: pos.stopLoss || pos.stop_loss || null,
              stop_loss: pos.stopLoss || pos.stop_loss || null,
              takeProfit: pos.takeProfit || pos.take_profit || null,
              take_profit: pos.takeProfit || pos.take_profit || null,
              sector: pos.sector || this.getSector(sym),
              segment: pos.segment || 'EQUITY',
              opened_at: pos.opened_at || pos.openedAt || new Date().toISOString()
            });
          }
        }
      }

      const result = await database.query(
        `SELECT * FROM daily_pnl WHERE date = $1`,
        [today]
      );
      
      if (result && result.rows && result.rows.length > 0) {
        const row = result.rows[0];
        this.dailyPnL = parseFloat(row.realized_pnl) + parseFloat(row.unrealized_pnl);
        this.dailyTrades = parseInt(row.total_trades);
      }
      
      // Load open positions from DB if available
      const positions = await database.query(
        `SELECT * FROM positions WHERE unrealized_pnl != 0 OR realized_pnl != 0`
      );
      
      if (positions && positions.rows) {
        for (const pos of positions.rows) {
          const entry = parseFloat(pos.avg_price || pos.current_price || 0);
          const cur = parseFloat(pos.current_price || entry);
          const isLong = pos.side === 'LONG' || pos.side === 'BUY';
          const pnl = isLong ? (cur - entry) * (pos.quantity || 1) : (entry - cur) * (pos.quantity || 1);
          this.openPositions.set(pos.symbol, {
            symbol: pos.symbol,
            side: isLong ? 'LONG' : 'SHORT',
            quantity: pos.quantity,
            avgPrice: entry,
            avg_price: entry,
            entryPrice: entry,
            entry_price: entry,
            currentPrice: cur,
            current_price: cur,
            unrealizedPnL: parseFloat(pnl.toFixed(2)),
            unrealized_pnl: parseFloat(pnl.toFixed(2)),
            strategy: pos.strategy || 'Autonomous Multi-Agent Alpha',
            sector: pos.sector || this.getSector(pos.symbol)
          });
        }
      }
      
      this.lastResetDate = today;
    } catch (error) {
      logger.warn('Could not load daily state', { error: error.message });
    }
  }

  // ============ PRE-TRADE CHECKS ============

  async validateTrade(signal, portfolio) {
    const checks = {
      allowed: true,
      reasons: [],
      warnings: [],
      adjustedQuantity: null
    };

    // Check for calendar day rollover and reset daily counter if new day
    const todayStr = new Date().toISOString().split('T')[0];
    if (this.lastResetDate && this.lastResetDate !== todayStr) {
      logger.info(`🌅 [Day Rollover] Resetting daily counters for new calendar day: ${todayStr}`);
      this.dailyTrades = 0;
      this.dailyPnL = 0;
      this.marketDailyPnL = { IN: 0, CRYPTO: 0, US: 0, FOREX: 0, FUTURES: 0 };
      this.lastResetDate = todayStr;
    }

    // Position close or take profit always allowed
    if (signal.strategy === 'position_close' || signal.action === 'CLOSE') {
      return checks;
    }

    // 0. Post-Loss Symbol Cooldown Gate (Anti-Chop & Anti-Revenge Trading Filter)
    const cooldownInfo = this.isSymbolInCooldown(signal.symbol);
    if (cooldownInfo && cooldownInfo.inCooldown) {
      checks.allowed = false;
      checks.reasons.push(`🛡️ [Post-Loss Cooldown Active] ${signal.symbol} paused for ${cooldownInfo.remainingSecs}s to prevent consecutive choppy losses`);
      return checks;
    }

    // 1. Daily loss limit - Measured against market-specific daily PnL
    const smartRouter = require('../../core/smartRouter');
    const sessionStore = require('../../core/sessionStateStore');
    const isIndian = signal.segment === 'NSE_EQ' || signal.segment === 'NSE_FNO' || signal.market === 'IN' || (signal.symbol && (signal.symbol.endsWith('BEES') || this.getMarketForSymbol(signal.symbol) === 'IN'));
    const marketKey = isIndian ? 'IN' : this.getMarketForSymbol(signal.symbol);
    const inCapital = sessionStore.getState().inEquity || 2500;
    const effectiveCapital = isIndian ? inCapital : (portfolio.totalCapital || 1000);
    
    const marketPnL = this.marketDailyPnL?.[marketKey] || 0;
    const dailyLossPct = Math.abs(marketPnL) / effectiveCapital;

    if (marketPnL < 0 && dailyLossPct >= (config.trading.maxDailyLoss || 0.05)) {
      checks.allowed = false;
      checks.reasons.push(`Daily loss limit reached for ${marketKey}: ${(dailyLossPct * 100).toFixed(2)}% >= ${((config.trading.maxDailyLoss || 0.05) * 100).toFixed(2)}%`);
      return checks;
    }

    // 2. Max position size & auto-sizing adjustment
    const isCryptoAsset = marketKey === 'CRYPTO' || (signal.symbol && (signal.symbol.includes('USDT') || signal.symbol.includes('BTC') || signal.symbol.includes('ETH')));
    const maxPosLimitPct = isIndian ? 0.35 : (config.trading.maxPositionSize || 0.20);
    const maxAllowedNotional = effectiveCapital * maxPosLimitPct;
    const positionValue = signal.entryPrice * (signal.quantity || 1);
    const positionPct = positionValue / effectiveCapital;

    if (positionPct > maxPosLimitPct) {
      if (isCryptoAsset) {
        const rawQty = maxAllowedNotional / signal.entryPrice;
        checks.adjustedQuantity = parseFloat(rawQty >= 1 ? rawQty.toFixed(2) : (rawQty >= 0.001 ? rawQty.toFixed(4) : rawQty.toFixed(6)));
        if (checks.adjustedQuantity > 0) {
          checks.warnings.push(`Position size auto-adjusted to safe limit: ${checks.adjustedQuantity} ${signal.symbol}`);
        } else {
          checks.allowed = false;
          checks.reasons.push(`Entry price $${signal.entryPrice} too high for account size ($${effectiveCapital})`);
          return checks;
        }
      } else {
        checks.adjustedQuantity = Math.max(1, Math.floor(maxAllowedNotional / signal.entryPrice));
        if (checks.adjustedQuantity > 0) {
          checks.warnings.push(`Adjusted quantity: ${checks.adjustedQuantity}`);
        } else {
          checks.allowed = false;
          checks.reasons.push(`Position size exceeds max capital limit`);
          return checks;
        }
      }
    }

    // 3. Sector exposure with auto-adjustment
    const activeQty = checks.adjustedQuantity || signal.quantity || 1;
    const effectivePositionValue = signal.entryPrice * activeQty;
    const sector = this.getSector(signal.symbol);
    const currentSectorExposure = this.sectorExposure.get(sector) || 0;
    const maxSectorPct = isCryptoAsset ? 0.60 : (isIndian ? 0.35 : (config.trading.maxSectorExposure || 0.25));
    const newSectorExposure = (currentSectorExposure + effectivePositionValue) / effectiveCapital;
    
    if (newSectorExposure > maxSectorPct) {
      const maxAllowedSectorValue = (effectiveCapital * maxSectorPct) - currentSectorExposure;
      if (maxAllowedSectorValue > 0 && signal.entryPrice > 0) {
        const fittedQty = isIndian 
          ? Math.floor(maxAllowedSectorValue / signal.entryPrice)
          : (maxAllowedSectorValue / signal.entryPrice);
        if (fittedQty >= (isIndian ? 1 : 0.001)) {
          checks.adjustedQuantity = isIndian ? fittedQty : parseFloat(fittedQty.toFixed(4));
          checks.warnings.push(`Sector ${sector} auto-adjusted quantity to ${checks.adjustedQuantity}`);
        } else {
          checks.allowed = false;
          checks.reasons.push(`Sector ${sector} exposure would be ${(newSectorExposure * 100).toFixed(2)}% > ${(maxSectorPct * 100).toFixed(2)}%`);
          return checks;
        }
      } else {
        checks.allowed = false;
        checks.reasons.push(`Sector ${sector} exposure would be ${(newSectorExposure * 100).toFixed(2)}% > ${(maxSectorPct * 100).toFixed(2)}%`);
        return checks;
      }
    }

    // 4. Correlation check
    const correlationRisk = this.checkCorrelation(signal.symbol, signal.direction, portfolio);
    if (correlationRisk > config.trading.maxCorrelation) {
      checks.warnings.push(`High correlation risk: ${correlationRisk.toFixed(2)}`);
    }

    // 5. Hard Cooldown Sentinel (Anti-Churning: 90 seconds timeout on recently closed symbols)
    const cooldownCheck = this.isSymbolInCooldown(signal.symbol);
    if (cooldownCheck && cooldownCheck.inCooldown) {
      checks.allowed = false;
      checks.reasons.push(`Symbol ${signal.symbol} is in anti-churn cooldown (${cooldownCheck.remainingSecs}s remaining)`);
      return checks;
    }

    // 5b. Daily Trade Count Cap per market (Allows 500 trades/day for 24/7 continuous crypto & paper testing)
    const maxDailyTrades = config.trading.maxDailyTrades || (config.trading.paperTrading ? 500 : 100);
    if (this.dailyTrades >= maxDailyTrades) {
      checks.allowed = false;
      checks.reasons.push(`Daily trade limit reached (${this.dailyTrades}/${maxDailyTrades}). Capital preservation mode until next session reset.`);
      logger.warn(`🛑 [Daily Trade Cap] BLOCKED: ${signal.symbol} ${signal.direction} — ${this.dailyTrades}/${maxDailyTrades} trades exhausted for today`);
      return checks;
    }

    // 6. Per-Broker Dedicated Slot Quotas with Dynamic Capital Tier Scaling (4 -> 5 -> 6 Slots)
    const targetMarket = this.getMarketForSymbol(signal.symbol);
    const maxMarketSlots = this.getDynamicSlotLimit(targetMarket, portfolio);
    
    // Count active positions strictly in this specific broker/market pool
    const activeMarketPositions = Array.from(this.openPositions.values()).filter(p => this.getMarketForSymbol(p.symbol) === targetMarket);
    const isMarketFull = activeMarketPositions.length >= maxMarketSlots && !this.openPositions.has(signal.symbol);

    if (isMarketFull) {
      const rotationCheck = this.evaluateRotationCandidate(signal, targetMarket);
      if (rotationCheck.eligible && rotationCheck.targetSymbolToEvict) {
        checks.rotationRequired = true;
        checks.targetSymbolToEvict = rotationCheck.targetSymbolToEvict;
        checks.warnings.push(`Intelligent Rotation (${targetMarket}): Evicting stagnant ${rotationCheck.targetSymbolToEvict} (EV: ${rotationCheck.stagnantEV}) to fund superior ${signal.symbol} (EV: ${rotationCheck.candidateEV})`);
      } else {
        checks.allowed = false;
        checks.reasons.push(`Max concurrent positions reached for ${targetMarket} (${activeMarketPositions.length}/${maxMarketSlots}). ${rotationCheck.reason || 'Preserving margin buffer.'}`);
        return checks;
      }
    }

    // 7. Risk:Reward ratio
    if (signal.riskReward < config.trading.minRiskReward) {
      checks.allowed = false;
      checks.reasons.push(`Risk:Reward ${signal.riskReward.toFixed(2)} below minimum ${config.trading.minRiskReward}`);
      return checks;
    }

    // 8. Max open positions per symbol (Allow opposite direction signal to flip position)
    const existingPos = this.openPositions.get(signal.symbol);
    if (existingPos) {
      const isExistingLong = existingPos.side === 'LONG' || existingPos.side === 'BUY';
      const isSignalLong = signal.direction === 'LONG';
      
      // If signal is in OPPOSITE direction with high confidence, ALLOW IT (Position Flip)
      if (isExistingLong !== isSignalLong && signal.confidence >= 0.70) {
        checks.warnings.push(`Position flip triggered for ${signal.symbol}: ${existingPos.side} -> ${signal.direction}`);
      } else {
        checks.allowed = false;
        checks.reasons.push(`Position already active in ${signal.symbol} (${existingPos.side} @ ${existingPos.avgPrice})`);
        return checks;
      }
    }

    // 9. Confidence threshold (Align with dynamic consensus threshold)
    const consensusEngine = require('../../core/consensusEngine');
    const minConfidenceFloor = consensusEngine.minCompositeScore !== undefined 
      ? consensusEngine.minCompositeScore 
      : (config.trading?.minConfidence || 0.70);
    if (signal.confidence < minConfidenceFloor) {
      checks.allowed = false;
      checks.reasons.push(`Signal confidence ${(signal.confidence * 100).toFixed(0)}% below active threshold ${(minConfidenceFloor * 100).toFixed(0)}%`);
      return checks;
    }

    // 9b. Minimum Risk:Reward Ratio Gate (>= 1.8x)
    const minRR = config.trading?.minRiskReward || 1.8;
    const signalRR = parseFloat(signal.riskReward || 2.0);
    if (signalRR < minRR) {
      checks.allowed = false;
      checks.reasons.push(`Risk/Reward ${signalRR.toFixed(1)}x below safety floor ${minRR.toFixed(1)}x`);
      return checks;
    }

    // 10. Margin check (for F&O)
    if (signal.segment === 'NSE_FNO') {
      const marginRequired = this.estimateMargin(signal);
      if (marginRequired > portfolio.availableMargin * 0.8) {
        checks.allowed = false;
        checks.reasons.push(`Insufficient margin: required ${marginRequired}, available ${portfolio.availableMargin}`);
        return checks;
      }
    }

    return checks;
  }

  // ============ POSITION SIZING ============

  calculatePositionSize(signal, portfolio) {
    const compoundingEngine = require('../../core/compoundingEngine');
    const sessionStateStore = require('../../core/sessionStateStore');
    const smartRouter = require('../../core/smartRouter');
    
    const market = smartRouter.resolveMarketForSignal(signal);
    const defaultSeed = (market === 'IN') ? 500 : 10;
    
    const passedCapital = portfolio?.totalCapital || portfolio?.currentBalance;
    const compoundedEquity = compoundingEngine.getCompoundedEquity();
    const capital = (passedCapital && passedCapital > 0) ? passedCapital : ((compoundedEquity && compoundedEquity > 0) ? compoundedEquity : defaultSeed);

    // Apply Fractional Kelly & Dynamic Reinvestment
    const allocation = compoundingEngine.calculateCompoundedAllocation(signal, undefined, capital);
    let quantity = allocation?.quantity || 1;
    
    const entry = parseFloat(signal.entryPrice || 100);
    const isCrypto = market === 'CRYPTO';

    if (isCrypto) {
      // Hard clamp: Position notional must never exceed 20% of account ($2.00 on $10)
      const maxNotional = Math.max(1, capital * 0.20);
      const maxUnits = maxNotional / entry;
      quantity = Math.min(quantity, maxUnits);
      if (entry > 500) {
        quantity = parseFloat(Math.max(0.001, quantity).toFixed(4));
      } else if (entry > 10) {
        quantity = parseFloat(Math.max(0.01, quantity).toFixed(2));
      } else {
        quantity = Math.max(1, Math.floor(quantity));
      }
    } else {
      // Indian equity: Cap by max position size (40% for micro seed <= ₹1000 to enable low-cost ETF lots, 20% standard)
      const maxAllocPct = capital <= 1000 ? 0.40 : 0.20;
      const maxQtyBySize = Math.max(1, Math.floor((capital * maxAllocPct) / entry));
      quantity = Math.max(1, Math.min(quantity, maxQtyBySize));
    }
    
    // Phase 3: Dynamic Kelly per Regime & Strategy Health Allocation Multiplier (Fail-Closed)
    const regimeSizingMultiplier = {
      'TRENDING_BULL': 1.00,             // 100% of Base Allocation
      'TRENDING_BEAR': 1.00,             // 100% of Base Allocation (Shorting)
      'RANGING_CHOPPY': 0.35,            // 35% Sizing in Chop to prevent friction bleed
      'CONSOLIDATION': 0.35,             // 35% Sizing
      'VOLATILE_CRASH': 0.15,            // 15% Sizing - strict capital preservation
      'HIGH_VOLATILITY_EXPANSION': 0.50, // 50% Sizing
      'REGIME_UNKNOWN': 0.00             // 0% Sizing - Fail Closed Circuit Breaker
    };

    try {
      const regimeClassifier = require('../../core/regimeClassifier');
      const classified = regimeClassifier.classify(signal.symbol, signal.candles);
      const reg = (classified && classified.regime !== 'REGIME_UNKNOWN') 
        ? classified.regime 
        : (regimeClassifier.marketRegimes?.get(market)?.regime || 'TRENDING_BULL');
      let mult = regimeSizingMultiplier[reg] !== undefined ? regimeSizingMultiplier[reg] : 1.00;

      // Exact Strategy ID & Health Allocation Multiplier lookup
      const stratId = signal.strategyId || signal.strategy;
      if (stratId) {
        const strategySentinel = require('../../core/strategyHealthSentinel');
        const strat = strategySentinel.strategies.find(s => 
          s.id === stratId || 
          s.id.toLowerCase() === stratId.toLowerCase() ||
          s.name.toLowerCase() === stratId.toLowerCase()
        );
        if (strat) {
          if (strat.lifecycleStage.includes('PAUSED') || strat.lifecycleStage.includes('VALIDATION') || strat.allocationAction === 'PAUSE_OR_PAPER') {
            return 0; // Hard zero for paused/testing setups
          } else if (strat.allocationAction === 'INCREASE') {
            mult *= 1.25;
          } else if (strat.allocationAction === 'REDUCE_50_PCT') {
            mult *= 0.50;
          }
        }
      }

      if (mult <= 0) return 0;
      quantity = isCrypto ? (quantity * mult) : Math.max(1, Math.floor(quantity * mult || 1));

      // Final Hard Risk Ceiling Cap (Never allow multiplier to exceed 20% of account notional, 40% for micro accounts)
      const maxAllowedNotional = Math.max(1, capital * (capital <= 1000 ? 0.40 : 0.20));
      const currentNotional = quantity * entry;
      if (currentNotional > maxAllowedNotional) {
        quantity = isCrypto ? (maxAllowedNotional / entry) : Math.max(1, Math.floor(maxAllowedNotional / entry));
      }

      // Production LOT_SIZE & Step-size Normalization via ExchangeLotNormalizer
      if (isCrypto) {
        const lotNormalizer = require('../../core/exchangeLotNormalizer');
        quantity = lotNormalizer.normalizeQuantity(signal.symbol, quantity);
      }
    } catch (e) {
      return 0; // Fail closed on calculation error
    }
    
    // Cap by available margin
    if (signal.segment === 'NSE_FNO') {
      const marginPerLot = this.estimateMarginPerLot(signal);
      const avail = portfolio?.availableMargin || (capital * 4);
      const maxQtyByMargin = Math.max(1, Math.floor((avail * 0.5) / marginPerLot) * this.getLotSize(signal.symbol));
      quantity = Math.min(quantity, maxQtyByMargin);
      
      const lotSize = this.getLotSize(signal.symbol);
      const lots = Math.max(1, Math.floor(quantity / lotSize));
      quantity = lots * lotSize;
    }
    
    return quantity > 0 ? quantity : 0;
  }

  // ============ STOP LOSS MANAGEMENT ============

  calculateTrailingStop(signal, currentPrice, highestPrice, lowestPrice) {
    const atr = signal.atr || signal.entryPrice * 0.01;
    const trailMult = config.trading.defaultStopLossAtrMult;
    
    if (signal.direction === 'LONG') {
      const newStop = highestPrice - (atr * trailMult);
      return Math.max(newStop, signal.stopLoss); // Only move up
    } else {
      const newStop = lowestPrice + (atr * trailMult);
      return Math.min(newStop, signal.stopLoss); // Only move down
    }
  }

  checkStopLoss(signal, currentPrice) {
    if (signal.direction === 'LONG') {
      return currentPrice <= signal.stopLoss;
    } else {
      return currentPrice >= signal.stopLoss;
    }
  }

  checkTakeProfit(signal, currentPrice) {
    if (signal.direction === 'LONG') {
      return currentPrice >= signal.takeProfit;
    } else {
      return currentPrice <= signal.takeProfit;
    }
  }

  // ============ PORTFOLIO HEAT MAP ============

  getPortfolioHeat(portfolio) {
    const heat = {
      totalExposure: 0,
      sectorExposure: {},
      correlationRisk: 'low',
      dailyPnL: this.dailyPnL,
      dailyPnLPct: portfolio.totalCapital > 0 ? (this.dailyPnL / portfolio.totalCapital * 100).toFixed(2) : 0,
      openPositions: this.openPositions.size,
      marginUsed: 0,
      marginAvailable: portfolio.availableMargin
    };

    for (const [symbol, pos] of this.openPositions) {
      const posValue = Math.abs(pos.quantity * pos.currentPrice);
      heat.totalExposure += posValue;
      
      const sector = pos.sector || 'unknown';
      heat.sectorExposure[sector] = (heat.sectorExposure[sector] || 0) + posValue;
      
      if (pos.segment === 'NSE_FNO') {
        heat.marginUsed += this.estimateMargin({ 
          symbol, 
          quantity: pos.quantity, 
          entryPrice: pos.avgPrice,
          segment: 'NSE_FNO'
        });
      }
    }

    heat.totalExposurePct = portfolio.totalCapital > 0 ? (heat.totalExposure / portfolio.totalCapital * 100).toFixed(2) : 0;
    
    // Convert sector exposure to percentages
    for (const sector of Object.keys(heat.sectorExposure)) {
      heat.sectorExposure[sector] = portfolio.totalCapital > 0 
        ? (heat.sectorExposure[sector] / portfolio.totalCapital * 100).toFixed(2) 
        : 0;
    }

    return heat;
  }

  // ============ HELPERS ============

  getSector(symbol) {
    if (!symbol) return 'other';
    const sym = symbol.toUpperCase();

    // Commodities & ETFs
    if (sym === 'GOLDBEES' || sym === 'SILVERBEES') return 'commodities_etf';
    if (sym.endsWith('BEES')) return 'index_etf';
    if (sym === 'GC=F' || sym === 'SI=F') return 'precious_metals_futures';
    if (sym === 'CL=F' || sym === 'NG=F') return 'energy_futures';
    if (sym === 'ES=F' || sym === 'NQ=F' || sym === 'YM=F' || sym === 'ZB=F') return 'equity_index_futures';

    // Crypto
    if (['BTCUSDT', 'ETHUSDT'].includes(sym)) return 'crypto_major';
    if (['SOLUSDT', 'BNBUSDT', 'AVAXUSDT', 'ADAUSDT', 'DOTUSDT', 'NEARUSDT'].includes(sym)) return 'crypto_l1';
    if (['DOGEUSDT', 'SHIBUSDT', 'PEPEUSDT'].includes(sym)) return 'crypto_meme';
    if (['XRPUSDT', 'XLMUSDT'].includes(sym)) return 'crypto_payment';

    // Equities Sectors
    const sectors = {
      'RELIANCE': 'energy', 'ONGC': 'energy', 'IOC': 'energy', 'BPCL': 'energy', 'GAIL': 'energy',
      'HDFCBANK': 'financial', 'ICICIBANK': 'financial', 'SBIN': 'financial', 'KOTAKBANK': 'financial', 'AXISBANK': 'financial', 'PNB': 'financial',
      'TCS': 'technology', 'INFY': 'technology', 'HCLTECH': 'technology', 'WIPRO': 'technology', 'TECHM': 'technology',
      'SUNPHARMA': 'healthcare', 'DRREDDY': 'healthcare', 'CIPLA': 'healthcare', 'DIVISLAB': 'healthcare', 'APOLLOHOSP': 'healthcare',
      'MARUTI': 'auto', 'TATAMOTORS': 'auto', 'M&M': 'auto', 'BAJAJ-AUTO': 'auto', 'EICHERMOT': 'auto', 'HEROMOTOCO': 'auto',
      'HINDUNILVR': 'fmcg', 'ITC': 'fmcg', 'NESTLEIND': 'fmcg', 'BRITANNIA': 'fmcg', 'TATACONSUM': 'fmcg',
      'LT': 'infrastructure', 'ADANIPORTS': 'infrastructure', 'ADANIENT': 'infrastructure', 'TITAGARH': 'railways_infra', 'JWL': 'railways_infra',
      'BAJFINANCE': 'financial', 'BAJAJFINSV': 'financial', 'CHOLAFIN': 'financial', 'SHRIRAMFIN': 'financial', 'JIOFIN': 'financial',
      'LICI': 'insurance', 'HDFCLIFE': 'insurance', 'SBILIFE': 'insurance',
      'COALINDIA': 'mining', 'NMDC': 'mining', 'HINDALCO': 'metals', 'TATASTEEL': 'metals', 'JSWSTEEL': 'metals', 'HINDCOPPER': 'metals',
      'HAL': 'defense', 'BEL': 'defense',
      'ZOMATO': 'consumer_tech', 'SUZLON': 'renewable_energy', 'CROMPTON': 'consumer_durables', 'TRENT': 'retail',
      'NIFTY': 'index', 'BANKNIFTY': 'index', 'FINNIFTY': 'index', 'MIDCPNIFTY': 'index',
      'AAPL': 'us_tech', 'MSFT': 'us_tech', 'NVDA': 'us_semis', 'TSLA': 'us_auto_tech', 'AMZN': 'us_consumer_tech', 'META': 'us_social_tech', 'GOOGL': 'us_search_ai', 'SPY': 'us_index', 'QQQ': 'us_index'
    };
    return sectors[sym] || 'equity_general';
  }

  checkCorrelation(symbol, direction, portfolio) {
    // Cross-Asset Correlation Clusters (Crypto & Equities)
    const correlationClusters = {
      'BTCUSDT': ['ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'AVAXUSDT'],
      'ETHUSDT': ['BTCUSDT', 'SOLUSDT', 'AVAXUSDT'],
      'SOLUSDT': ['BTCUSDT', 'ETHUSDT', 'AVAXUSDT'],
      'RELIANCE': ['NIFTY', 'ICICIBANK', 'HDFCBANK'],
      'HDFCBANK': ['BANKNIFTY', 'ICICIBANK', 'KOTAKBANK'],
      'NVDA': ['QQQ', 'MSFT', 'AAPL', 'AMD'],
      'SPY': ['QQQ', 'AAPL', 'MSFT']
    };

    const related = correlationClusters[symbol] || [];
    let correlatedCount = 0;

    for (const pos of this.openPositions.values()) {
      if (related.includes(pos.symbol) && (pos.side === direction || pos.side === (direction === 'LONG' ? 'BUY' : 'SELL'))) {
        correlatedCount++;
      }
    }

    const sector = this.getSector(symbol);
    const sectorPositions = Array.from(this.openPositions.values()).filter(p => p.sector === sector);
    const sameDirection = sectorPositions.filter(p => p.side === direction).length;
    
    return Math.max(correlatedCount / 4, sectorPositions.length > 0 ? sameDirection / sectorPositions.length : 0);
  }

  getMarketForSymbol(symbol) {
    if (!symbol) return 'CRYPTO';
    if (symbol.endsWith('BEES') || ['NIFTY', 'BANKNIFTY', 'RELIANCE', 'HDFCBANK', 'TCS', 'INFY', 'SBIN', 'ICICIBANK', 'TATAMOTORS', 'PNB'].includes(symbol)) return 'IN';
    if (['AAPL', 'NVDA', 'TSLA', 'SPY', 'QQQ', 'MSFT', 'AMZN', 'GOOGL'].includes(symbol)) return 'US';
    if (symbol.includes('=X') || ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'].some(f => symbol.includes(f))) return 'FOREX';
    if (symbol.includes('=F') || ['ES', 'NQ', 'CL', 'GC', 'SI'].some(f => symbol.startsWith(f))) return 'FUTURES';
    return 'CRYPTO';
  }

  getDynamicSlotLimit(targetMarket, portfolio) {
    // If explicitly configured in environment variables, prioritize manual override
    if (process.env.MAX_CONCURRENT_POSITIONS) {
      return parseInt(process.env.MAX_CONCURRENT_POSITIONS, 10);
    }

    const capital = portfolio?.totalCapital || portfolio?.equity || (targetMarket === 'IN' ? 500 : 10);

    // Auto-scale capacity based on live account equity tier:
    // Tier 1 Micro: 4 Slots (<= ₹10,000 / <= $250)
    // Tier 2 Growth: 5 Slots (₹10,000 - ₹50,000 / $250 - $1,000)
    // Tier 3 Compounding: 6 Slots (>= ₹50,000 / >= $1,000)
    if (targetMarket === 'IN') {
      if (capital >= 50000) return 6;
      if (capital >= 10000) return 5;
      return 4;
    } else {
      if (capital >= 1000) return 6;
      if (capital >= 250) return 5;
      return 4;
    }
  }

  evaluateRotationCandidate(candidateSignal, targetMarket = 'CRYPTO') {
    const candidateEV = (candidateSignal.confidence || 0.75) * (candidateSignal.riskReward || 2.0);
    // Hard threshold: Candidate must have high alpha conviction (Conf >= 85% & RR >= 2.0)
    if ((candidateSignal.confidence || 0) < 0.85 || (candidateSignal.riskReward || 0) < 2.0) {
      return { eligible: false, reason: 'Incoming candidate conviction below rotation threshold (Requires Conf >= 85% & RR >= 2.0)' };
    }

    let weakestCandidate = null;
    let lowestEV = Infinity;

    for (const [sym, pos] of this.openPositions.entries()) {
      // Isolate to the same broker/market pool
      if (this.getMarketForSymbol(sym) !== targetMarket) {
        continue;
      }

      // 1. NON-EVICTABLE RUNNER INVARIANT:
      // If position has floating profit >= +0.50%, it is a PROTECTED RUNNER. Never evict.
      const entryP = parseFloat(pos.avgPrice || pos.avg_price || pos.entryPrice || 0);
      const curP = parseFloat(pos.currentPrice || pos.current_price || entryP);
      const pnlPct = entryP > 0 ? (pos.side === 'LONG' || pos.side === 'BUY' ? (curP - entryP) / entryP : (entryP - curP) / entryP) : 0;
      
      if (pnlPct >= 0.005) {
        continue; // Protected winning runner
      }

      // 2. STAGNATION & THESIS CHECK:
      // Position is near breakeven / flat (-0.5% to +0.2%)
      const existingEV = (pos.confidence || 0.70) * (pos.riskReward || 1.8);

      // 3. MATERIAL EV DELTA:
      // Candidate must offer at least 20% higher expected value than existing stagnant position
      if (candidateEV > existingEV * 1.20 && pnlPct < 0.003) {
        if (existingEV < lowestEV) {
          lowestEV = existingEV;
          weakestCandidate = sym;
        }
      }
    }

    if (weakestCandidate) {
      return {
        eligible: true,
        targetSymbolToEvict: weakestCandidate,
        candidateEV: candidateEV.toFixed(2),
        stagnantEV: lowestEV.toFixed(2)
      };
    }

    return { eligible: false, reason: `All active open ${targetMarket} positions are protected runners or have superior expected value` };
  }

  estimateMargin(signal) {
    // Rough margin estimation for F&O
    const lotSize = this.getLotSize(signal.symbol);
    const lots = Math.ceil(signal.quantity / lotSize);
    
    // Approximate margins (varies by broker and volatility)
    const marginPerLot = {
      'NIFTY': 180000,
      'BANKNIFTY': 200000,
      'FINNIFTY': 150000,
      'MIDCPNIFTY': 250000
    };
    
    const baseMargin = marginPerLot[signal.symbol] || signal.entryPrice * lotSize * 0.15;
    return baseMargin * lots;
  }

  estimateMarginPerLot(signal) {
    const marginPerLot = {
      'NIFTY': 180000,
      'BANKNIFTY': 200000,
      'FINNIFTY': 150000,
      'MIDCPNIFTY': 250000
    };
    return marginPerLot[signal.symbol] || signal.entryPrice * this.getLotSize(signal.symbol) * 0.15;
  }

  getLotSize(symbol) {
    const lotSizes = {
      'NIFTY': 65, 'BANKNIFTY': 30, 'FINNIFTY': 60, 'MIDCPNIFTY': 120,
      'RELIANCE': 250, 'HDFCBANK': 550, 'ICICIBANK': 1375, 'SBIN': 3000,
      'TCS': 175, 'INFY': 600, 'HINDUNILVR': 300, 'ITC': 3200
    };
    return lotSizes[symbol] || 1;
  }

  // ============ DAILY RESET ============

  async resetDaily() {
    const today = new Date().toISOString().split('T')[0];
    if (this.lastResetDate === today) return;
    
    this.dailyPnL = 0;
    this.dailyTrades = 0;
    this.lastResetDate = today;
    
    // Save to database
    await database.query(
      `INSERT INTO daily_pnl (date, starting_capital, ending_capital, realized_pnl, unrealized_pnl, total_trades)
       VALUES ($1, $2, $2, 0, 0, 0)
       ON CONFLICT (date) DO UPDATE SET starting_capital = $2, ending_capital = $2`,
      [today, 100000] // Would get from portfolio
    ).catch(() => {});
    
    logger.info('Daily risk state reset');
  }

  // ============ P&L TRACKING ============

  async updatePnL(realizedPnL, unrealizedPnL) {
    this.dailyPnL = realizedPnL + unrealizedPnL;
    
    const today = new Date().toISOString().split('T')[0];
    await database.query(
      `UPDATE daily_pnl SET realized_pnl = $1, unrealized_pnl = $2, ending_capital = $3
       WHERE date = $4`,
      [realizedPnL, unrealizedPnL, 100000 + realizedPnL + unrealizedPnL, today]
    ).catch(() => {});
  }

  updateMarkToMarket(symbol, currentPrice) {
    const pos = this.openPositions.get(symbol);
    if (!pos || !currentPrice) return null;
    const cur = parseFloat(currentPrice);
    const entry = parseFloat(pos.avgPrice || pos.avg_price || pos.entryPrice || pos.entry_price || cur);
    const isLong = pos.side === 'LONG' || pos.side === 'BUY';
    const pnl = isLong ? (cur - entry) * (pos.quantity || 1) : (entry - cur) * (pos.quantity || 1);
    const pnlPct = entry > 0 ? (isLong ? ((cur - entry) / entry) * 100 : ((entry - cur) / entry) * 100) : 0;

    pos.currentPrice = cur;
    pos.current_price = cur;
    pos.avgPrice = entry;
    pos.avg_price = entry;
    pos.entryPrice = entry;
    pos.entry_price = entry;
    pos.unrealizedPnL = parseFloat(pnl.toFixed(2));
    pos.unrealized_pnl = parseFloat(pnl.toFixed(2));
    pos.pnl_pct = parseFloat(pnlPct.toFixed(2));
    return pos;
  }

  async recordTrade(trade) {
    this.dailyTrades++;
    
    // Update position tracking for both LONG and SHORT trades (Handles partial fills and additions)
    const key = trade.symbol;
    if (trade.action === 'OPEN' || trade.action === 'ADD') {
      const price = parseFloat(trade.price || trade.avgPrice || trade.avg_price || trade.entryPrice || trade.entry_price || 0);
      const isLong = trade.direction === 'LONG' || trade.side === 'BUY';
      const existing = this.openPositions.get(key);

      let finalQty = trade.quantity;
      let finalAvgPrice = price;

      if (existing) {
        // Accumulate partial fill with weighted average entry price
        finalQty = parseFloat((existing.quantity + trade.quantity).toFixed(4));
        finalAvgPrice = parseFloat((((existing.quantity * existing.avgPrice) + (trade.quantity * price)) / finalQty).toFixed(2));
      }

      const posObj = {
        symbol: trade.symbol,
        side: isLong ? 'LONG' : 'SHORT',
        quantity: finalQty,
        avgPrice: finalAvgPrice,
        avg_price: finalAvgPrice,
        entryPrice: finalAvgPrice,
        entry_price: finalAvgPrice,
        currentPrice: price,
        current_price: price,
        unrealizedPnL: 0,
        unrealized_pnl: 0,
        pnl_pct: 0,
        strategy: trade.strategy || 'Autonomous Multi-Agent Alpha',
        stopLoss: trade.stopLoss || trade.stop_loss || null,
        stop_loss: trade.stopLoss || trade.stop_loss || null,
        takeProfit: trade.takeProfit || trade.take_profit || null,
        take_profit: trade.takeProfit || trade.take_profit || null,
        sector: this.getSector(trade.symbol),
        segment: trade.segment || 'EQUITY',
        opened_at: existing?.opened_at || trade.opened_at || new Date().toISOString()
      };
      this.openPositions.set(key, posObj);
    } else if (trade.action === 'CLOSE') {
      const existing = this.openPositions.get(key);
      const exitPrice = parseFloat(trade.price || trade.exitPrice || trade.avgPrice || (existing ? existing.currentPrice : 0));
      const entryPrice = existing ? parseFloat(existing.entryPrice || existing.avgPrice || exitPrice) : exitPrice;
      const qty = existing ? parseFloat(existing.quantity || 1) : parseFloat(trade.quantity || 1);
      const isLong = existing ? (existing.side === 'LONG' || existing.side === 'BUY') : (trade.direction === 'LONG' || trade.side === 'BUY');
      
      // Calculate Gross PnL
      const grossPnL = isLong ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
      
      // Realistic Exchange Fee Accounting (0.075% taker fee on notional turn-over)
      const notionalTurnover = (entryPrice * qty) + (exitPrice * qty);
      const feeRate = 0.00075;
      const totalFees = parseFloat((notionalTurnover * feeRate).toFixed(4));
      const netPnL = parseFloat((grossPnL - totalFees).toFixed(4));
      const pnlPct = entryPrice > 0 ? parseFloat(((grossPnL / (entryPrice * qty)) * 100).toFixed(2)) : 0;

      // Update Realized Daily PnL
      this.dailyPnL = parseFloat((this.dailyPnL + netPnL).toFixed(4));
      const marketKey = this.getMarketForSymbol(trade.symbol);
      this.marketDailyPnL = this.marketDailyPnL || { IN: 0, CRYPTO: 0, US: 0, FOREX: 0, FUTURES: 0 };
      this.marketDailyPnL[marketKey] = parseFloat(((this.marketDailyPnL[marketKey] || 0) + netPnL).toFixed(4));

      // Record 5-minute symbol cooldown to prevent churning
      this.recordCooldown(trade.symbol, 300);

      // Record to Compounding Engine
      try {
        const compoundingEngine = require('../../core/compoundingEngine');
        compoundingEngine.recordTradePnL(netPnL, marketKey);
      } catch (e) {}

      // Record to Proof-of-Trade Ledger & Closed Trades History
      try {
        const fs = require('fs');
        const path = require('path');
        const crypto = require('crypto');
        const ledgerPath = path.join(process.cwd(), 'data', 'proof_of_trade_ledger.json');
        
        let ledger = [];
        if (fs.existsSync(ledgerPath)) {
          try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch (e) { ledger = []; }
        }
        if (!Array.isArray(ledger)) ledger = [];

        const prevHash = ledger.length > 0 ? (ledger[ledger.length - 1].hash || '0'.repeat(32)) : 'genesis_hash_proof_2026';
        const tradeData = {
          symbol: trade.symbol,
          direction: isLong ? 'LONG' : 'SHORT',
          entryPrice,
          exitPrice,
          quantity: qty,
          grossPnL,
          fees: totalFees,
          netPnL,
          pnlPct,
          strategy: trade.strategy || (existing ? existing.strategy : 'Autonomous Multi-Agent Alpha'),
          openedAt: existing ? existing.opened_at : new Date().toISOString(),
          closedAt: new Date().toISOString(),
          market: marketKey
        };

        const blockHash = crypto.createHash('sha256').update(JSON.stringify(tradeData) + prevHash).digest('hex');
        ledger.push({
          index: ledger.length,
          timestamp: new Date().toISOString(),
          eventType: 'TRADE_CLOSED',
          data: tradeData,
          previousHash: prevHash,
          hash: blockHash
        });

        // Cap ledger to last 1000 blocks to prevent memory/file bloat
        if (ledger.length > 1000) ledger = ledger.slice(-1000);
        fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');

        logger.info(`📝 [Trade Ledger] Closed ${trade.symbol} ${tradeData.direction} | Gross: $${grossPnL.toFixed(2)} | Fees: $${totalFees.toFixed(2)} | Net PnL: $${netPnL.toFixed(2)} (${pnlPct}%)`);
      } catch (e) {
        logger.error(`Failed to record closed trade to ledger: ${e.message}`);
      }

      this.openPositions.delete(key);
    }

    // Persist to session state store disk file
    try {
      const sessionStateStore = require('../../core/sessionStateStore');
      const positionsObj = {};
      for (const [sym, pos] of this.openPositions) {
        positionsObj[sym] = pos;
      }
      sessionStateStore.saveState({
        date: new Date().toISOString().split('T')[0],
        lastResetDate: this.lastResetDate || new Date().toISOString().split('T')[0],
        positions: positionsObj,
        dailyTrades: this.dailyTrades,
        realizedPnL: this.dailyPnL,
        marketDailyPnL: this.marketDailyPnL
      });
    } catch (e) {}
  }
}

module.exports = new RiskManager();