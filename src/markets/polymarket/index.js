const config = require('./config');
const broker = require('./adapters/PolymarketAdapter');
const dataProvider = require('./adapters/PolymarketDataProvider');

module.exports = {
  config,
  broker,
  dataProvider
};
