module.exports = {
  id: 'FUTURES',
  name: 'Global Futures & Commodities (CME/NYMEX)',
  timezone: 'America/Chicago',
  currency: 'USD',
  currencySymbol: '$',
  hours: {
    continuous: false,
    open: '17:00 CST',
    close: '16:00 CST'
  },
  defaultWatchlist: [
    'ES=F', 'NQ=F', 'YM=F', 'CL=F', 'GC=F', 'SI=F', 'ZB=F'
  ],
  lotSizes: {
    'ES=F': 50,
    'NQ=F': 20,
    'CL=F': 1000,
    'GC=F': 100
  },
  allowShorting: true
};
