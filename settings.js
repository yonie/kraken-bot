// determines how much % an asset should drop value to become an interesting trade
exports.percentageDrop = 12;

// how much to buy each trade (in eur)
exports.fixedBuyAmount = 50;

// maximum % each asset can take up of total balance before we stop buying
exports.maxSharePerAssetPercent = 2.5;

// minimum trade volume we want to see before considering to buy (in eur)
exports.minTradeVolume = 20000;

// the maximum amount of observed greed we allow before we enter stop loss mode
// stopLossMode will put stop loss orders for any held assets. those orders 
// will be refreshed if prices go up further. it will also not buy anything in 
// this mode. to be used when market is percieved as topping out.
exports.maxGreedPercentage = 70;
exports.stopLossPercentage = 3;
