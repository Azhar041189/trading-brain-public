module.exports = {
  id: 'CRYPTO',
  name: 'Cryptocurrency (Spot & Futures)',
  timezone: 'UTC',
  currency: 'USDT',
  currencySymbol: '$',
  is24x7: true,
  hours: {
    continuous: true,
    fundingIntervalHours: 8
  },
  defaultWatchlist: [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT'
  ],
  fractionalTrading: true,
  lotSizes: {},
  allowShorting: true
};
