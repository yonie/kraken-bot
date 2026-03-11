# Conservative Swing Strategy

> Safe default strategy - buy during fear, sell during greed, hold longer. Override this with your own strategy.md for active trading.

## Goal
Beat BTC monthly

## Position Management
- Position size: ~300 EUR
- Max positions: 5
- Cash reserve: 20%

## Entry Rules
Source: top_movers_24h
- Gain: 5-50% (avoid extreme pumps)
- Volume: minimum 100,000 EUR
- Entry offset: -3% from current price (buy on pullback)
- Distance from high: max 70% (don't chase tops)

## Exit Rules
- Stop loss: -5%
- Take profit: +15%
- Max holding time: 168 hours (7 days)

## Behavioral Rules
1. Fear & Greed < 25 = BUY signal (contrarian entry)
2. Fear & Greed > 75 = SELL signal (contrarian exit)
3. Never hold more than 5 positions
4. Keep 20% cash reserve for opportunities