module.exports = {
  id: 'FOREX',
  name: 'Foreign Exchange (Currencies)',
  timezone: 'UTC',
  currency: 'USD',
  currencySymbol: '$',
  hours: {
    continuous: false,
    open: 'Sunday 17:00 EST',
    close: 'Friday 17:00 EST'
  },
  defaultWatchlist: [
    'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'USDCAD=X', 'USDCHF=X'
  ],
  lotSizes: {
    standard: 100000,
    mini: 10000,
    micro: 1000
  },
  allowShorting: true
};
