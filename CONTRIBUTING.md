# Contributing to Trading Brain

We welcome contributions from quantitative researchers, algorithm engineers, and developers!

## Contribution Rules
1. **Research & Simulation Focus**: The public core is strictly for research, simulation, and probabilistic forecasting.
2. **Canonical Runtime**: All PRs must target **Node.js >= 24** and **pnpm >= 10**.
3. **Invariants Must Pass**: All 43 mathematical & risk property tests (`pnpm test:invariants`) must pass without exceptions.
4. **License Compliance**: Any newly added dependency must comply with the Trading Brain Public Distribution License Policy (MIT/Apache-2.0/BSD).
