# TODO

## Kraken Status Integration

**Goal:** Fetch Kraken status notices (delistings, market restrictions, migrations) and expose to AI for proactive awareness.

### Source
- Atom feed: `https://status.kraken.com/history.atom`
- Contains: delistings, cancel_only modes, token migrations, funding delays, maintenance

### Implementation Steps

1. **New module or add to kraken.js:**
   - `fetchStatusFeed()` - GET the Atom feed
   - `parseAtomFeed(xml)` - Extract relevant incidents
   - Run every 6 hours via existing refresh cycle

2. **Filter for relevance:**
   - Only incidents affecting currently held assets
   - Only "active" statuses (Scheduled, Investigating, Identified, Monitoring) - exclude Resolved
   - Keywords: "delisting", "cancel only", "migration", "market.*disabled"

3. **Store in state:**
   - `state.krakenNotices = [{ asset, title, status, keyDates, summary }]`

4. **Add to AI context:**
   - New section in `buildContext()` prompt
   - Show only notices for assets in portfolio

### Risks

**⚠️ Hyper-focus risk:** The AI receives mostly numeric data (prices, volumes, P&L). Status notices would be rare, narrative-style content. This could cause the AI to overweight these notices and make decisions based on them disproportionately.

**Mitigation options:**
- Limit to 1-2 sentences per notice
- Only show notices that directly block trading (cancel_only, delisting with markets disabled)
- Consider: add a numeric indicator (e.g., "days until delisting") to make it feel more data-like
- Monitor AI behavior after launch

### Example Output to AI

```
=== KRAKEN NOTICES (affecting your holdings) ===
XNAP: Markets disabled (delisting) - Withdrawals until May 20, liquidation May 21-29
```

### Priority
Medium