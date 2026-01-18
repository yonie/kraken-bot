# Kraken Trading Bot

An AI-powered cryptocurrency trading bot for [Kraken](https://www.kraken.com) exchange.

## Disclaimer

I AM NOT RESPONSIBLE FOR ANY LOSS OF FUNDS OR ANY OTHER DAMAGES FOLLOWING USE OF THIS SOFTWARE. USE AT YOUR OWN RISK. NEVER INVEST FUNDS THAT YOU CANNOT MISS.

## Introduction

This bot is an autonomous AI trader (via OpenRouter) that analyzes your portfolio and executes trades on Kraken. It monitors positions, market conditions, and the Fear & Greed index to make trading decisions. The AI automatically places limit BUY and SELL orders based on its analysis.

## Key Features

* **AI-Powered Trading**: Uses LLM models (default: Grok) to autonomously analyze portfolio and make trading decisions
* **Real-time Web Dashboard**: Monitor positions, orders, P&L, and AI analysis via WebSocket-powered UI
* **Position Tracking**: Tracks cost basis, unrealized P&L, and holding duration for all positions
* **Trade Analytics**: Win rate, realized P&L, and performance metrics
* **Fear & Greed Index**: Monitors Bitcoin market sentiment for context-aware decisions
* **Automatic Trade Execution**: AI can place limit orders based on its analysis
* **Trade History**: Full trade history with analytics and performance tracking

## Architecture

```
src/
  index.js     # Entry point, configuration, scheduling
  state.js     # Central state management and persistence
  kraken.js    # Kraken API integration
  ai.js        # AI analysis and trade execution
  server.js    # HTTP/WebSocket server
public/
  index.html   # Web dashboard
data/          # Persisted state (auto-created)
```

## Requirements

* Node.js 18 or higher
* Kraken account with API key (trading permissions)
* EUR balance in your Kraken account
* OpenRouter API key (for AI features)

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and configure:
   ```bash
   cp .env.example .env
   ```
4. Edit `.env` with your credentials:
   ```env
   # Required
   KRAKEN_KEY=your-kraken-api-key
   KRAKEN_PASSCODE=your-kraken-secret

   # Required for AI features
   OPENROUTER_API_KEY=sk-or-v1-your-key

   # Optional
   LLM_MODEL=x-ai/grok-3-mini-beta    # Default model
   PORT=8000                           # Web dashboard port
   AI_ENABLED=true                     # Enable/disable AI trading
   ANALYSIS_INTERVAL_MINUTES=30        # How often AI runs analysis
   ```
5. Start the bot:
   ```bash
   npm start
   ```

## Web Dashboard

Access the dashboard at `http://localhost:8000` (or your configured port).

The dashboard shows:
- Current positions with P&L
- Open orders
- AI analysis and trading decisions
- Recent trades
- Balance and Fear & Greed index
- Live logs

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/state` | GET | Full bot state |
| `/api/analysis` | GET | Latest AI analysis |
| `/api/history` | GET | AI analysis history |
| `/api/positions` | GET | Current positions |
| `/api/logs` | GET | Recent logs |
| `/api/analyze` | POST | Trigger AI analysis |
| `/api/ai/toggle` | POST | Enable/disable AI |

## AI Trading

The AI receives context about:
- Portfolio balance and positions
- Current P&L for each position
- Open orders
- Recent trades
- Market top movers (24h)
- Fear & Greed index
- Previous AI decision history

### Command Syntax

The AI can issue these commands:
- `BUY <ASSET> <eur_amount> <price>` - Place limit buy order
- `SELL <ASSET> <price>` - Sell all holdings at limit price
- `HOLD` - No action

Example: `BUY ETH 50 3100` buys 50 EUR worth of ETH at 3100 EUR.

## Known Issues

* The bot only supports EUR trading pairs (USD not supported)
* Some newly listed assets might not work due to naming variations
* If you get "invalid nonce" errors, increase the API key nonce window to 10000ms in Kraken settings
* Disable automatic staking in Kraken to avoid issues with staked asset names

## Data Persistence

The bot persists state to the `data/` directory:
- `full_trade_history.json` - Complete trade history
- `cost_basis.json` - Position cost basis tracking
- `positions.json` - Current positions
- `llm_analysis.json` - Latest AI analysis
- `llm_history.json` - AI analysis history
- `ai_executions.json` - AI trade execution history

## License

Licensed under GPL-3.0.

## Donations

Found this useful? Donations welcome:

- ETH: `0xf923fe5103D9FA645161c244024e9f8c7Ed67E29`
- Solana: `9eFx8BNJGNN1PLkWxAxX3kLHVSLnnApFZfdcNMr3TjcR`
