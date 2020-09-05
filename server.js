// logging
var log = require("./log.js");
log("initializing..")

var createGraph = require("./createGraph.js");

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

const numHistory = 45

var maxAgeSeconds = settings.maxAgeSeconds;

var fixedTradeEur = 15;
var fixedTradeBtc = 0.003;
var fixedTradeEth = 0.15;

// set up kraken api
var KrakenClient = require('kraken-api');
var kraken = new KrakenClient(krakenkey, krakenpasscode);

var balance

const http = require('http')
const port = 8000
const server = http.createServer().listen(port)

server.on('listening', function () {
	log("listening on port " + port)
})

server.on('request', (request, response) => {

	if (request.url.includes("/wallet")) {
		contenttype = 'application/json'
		response.writeHead(200, {
			'Content-Type': contenttype
		})
		response.write(JSON.stringify(wallet))
	} else if (request.url.includes("/trades")) {
		contenttype = 'application/json'
		response.writeHead(200, {
			'Content-Type': contenttype
		})
		response.write(JSON.stringify(trades))
	} else if (request.url.includes("/orders")) {
		contenttype = 'application/json'
		response.writeHead(200, {
			'Content-Type': contenttype
		})
		response.write(JSON.stringify(orders))
	} else if (request.url.includes("/ticker")) {
		contenttype = 'application/json'
		response.writeHead(200, {
			'Content-Type': contenttype
		})
		response.write(JSON.stringify(ticker))
	} else {
		contenttype = 'text/html'
		response.writeHead(200, {
			'Content-Type': contenttype
		})
		response.write("<!doctype HTML><html><head><title>kraken</title></head><body>")
		response.write("<h1>kraken</h1>")
		if (balance) response.write("<h2>latest balance: " + balance + "</h2>")
		response.write("<a href=\"/wallet\">wallet</a><br/>")
		response.write("<a href=\"/trades\">trades</a><br/>")
		if (orders) response.write("<a href=\"/orders\">orders (" + orders.length + ")</a><br/>")
		response.write("<a href=\"/ticker\">ticker</a><br/>")
		if (trades && trades.length > numHistory) {
			response.write("<p>latest trades:</p>")
			response.write("<ul>")
			for (i = 0; i < numHistory; i++) {
				if (!trades[i]) return
				response.write("<li>")
				response.write("" + new Date(trades[i]['time'] * 1000).toLocaleString())
				response.write(" ")
				response.write(trades[i]['type'])
				response.write(" ")
				response.write(trades[i]['vol'])
				response.write(" ")
				response.write(trades[i]['pair'])
				response.write(" @ ")
				response.write(trades[i]['price'])
				response.write(" = ")
				response.write(trades[i]['cost'])
				response.write("</li>")
			}
			response.write("</ul>")
		}
		response.write("</body></html>")
	}
	response.end()
});

var pairs = []
var pairsExploded

// determine pairs
kraken.api('AssetPairs', null, function (error, pairdata) {

	if (error) console.log(error)
	else {
		// push all pairs into an array
		for (assetpair in pairdata['result']) pairs.push(assetpair)

		// filter out what we want
		pairs = pairs.filter(function (pair) {
			return pair.endsWith("EUR")
		})

		// get the exploded variant 
		pairsExploded = pairs.join()

		console.log("trading on pairs:", pairsExploded)
	}

})


var ticker = []

// main routine
setInterval(function () {

	// get ticker info for all pairsa
	kraken.api('Ticker', {
		"pair": pairsExploded
	}, function (error, tickerdata) {

		if (error) {
			log("Error updating ticker: " + error)
			//console.log(error)
		} else {
		
			ticker = []

			// loop through the pairs
			pairs.forEach(function (pair) {

				// TODO: this only works for ZEUR now and it breaks on XTZEUR :) 
				asset = pair.replace("ZEUR", "").replace("EUR", "")
				if (pair.indexOf("XTZEUR") > -1) asset = "XTZ"

				// for each pair see if we need to trade
				var lasttrade = tickerdata.result[pair].c[0];
				//var bid = tickerdata.result[pair].b[0]; //todo
				var daylow = tickerdata.result[pair].l[1];
				var tradevolume = parseInt(tickerdata.result[pair].v[1] * lasttrade)
				var dayhi = tickerdata.result[pair].h[1];
				var weighedaverage = tickerdata.result[pair].p[1];

				// update wallet
				if (wallet[asset]) {
					wallet[asset]['price'] = parseFloat(lasttrade)
					if (wallet[asset]['amount']) {
						wallet[asset]['value'] = wallet[asset]['amount'] * wallet[asset]['price']
					}
				}

				// do some basic intepretation of the data
				var distancefromlow = Math.round((lasttrade - daylow) / (dayhi - daylow) * 100);
				var distancefromhi = Math.round((dayhi - lasttrade) / (dayhi - daylow) * 100);
				var move = Math.round(((dayhi - daylow) / dayhi) * 100);

				// output fancy graph
				ticker.push(pair + " " + createGraph(lasttrade, distancefromlow, daylow, dayhi, buyTolerance, sellTolerance) + " vol: " + tradevolume)

				// invoke some randomness in the prices
				var random = 1 + (Math.random() * .1);
				var modifier = priceMod * random;

				// determine to buy/sell
				if (move >= buyMoveLimit && distancefromlow <= buyTolerance) {

					var price = lasttrade * (1 - modifier);
					var volume = calculatevolume(pair, price)

					// quick hack
					price = cleanupPrice(pair, price);

					// TODO: check open orders to see if a trade is possible

					// TODO: make sure we don't buy stuff below minimum trade volume

					// if we have too much of one asset, don't buy more
					if (wallet[asset] && balance && wallet[asset]['amount'] * wallet[asset]['value'] > 0.1 * balance) return

					// buy stuff
					buy(pair, volume, price, timer);
				} else if (move >= sellMoveLimit && distancefromhi <= sellTolerance) {

					// TODO: check open orders to see if a trade is even possible

					var price = lasttrade * (1 + modifier);

					// quick hack
					price = cleanupPrice(pair, price);

					var volume = calculatevolume(pair, price)

					// if possible, check if we have enough to sell or break
					if (wallet[asset] && wallet[asset]['amount'] < volume) return

					// sell stuff
					sell(pair, volume, price, timer);
				}
			})
		}
	})
}, 1000 * 11)

var orders = []

// get ticker info
setInterval(function () {
	kraken.api('OpenOrders', null, function (error, data) {

		orders = []

		if (error) {} //error) log(error);
		else {
			// get current time to see which orders are too old
			currentTime = Math.floor(new Date() / 1000);
			log("Current open orders: " + Object.keys(data.result.open).length + ", max age: " + maxAgeSeconds / 60 / 60 + "h");

			var numOrders = 0;

			// iterate through all the open orders
			for (var order in data.result.open) {

				orders.push(data.result.open[order])

				numOrders++;

				//log("order: " + data.result.open[order].descr.order + " for " + (data.result.open[order].vol * data.result.open[order].descr.price).toFixed(2));

				// get the order open time 
				orderTime = data.result.open[order].opentm;
				orderType = data.result.open[order].descr.type;
				orderType2 = data.result.open[order].descr.ordertype;

				// cancel order if it is too old
				if (orderTime + maxAgeSeconds < currentTime) {
					log("Cancelling order #" + numOrders + " " + order + "...");
					kraken.api('CancelOrder', {
						"txid": order
					}, function (error, data) {
						if (error) {} //error) log(error);
					});
				}

			}
		}
	});
}, 1000 * 87)

var trades = []

// get trade history info
setInterval(function () {
	kraken.api('TradesHistory', null, function (error, tradesHistoryData) {
		if (error) console.log(error)
		else {
			trades = []
			for (var trade in tradesHistoryData.result.trades)
				trades.push(tradesHistoryData.result.trades[trade])
			//log("Updated trades history.")
		}
	});
}, 1000 * 57)

var wallet = {}

// get trade balance info
setInterval(function () {
	kraken.api('TradeBalance', {
		"asset": "ZEUR"
	}, function (error, tradeBalanceData) {

		if (error) {
			log("Error getting trade balance: " + error)
		}
		else {
			balance = parseFloat(tradeBalanceData.result.eb).toFixed(2)
			log("Trade balance: " + balance)

			// get asset balance
			kraken.api('Balance', null, function (error, balanceData) {

				if (error) {
					log("Error getting balance: " + error)
				} //error) console.log(error);
				else {
					// get ticker info to determine total value
					kraken.api('Ticker', {
						"pair": pairsExploded
					}, function (error, tickerData) {

						if (error) {
							log("Error getting ticker: " + error)
						} else {
							wallet = {}
							for (var asset in balanceData.result) {

								wallet[asset] = {}
								wallet[asset]['asset'] = asset
								wallet[asset]['amount'] = parseFloat(balanceData.result[asset])
								// TODO: special hack to give base currency also a value
								if (asset == "ZEUR") wallet[asset]['value'] = parseFloat(balanceData.result[asset])

								// TODO: initial price and value

								if (balanceData.result[asset] && balanceData.result[asset] >= 0.00001) {
									var logString = asset + ": " + parseFloat(balanceData.result[asset]).toFixed(5);
									if (tickerData.result[asset + "ZEUR"]) logString = logString + " for " + tickerData.result[asset + "ZEUR"].c[0] + " = " + parseFloat(balanceData.result[asset] * tickerData.result[asset + "ZEUR"].c[0]).toFixed(2) + " ZEUR";
									if (tickerData.result[asset + "EUR"]) logString = logString + " for " + tickerData.result[asset + "EUR"].c[0] + " = " + parseFloat(balanceData.result[asset] * tickerData.result[asset + "EUR"].c[0]).toFixed(2) + " EUR";
								}
							}
						}
					});
				}
			});
		}
	});
}, 1000 * 29)


// simple helper to calc volume for pair + price
function calculatevolume(pair, price) {
	// some fixed trade amounts for certain currencies
	var currency = pair.substr(pair.length - 3)
	if (currency == "EUR") return (fixedTradeEur / price);
	else if (currency == "XBT") return (fixedTradeBtc / price);
	else if (currency == "ETH") return (fixedTradeEth / price);
}


// buy for a given price with built in timer with profit close order
function buy(pair, volume, price, timer) {

	if (volume * price > 0) {

		//log("volume to buy = "+ volume,pair);
		//log("price to pay = "+ price,pair);

		return kraken.api('AddOrder', {
			"pair": pair,
			"type": "buy",
			"ordertype": "limit",
			"volume": volume,
			"price": price,
			"expiretm": "+" + timer,
		}, function (error, buydata) {
			if (error) {} else if (buydata) {
				log("[TRADE] " + buydata["result"]["descr"]["order"], pair);
			}
		});
	}
}

// sell order with timed expiration
function sell(pair, volume, price, timer) {

	if (volume * price > 0) {

		//log("volume to sell = "+ volume,pair);
		//log("price to receive = "+ price,pair);

		return kraken.api('AddOrder', {
			"pair": pair,
			"type": "sell",
			"ordertype": "limit",
			"volume": volume,
			"price": price,
			"expiretm": "+" + timer,
		}, function (error, selldata) {
			if (error) {} //error) log("Sell order failed: "+error,pair)
			else if (selldata) {
				log("[TRADE] " + selldata["result"]["descr"]["order"], pair);
			}
		});
	}
}

// quick hack: clean up volume to deal with new trade restrictions
function cleanupPrice(pair, price) {
	if (pair == "XZECZEUR") price = price.toFixed(2);
	else if (pair == "ADAEUR") price = price.toFixed(6);
	else if (pair == "BCHEUR") price = price.toFixed(1);
	else if (pair == "BCHXBT") price = price.toFixed(5);
	else if (pair == "DASHEUR") price = price.toFixed(2);
	else if (pair == "DASHXBT") price = price.toFixed(5);
	else if (pair == "EOSEUR") price = price.toFixed(4);
	else if (pair == "EOSXBT") price = price.toFixed(7);
	else if (pair == "GNOETH") price = price.toFixed(4);
	else if (pair == "GNOEUR") price = price.toFixed(2);
	else if (pair == "GNOXBT") price = price.toFixed(5);
	else if (pair == "QTUMEUR") price = price.toFixed(5);
	else if (pair == "XETCXXBT") price = price.toFixed(6);
	else if (pair == "XETCZEUR") price = price.toFixed(3);
	else if (pair == "XETHXXBT") price = price.toFixed(5);
	else if (pair == "XETHZEUR") price = price.toFixed(2);
	else if (pair == "XICNXETH") price = price.toFixed(6);
	else if (pair == "XICNXXBT") price = price.toFixed(6);
	else if (pair == "XLTCXXBT") price = price.toFixed(6);
	else if (pair == "XLTCZEUR") price = price.toFixed(2);
	else if (pair == "XMLNXETH") price = price.toFixed(5);
	else if (pair == "XREPXXBT") price = price.toFixed(6);
	else if (pair == "XREPZEUR") price = price.toFixed(3);
	else if (pair == "XTZEUR") price = price.toFixed(4);
	else if (pair == "XXBTZEUR") price = price.toFixed(1);
	else if (pair == "XXLMXXBT") price = price.toFixed(8);
	else if (pair == "XXLMZEUR") price = price.toFixed(6);
	else if (pair == "XXMRZEUR") price = price.toFixed(2);
	else if (pair == "XXRPXXBT") price = price.toFixed(8);
	else if (pair == "XXRPZEUR") price = price.toFixed(5);
	else if (pair == "XZECXXBT") price = price.toFixed(5);
	return price;
}
