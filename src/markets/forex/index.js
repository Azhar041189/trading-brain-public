const config = require('./config');
const broker = require('./adapters/OandaAdapter');
const dataProvider = require('./adapters/ForexDataProvider');

module.exports = {
  config,
  broker,
  dataProvider
};
