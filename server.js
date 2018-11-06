// get settings 
var settings = require("./settings.js");
var krakenkey = settings.krakenkey;
var krakenpasscode = settings.krakenpasscode;
var buyTolerance = settings.buyTolerance;
var sellTolerance = settings.sellTolerance;
var buyMoveLimit = settings.buyMoveLimit;
var sellMoveLimit = settings.sellMoveLimit;
var priceMod = settings.priceMod;
var timer = settings.timer;

var fixedTradeEur = 10;
var fixedTradeBtc = 0.003;
var fixedTradeEth = 0.05;

// set up kraken api
var KrakenClient = require('kraken-api');
var kraken = new KrakenClient(krakenkey,krakenpasscode);

// get trade pair from CMDLINE
if (process.argv.length < 3) {
	console.log("No trade pair specified.");
	console.log("Usage: " + process.argv[1] + " [tradePair] [[tradePair2] [tradePair3] ..]");
	console.log("Example: to trade Litecoin for Euro, execute " + process.argv[1] + " XLTCZEUR");
	process.exit();
} else {
	var pairs=new Array();
	for (var i=2, len=process.argv.length; i<len; i++) {
		pairs[i-2] = process.argv[i];
	}
}

// logging
var log = require("./log.js");
var createGraph = require("./createGraph.js");

// explode pairs to single line to feed the API
var pairsExploded = "";
for (var i=0, len=pairs.length; i<len; i++) {
	if (i<len-1) pairsExploded += pairs[i]+",";
	else pairsExploded += pairs[i];
}

// get ticker info for all pairs
kraken.api('Ticker', {"pair": pairsExploded}, function(error, tickerdata) {
				
	if (error) {log(error); }
	else {

		// loop through the pairs
		pairs.forEach(function(pair) {

			// for each pair see if we need to trade
			var lasttrade = tickerdata.result[pair].c[0];
			var bid = tickerdata.result[pair].b[0];//todo
			var daylow = tickerdata.result[pair].l[1];
			var dayhi = tickerdata.result[pair].h[1];
			var weighedaverage = tickerdata.result[pair].p[1];
			
			// do some basic intepretation of the data
			var distancefromlow = Math.round((lasttrade - daylow) / (dayhi - daylow) * 100);
			var distancefromhi = Math.round((dayhi - lasttrade) / (dayhi - daylow) * 100);
			var move = Math.round(((dayhi - daylow) / dayhi) * 100);
				
			// output fancy graph
			log(createGraph(lasttrade, distancefromlow, daylow, dayhi, buyTolerance, sellTolerance),pair);

			var random = 1 + (Math.random() * .25);
			priceMod = priceMod * random;

			// determine to buy/sell
			if (move >= buyMoveLimit && distancefromlow <= buyTolerance) {


				var price = lasttrade * (1-priceMod);
				var volume = calculatevolume(pair,price)

				// quick hack
				price = cleanupPrice(pair,price);

				// buy stuff
				buy(pair, volume, price, timer);
			}
			else if (move >= sellMoveLimit && distancefromhi <= sellTolerance) {

				var price = lasttrade * (1+priceMod);
				var volume = calculatevolume(pair,price)

				kraken.api('Balance', null, function(error, balancedata) {

					if (error) {log(error,pair); }
					else {
						// ugly hack to find the asset balance from the balance data
						assetbalance = Math.max(balancedata.result[pair.substr(0,4)], balancedata.result[pair.substr(0,3)])

						if (assetbalance < volume) return

						// quick hack
						price = cleanupPrice(pair,price);

						// sell stuff
//						sell(pair, volume, price, timer);
					}
				})
			}
		})
	}
})

// simple helper to calc volume for pair + price
function calculatevolume(pair,price) {
	// some fixed trade amounts for certain currencies
	var currency = pair.substr(pair.length-3)
	if (currency == "EUR") return (fixedTradeEur / price);
	else if (currency == "XBT") return (fixedTradeBtc / price);
	else if (currency == "ETH") return (fixedTradeEth / price);
}


// buy for a given price with built in timer with profit close order
function buy(pair, volume, price, timer) {

	if (volume * price > 0) {
	
		log("volume to buy = "+ volume,pair);
		log("price to pay = "+ price,pair);

		return kraken.api('AddOrder', {
			"pair" : pair, 
			"type" : "buy", 
			"ordertype" :  "limit", 
			"volume" : volume, 
			"price" : price, 
			"expiretm" : "+"+timer, 
		}, function(error, buydata) { 
			if (error) log(error,pair);
			else if (buydata) {
				log("[TRADE] " + buydata["result"]["descr"]["order"], pair);
			}
		});
	}
}

// sell order with timed expiration
function sell(pair, volume, price, timer) {

	if (volume * price > 0) {
	
		log("volume to sell = "+ volume,pair);
		log("price to receive = "+ price,pair);

		return kraken.api('AddOrder', {
			"pair" : pair, 
			"type" : "sell", 
			"ordertype" :  "limit", 
			"volume" : volume, 
			"price" : price, 
			"expiretm" : "+"+timer, 
		}, function(error, selldata) { 
			if (error) log(error,pair);
			else if (selldata) {
				log("[TRADE] " + selldata["result"]["descr"]["order"], pair);
			}
		});
	}
}

// quick hack: clean up volume to deal with new trade restrictions
function cleanupPrice(pair,price) {
	if (pair=="XZECZEUR") price = price.toFixed(2);
	else if (pair=="BCHEUR") price = price.toFixed(1);
	else if (pair=="QTUMEUR") price = price.toFixed(5);
	else if (pair=="DASHEUR") price = price.toFixed(2);
	else if (pair=="XETCZEUR") price = price.toFixed(3);
	else if (pair=="XETHZEUR") price = price.toFixed(2);
	else if (pair=="XLTCZEUR") price = price.toFixed(2);
	else if (pair=="XREPZEUR") price = price.toFixed(3);
	else if (pair=="XXBTZEUR") price = price.toFixed(1);
	else if (pair=="XXMRZEUR") price = price.toFixed(2);
	else if (pair=="XXRPZEUR") price = price.toFixed(5);
	else if (pair=="XXLMZEUR") price = price.toFixed(6);
	else if (pair=="XZECXXBT") price = price.toFixed(5);
	else if (pair=="EOSXBT") price = price.toFixed(7);
	else if (pair=="BCHXBT") price = price.toFixed(5);
	else if (pair=="XICNXXBT") price = price.toFixed(6);
	else if (pair=="GNOEUR") price = price.toFixed(2);
	else if (pair=="EOSEUR") price = price.toFixed(4);
	else if (pair=="XXLMXXBT") price = price.toFixed(8);
	else if (pair=="GNOXBT") price = price.toFixed(5);
	else if (pair=="XETHXXBT") price = price.toFixed(5);
	else if (pair=="DASHXBT") price = price.toFixed(5);
	else if (pair=="XLTCXXBT") price = price.toFixed(6);
	else if (pair=="XETCXXBT") price = price.toFixed(6);
	else if (pair=="XXRPXXBT") price = price.toFixed(8);
	else if (pair=="XREPXXBT") price = price.toFixed(6);
	else if (pair=="XICNXETH") price = price.toFixed(6);
	else if (pair=="XMLNXETH") price = price.toFixed(5);
	else if (pair=="GNOETH") price = price.toFixed(4);
	return price;
}
