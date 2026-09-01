require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const config = {
  dhan: {
    clientId: process.env.DHAN_CLIENT_ID,
    accessToken: process.env.DHAN_ACCESS_TOKEN,
    partnerToken: process.env.DHAN_PARTNER_TOKEN,
    baseUrl: 'https://api.dhan.co/v2',
    wsUrl: process.env.DHAN_WS_URL || 'wss://api-feed.dhan.co'
  },
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    name: process.env.DB_NAME || 'trading_brain',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || ''
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined
  },
  nse: {
    baseUrl: process.env.NSE_API_BASE || 'https://www.nseindia.com/api',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.nseindia.com/'
    }
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  },
  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL,
    username: 'Trading Brain',
    avatarUrl: 'https://i.imgur.com/TradingBrain.png'
  },
  trading: {
    maxRiskPerTrade: parseFloat(process.env.MAX_RISK_PER_TRADE) || 0.02,
    maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS) || 0.025, // Hard -2.5% Daily Loss Circuit Breaker
    maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES) || (process.env.PAPER_TRADING !== 'false' ? 500 : 100), // 500 for paper testing, 100 for live
    maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS) || 4, // Max 4 concurrent live positions
    maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE) || 0.25, // 25% max per position ($12.50 on $50 capital)
    maxSectorExposure: parseFloat(process.env.MAX_SECTOR_EXPOSURE) || 0.50,
    maxCorrelation: parseFloat(process.env.MAX_CORRELATION) || 0.7,
    minRiskReward: parseFloat(process.env.MIN_RISK_REWARD) || 2.2,
    defaultStopLossAtrMult: parseFloat(process.env.DEFAULT_STOP_LOSS_ATR_MULT) || 1.8,
    defaultTakeProfitAtrMult: parseFloat(process.env.DEFAULT_TAKE_PROFIT_ATR_MULT) || 3.8,
    marketOpen: process.env.MARKET_OPEN || '09:15',
    marketClose: process.env.MARKET_CLOSE || '15:30',
    preMarketStart: process.env.PRE_MARKET_START || '06:30',
    preOpenStart: process.env.PRE_OPEN_START || '09:00',
    preOpenEnd: process.env.PRE_OPEN_END || '09:07',
    paperTrading: process.env.PAPER_TRADING !== 'false',
    initialCapital: parseFloat(process.env.INITIAL_CAPITAL) || 50.0 // Default $50.00 Capital
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || './logs'
  }
};

module.exports = config;