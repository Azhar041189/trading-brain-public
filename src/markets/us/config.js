module.exports = {
  id: 'US',
  name: 'US Equities (NYSE/NASDAQ)',
  timezone: 'America/New_York',
  currency: 'USD',
  currencySymbol: '$',
  hours: {
    preMarketStart: '04:00',
    marketOpen: '09:30',
    marketClose: '16:00',
    learning: '16:30'
  },
  defaultWatchlist: [
    'SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META'
  ],
  fractionalTrading: true,
  lotSizes: {}, // 1 share or fractional
  allowShorting: true
};
