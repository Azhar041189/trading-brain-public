const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('GraphContagion');

/**
 * GraphContagionEngine
 * Graph Neural Network (GNN) style cross-asset knowledge graph modeling
 * supply-chain interdependencies, currency pass-through, and sector contagion.
 */
class GraphContagionEngine {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
    this.initGraphTopology();
  }

  initGraphTopology() {
    // Define Asset Nodes
    const assetNodes = [
      { id: 'NVDA', type: 'EQUITY_US', sector: 'Semiconductors', beta: 1.45 },
      { id: 'AAPL', type: 'EQUITY_US', sector: 'Consumer Hardware', beta: 1.10 },
      { id: 'MSFT', type: 'EQUITY_US', sector: 'Enterprise Cloud', beta: 1.05 },
      { id: 'TSLA', type: 'EQUITY_US', sector: 'EV / Robotics', beta: 1.65 },
      { id: 'NIFTY', type: 'INDEX_IN', sector: 'Macro Benchmark', beta: 1.00 },
      { id: 'BANKNIFTY', type: 'INDEX_IN', sector: 'Banking & Financials', beta: 1.25 },
      { id: 'RELIANCE', type: 'EQUITY_IN', sector: 'Energy & Telecom', beta: 1.15 },
      { id: 'TCS', type: 'EQUITY_IN', sector: 'IT Services', beta: 0.95 },
      { id: 'INFY', type: 'EQUITY_IN', sector: 'IT Services', beta: 1.05 },
      { id: 'BTCUSDT', type: 'CRYPTO', sector: 'Layer-1 Sovereign Store', beta: 1.80 },
      { id: 'ETHUSDT', type: 'CRYPTO', sector: 'Smart Contract Utility', beta: 2.10 },
      { id: 'SOLUSDT', type: 'CRYPTO', sector: 'High-Throughput DeFi', beta: 2.50 },
      { id: 'EURUSD=X', type: 'FOREX', sector: 'Global Reserve FX', beta: 0.60 },
      { id: 'CL=F', type: 'COMMODITY', sector: 'Crude Oil WTI', beta: 1.20 },
      { id: 'GC=F', type: 'COMMODITY', sector: 'Gold Safe Haven', beta: 0.40 }
    ];

    assetNodes.forEach(node => this.nodes.set(node.id, { ...node, currentShock: 0, propagatedImpulse: 0 }));

    // Define Directed Contagion Edges: (Source -> Target with Weight & Latency in seconds)
    this.edges = [
      { source: 'NVDA', target: 'TCS', weight: 0.45, type: 'TECH_CAPEX_DEMAND' },
      { source: 'NVDA', target: 'INFY', weight: 0.48, type: 'TECH_CAPEX_DEMAND' },
      { source: 'NVDA', target: 'BTCUSDT', weight: 0.55, type: 'AI_COMPUTE_SPECULATION' },
      { source: 'CL=F', target: 'RELIANCE', weight: 0.62, type: 'PETROCHEMICAL_REFINING' },
      { source: 'CL=F', target: 'NIFTY', weight: -0.40, type: 'IMPORT_BILL_PRESSURE' },
      { source: 'CL=F', target: 'EURUSD=X', weight: -0.35, type: 'ENERGY_IMPORT_COST' },
      { source: 'BTCUSDT', target: 'ETHUSDT', weight: 0.85, type: 'CRYPTO_MARKET_BETA' },
      { source: 'BTCUSDT', target: 'SOLUSDT', weight: 0.90, type: 'CRYPTO_MARKET_BETA' },
      { source: 'EURUSD=X', target: 'GC=F', weight: 0.50, type: 'DOLLAR_INVERSE_HEDGE' },
      { source: 'MSFT', target: 'TCS', weight: 0.40, type: 'ENTERPRISE_CLOUD_MIGRATION' },
      { source: 'NIFTY', target: 'BANKNIFTY', weight: 0.82, type: 'DOMESTIC_INDEX_WEIGHT' }
    ];
  }

  /**
   * Propagate shock impulse across graph nodes using GNN-style message passing
   * @param {string} sourceAsset - Originating shock asset
   * @param {number} shockMagnitude - Value between -1.0 and +1.0
   */
  propagateContagion(sourceAsset, shockMagnitude) {
    if (!this.nodes.has(sourceAsset)) {
      this.nodes.set(sourceAsset, { id: sourceAsset, type: 'GENERIC', currentShock: 0, propagatedImpulse: 0 });
    }

    // Reset impulses
    this.nodes.forEach(node => {
      node.currentShock = (node.id === sourceAsset) ? shockMagnitude : 0;
      node.propagatedImpulse = (node.id === sourceAsset) ? shockMagnitude : 0;
    });

    // 2-Hop Message Passing
    for (let hop = 1; hop <= 2; hop++) {
      const impulseBuffer = new Map();

      this.edges.forEach(edge => {
        const sourceNode = this.nodes.get(edge.source);
        if (sourceNode && Math.abs(sourceNode.propagatedImpulse) > 0.01) {
          const transmitted = sourceNode.propagatedImpulse * edge.weight * (hop === 1 ? 1.0 : 0.65);
          const currentAcc = impulseBuffer.get(edge.target) || 0;
          impulseBuffer.set(edge.target, currentAcc + transmitted);
        }
      });

      // Update target nodes
      impulseBuffer.forEach((impulse, targetId) => {
        const targetNode = this.nodes.get(targetId);
        if (targetNode) {
          targetNode.propagatedImpulse += impulse;
          targetNode.propagatedImpulse = Math.max(-1.0, Math.min(1.0, targetNode.propagatedImpulse));
        }
      });
    }

    const contagionMap = {};
    this.nodes.forEach((node, id) => {
      if (Math.abs(node.propagatedImpulse) > 0.05) {
        contagionMap[id] = {
          asset: id,
          sector: node.sector,
          impulse: parseFloat(node.propagatedImpulse.toFixed(3)),
          direction: node.propagatedImpulse > 0 ? 'BULLISH_TAILWIND' : 'BEARISH_HEADWIND',
          severity: Math.abs(node.propagatedImpulse) > 0.5 ? 'HIGH' : 'MODERATE'
        };
      }
    });

    logger.info(`🕸️ [Graph Contagion] Shock from ${sourceAsset} (${shockMagnitude > 0 ? '+' : ''}${shockMagnitude}) propagated to ${Object.keys(contagionMap).length} peer nodes`);
    return {
      timestamp: new Date().toISOString(),
      source: sourceAsset,
      initialShock: shockMagnitude,
      contagionNodes: contagionMap
    };
  }

  getTopology() {
    return {
      nodesCount: this.nodes.size,
      edgesCount: this.edges.length,
      edges: this.edges
    };
  }
}

module.exports = new GraphContagionEngine();
