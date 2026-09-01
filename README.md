# 🧠 Trading Brain
### Multi-Market Quantitative Research & Probabilistic Simulation Framework

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10.0.0-orange.svg)](https://pnpm.io/)
[![Environment: Paper First](https://img.shields.io/badge/Execution-Paper%20Simulated-yellow.svg)]()
[![Invariants](https://img.shields.io/badge/Invariants-26%2F26%20Passing-success.svg)]()

> **Trading Brain** is an open-source quantitative research framework for probabilistic forecasting, multi-agent evidence synthesis, market microstructure simulation, Saty ATR Fibonacci volatility bands, and risk-governed paper trading.
>
> 🔒 **Notice**: Live execution is disabled by default. Built strictly for scientific research, probability calibration, and empirical market simulation.

---

## 🖥️ Live Terminal & Research Workspace Preview

![Trading Brain Interactive Terminal Demo](docs/assets/demo_terminal.gif)

> 📺 **Full Video Tour with Commentary**: [Watch on YouTube (4-min Full Walkthrough)](https://www.youtube.com/watch?v=_RZMz_Oq4JM)

---

## 🏛️ The 8 Core Public Pillars

1. **🧠 Probabilistic Intelligence**: ORACLE engine, reliability-weighted ensemble pooling, and Brier skill score calibration.
2. **🤖 Multi-Agent Reasoning**: Hermes automated debate orchestration, macroeconomic causal graph parsing, and adversarial hardening.
3. **🔮 Prediction Market Research**: Polymarket/Kalshi semantic contract criteria extraction and market-logic consistency auditing.
4. **📊 Quantitative Research**: Cointegration scanners, Hawkes order flow jump processes, and statistical alpha models.
5. **🛡️ Risk & Capital Preservation**: Strict mathematical invariant verification, anti-chop post-loss cooldowns, and dynamic broker slot quotas.
6. **⚡ Execution Simulation**: CLOB matching engine simulation, synthetic slippage modeling, and simulated paper order routers. The public sandbox contains simulation interfaces only and does not include live signing or real-order routing implementations.
7. **📜 Tamper-Evident Provenance**: Hash-linked decision-time snapshots that expose post-hoc modification and preserve reproducible forecast provenance.
8. **🖥️ Research Workspace & HUD**: Real-time high-density trading canvas, multi-timeframe regime matrix, and order book depth absorption heatmaps.

---

## 🚀 Quickstart (Zero-Key Sandbox)

Trading Brain boots out-of-the-box in `DEMO` mode with synthetic market feeds and simulated prediction contracts. **No API keys, wallets, or exchange accounts required.**

### Option 1: Docker Sandbox (Recommended)
```bash
# 1. Clone the repository
git clone https://github.com/Azhar041189/trading-brain-public.git
cd trading-brain-public

# 2. Launch local sandbox
docker compose up -d

# 3. Open Web Dashboard
# Navigate to http://localhost:3004
```

### Option 2: Local Node.js
```bash
# Prerequisites: Node.js >= 24.0.0, pnpm >= 10.0.0
pnpm install --frozen-lockfile

# Run 24 Mathematical & Risk Invariant Test Suites
pnpm test:invariants

# Start Demo Dashboard
pnpm dev
# Server running at http://localhost:3004
```

---

## 🧪 Invariant Verification Suite

Trading Brain enforces strict mathematical and risk properties before any execution state change:

```bash
pnpm test:invariants
```

* **Non-Repainting Pivots**: Guaranteed historical immutability on confirmed swing structures.
* **Kelly Allocation Clamp**: Position sizing mathematically bounded by fractional Kelly formulas.
* **Zero-Decision Delta**: Ensures identical deterministic signal outputs across repeated offline replays.

---

## 📜 Cryptographic Release Provenance

Every public release tag publishes independent Sigstore-attested artifacts:
* `trading-brain-v0.9.0-public-beta.tar.gz` (Deterministic archive)
* `cyclonedx-sbom.json` (Software Bill of Materials)
* `RELEASE_PROVENANCE.json` (Published Release Manifest)
* `RELEASE_PROVENANCE.schema.json` (JSON Schema Specification)

Verify release provenance using the GitHub CLI:
```bash
gh attestation verify trading-brain-v0.9.0-public-beta.tar.gz --repo Azhar041189/trading-brain-public
gh attestation verify RELEASE_PROVENANCE.json --repo Azhar041189/trading-brain-public
```

---

## ⚖️ License & Distribution Policy

Trading Brain Core is licensed under the **[Apache License, Version 2.0](LICENSE)**.  
Public releases are gated by an automated direct and transitive dependency license-policy check.
