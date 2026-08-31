module.exports = {
  id: 'POLYMARKET',
  name: 'Polymarket Prediction Markets (CLOB Sandbox)',
  timezone: 'UTC',
  currency: 'pUSD',
  currencySymbol: '$',
  is24x7: true,
  isPredictionMarket: true,
  paperTradingOnly: true,
  hours: {
    continuous: true
  },
  defaultWatchlist: [
    'FED_DEC_RATE_CUT_2026',
    'BTC_100K_2026',
    'US_RECESSION_2026',
    'ETH_ETF_FLOW_NET_POS'
  ],
  fractionalTrading: true,
  lotSizes: {},
  allowShorting: true
};
