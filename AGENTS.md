# Agent Guidelines

## Core Philosophy

**The LLM is the trading expert. We provide DATA, it makes DECISIONS.**

### Principle 1: Natural Language Over Code

When facing a problem, ask: "Can the LLM solve this if we just tell it what we want?"

Examples:
- ❌ Code truncation for insights → ✅ Prompt: "Keep insights under 100 characters"
- ❌ Code deduplication logic → ✅ Prompt: "Don't repeat insights similar to existing ones"
- ❌ Code filtering of market observations → ✅ Prompt: "Only behavioral patterns, not market conditions"
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

## The LLM Context Window

We have a large context window. Use it:
- Provide comprehensive data
- Let the LLM find patterns
- Trust the LLM to focus on what matters

## Remember

> "We are the client to the expert. We just want 'to the moon'."

The expert (LLM) decides HOW to get there. We just provide the data and constraints.