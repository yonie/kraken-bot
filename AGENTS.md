# Agent Guidelines

## Core Philosophy

**The LLM is the trading expert. We provide DATA, it makes DECISIONS.**

### Principle 1: Natural Language Over Code

When facing a problem, ask: "Can the LLM solve this if we just tell it what we want?"

Examples:
- ❌ Code truncation for insights → ✅ Prompt: "Keep insights under 100 characters"
- ❌ Code deduplication logic → ✅ Prompt: "Don't repeat insights similar to existing ones"
- ❌ Code filtering of market observations → ✅ Prompt: "Only behavioral patterns, not market observations"
- ❌ Code quality scoring → ✅ Prompt: "Only provide insights that are genuinely meaningful"

### Principle 2: Trust the Agent

The LLM understands:
- Context and nuance
- What "short" means
- What "different from existing" means
- What "behavioral pattern" vs "market observation" means

We don't need to encode these concepts in code. Natural language is more flexible and powerful.

### Principle 3: Data, Not Judgments

We provide:
- Raw market data (prices, volumes, depth)
- Raw portfolio data (positions, trades, P&L)
- Raw news (headlines, not summaries)
- Raw history (what happened, not interpretations)

The LLM judges:
- Opportunities
- Risks
- Patterns
- Actions

### Principle 4: Simple State, Smart Agent

Keep state management simple:
- Store raw data
- Let the LLM interpret patterns
- Don't pre-compute "insights" or "signals" in code
- The LLM can derive any interpretation from raw data

### Principle 5: Prompt Over Code

Before adding code logic, consider if a prompt instruction accomplishes the same:

| Problem | Code Solution | Prompt Solution |
|---------|---------------|-----------------|
| Insights too long | `substring(0, 200)` | "Keep insights under 100 chars" |
| Duplicate insights | Similarity algorithm | "Skip if similar to existing insights" |
| Wrong insight type | Filter keywords | "Only behavioral patterns, not market observations" |
| Too many insights | Rate limiting code | "Only provide insight when genuinely new" |

### When to Use Code

Code is appropriate for:
- Fetching data (APIs, RSS feeds, Kraken)
- Persisting state (saving to files)
- Executing trades (order placement)
- Formatting data for display
- Parsing LLM responses into actions

Code is NOT appropriate for:
- Judging insight quality
- Filtering duplicates (semantic understanding)
- Interpreting market conditions
- Making trading decisions

### Principle 6: No Interpretation Layer

The prompt should pass strategy and data directly to the LLM. Do NOT:

| ❌ Bad | ✅ Good |
|--------|---------|
| Calculate "orders you can place" from cash/position size | Show cash available, show position sizes - let LLM decide |
| Hardcode "max 5 positions" in code | Let LLM decide concentration level based on strategy |
| Transform strategy.json into formatted text | Pass strategy.json content as-is |
| Add "mindset" statements like "idle cash is failure" | Let LLM interpret when cash is appropriate |

The LLM is the expert. It can count positions, divide cash, and make decisions. Code should only:
- Fetch data
- Format data into JSON structure
- Pass strategy.json content through unchanged
- Execute the LLM's commands

### Strategy Philosophy

Strategy belongs in `strategy.json` as natural language principles, not executable rules:

| ❌ Code-like Strategy | ✅ Principle-based Strategy |
|-----------------------|----------------------------|
| `"position_size_eur": 900` | Let LLM decide sizing |
| `"max_positions": 5` | Let LLM decide concentration |
| `"stop_loss_pct": -3` | "Cut losses immediately on reversal" |
| `"entry_rules": {...}` | "Rank by 7-day returns, buy top performers" |

The LLM reads principles and applies judgment. Hardcoded values remove the LLM's ability to adapt.

### Research-Backed Strategy

When using academic research, cite the paper and adopt its method:

```json
{
  "strategy": {
    "name": "Momentum Trading",
    "paper": "Tzouvanas et al. (2020) - Economics Letters",
    "method": {
      "formation": "Rank by 7-day returns",
      "entry": "Buy top performers",
      "hold": "7 days"
    }
  }
}
```

Do NOT invent values that aren't in the research. The previous strategy contained "4% pullback entry" and "10-30% gain threshold" with zero research backing - they were guesses dressed as rules.

## LLM Feedback Loop

The LLM can request additional data it wishes it had. This creates a direct feedback loop from the AI to development:

- **REQUEST field**: In each analysis, the LLM can optionally request data (e.g., "BTC RSI indicator", "order book depth")
- **Questions are persisted**: Stored in `data/questions.json` and visible via `/api/questions`
- **Future development**: An agent can review questions and implement data sources

## Data Clarity

All data fields must clearly represent what they contain:
- `change24hPct`: Actual 24h price change (from open price)
- `range24hPct`: Volatility as percentage of low (high-low / low)
- Never use misleading names - the LLM relies on accurate labels

## The LLM Context Window

We have a large context window. Use it:
- Provide comprehensive data
- Let the LLM find patterns
- Trust the LLM to focus on what matters

## Strategy Configuration

Strategy is loaded from `data/strategy.json` (user's personal strategy) or `data/strategy.example.json` (default).

- `strategy.json` - Your personal trading strategy (gitignored, not in repo)
- `strategy.example.json` - Default conservative strategy (in repo)

The strategy file should contain principle-based guidance, not hardcoded rules. See Principle 6 and Strategy Philosophy sections above for guidance.

## Parallel Experiments (Super Fast Learning)

Running experiments with subagents is **free and fast**. You can run up to 7 agents in parallel to test different prompts, formats, and edge cases before implementation.

**Use cases:**
- Test command format variations (which outputs parser-friendly results)
- Test strategy rules (stop loss triggers, position sizing logic)
- Test edge cases (unknown assets, low cash, max positions)
- Compare prompt styles (minimal vs explicit, JSON vs plain text)

**How to use:**
```
Use task tool with multiple subagent_type: "general" calls in parallel
Each with different test scenario
Review outputs for parser compatibility and strategy adherence
```

**Example experiments:**
```
Test 1: Empty commands (HOLD scenario)
Test 2: Partial sell (50% at +5%)
Test 3: Stop loss (-3% trigger)
Test 4: Max positions reached
Test 5: Buy entry with pullback calculation
Test 6: Multiple sells at once
Test 7: Unknown asset error handling
```

**Benefits:**
- Find what works before coding
- Validate parser compatibility
- Discover edge cases early
- Refine prompts based on actual output

This is especially useful for new strategy implementations and edge case handling.

## Testing Trading Strategies with Subagents

Beyond testing command formats, you can use parallel subagents to **test how the LLM responds to different market conditions** and **validate strategy logic before deployment**.

### What to Test

**1. Market Condition Scenarios**
```
- Bull market: Top movers +20-40%, Fear & Greed 75 (Extreme Greed)
- Bear market: All positions underwater -3% to -8%, Fear & Greed 15 (Extreme Fear)
- Mixed: Some positions profitable (+10%+), some at stop loss (-3%+)
- No trades: Cash available but no movers meet volume threshold
```

**2. Strategy Rule Triggers**
```
- Does +10% hit trigger SELL ALL?
- Does +5% trigger SELL 50%?
- Does -3% trigger SELL ALL?
- Does 24h hold trigger exit?
- Does max positions (5) prevent new buys?
```

**3. Edge Cases**
```
- Unknown asset in portfolio (not on Kraken)
- Low cash (below minimum position size)
- All positions at max, new mover appears
- Stop loss hit exactly at -3.0%
- Multiple positions need selling simultaneously
```

**4. Strategy Wording Variations**
```
- Minimal rules vs. detailed examples
- Research attribution vs. no attribution
- Psychological framing ("You're WRONG at -3%")
- Decision trees (check #1, then #2, then #3)
```

### How to Test

```javascript
// Example: Test stop-loss behavior
task({
  subagent_type: "general",
  prompt: `You are a crypto bot. Strategy: -3% stop loss = sell immediately.
Position: ETH €950, PnL -3.1%, hold 2h.
Question: What action? Output: ---COMMANDS---...`
})
```

### Example Parallel Test

Run 7 scenarios simultaneously:
```
Test 1: Bull market, all positions profitable +10%+
Test 2: Bear market, all positions underwater -5%
Test 3: Mixed: one +12% (target hit), one -4% (stop hit)
Test 4: Max positions (5), new high-volume mover appears
Test 5: Cash €50 (below position minimum)
Test 6: Position held 26 hours (>24h rule)
Test 7: Strategy with research attribution vs. without
```

Compare outputs:
- Did each scenario trigger the correct action?
- Did the LLM calculate pullback prices correctly?
- Did it maintain command format across all scenarios?

### Benefits

1. **Validate before deploying** - Catch logic errors before real money
2. **Compare prompt styles** - Test which wording produces better decisions
3. **Discover edge cases** - Find scenarios you didn't anticipate
4. **Tune thresholds** - Test if -3% stop vs -5% changes behavior
5. **Verify parser compatibility** - Ensure all outputs are parseable

### Strategy Iteration Workflow

1. Write/update strategy in `data/strategy.json`
2. Run 5-7 parallel tests with different market conditions
3. Review outputs for correctness and format
4. Adjust strategy rules, repeat tests
5. Deploy when outputs match expectations

This approach lets you iterate on strategy logic without risking capital

## Remember

> "We are the client to the expert. We just want 'to the moon.'"

The expert (LLM) decides HOW to get there. We just provide the data and constraints.