// logging
var log = require("./log.js");
log("initializing..")

var createGraph = require("./createGraph.js");
var dns = require('dns'),
	dnscache = require('dnscache')({
		"enable" : true,
		"ttl" : 1800,
		"cachesize" : 1000
	});

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
var engineTick = settings.engineTick

const numHistory = 45

var maxAgeSeconds = settings.maxAgeSeconds;

var fixedTradeEur = 15;
var fixedTradeBtc = 0.003;
var fixedTradeEth = 0.15;
const minvolume = 50000

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
		if (balanceHistory) {
			for (var i in balanceHistory) {
				response.write("<p>"+i+" "+balanceHistory[i]+"</p>")
			}
		}
		response.write("</body></html>")
	}
	response.end()
});

var pairs = []
var pairsExploded

var pairPrecision = []

// determine pairs
kraken.api('AssetPairs', null, function (error, pairdata) {

	if (error) {
		log("Critical error fetching asset pairs: " + error)
		process.exit(1)
	}
	else {

		// push all pairs into an array
		for (assetpair in pairdata['result']) {
			pairs.push(assetpair)
			pairPrecision[assetpair] = pairdata['result'][assetpair].pair_decimals
		}

		// filter out what we want
		pairs = pairs.filter(function (pair) {
			return pair.endsWith("EUR")
		})

		// call cleanup tosee if we have all the asset pairs
		pairs.forEach(function(pair) { cleanupPrice(pair, 1) })

		// get the exploded variant 
		pairsExploded = pairs.join()

		log("trading on pairs:" + pairsExploded)
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
		} else {
		
			ticker = []

			// loop through the pairs
			pairs.forEach(function (pair) {

				// TODO: this only works for ZEUR now and it breaks on XTZEUR :) 
				asset = pair.replace("ZEUR", "").replace("EUR", "")
				if (pair.indexOf("XTZEUR") > -1) asset = "XTZ"

				// for each pair see if we need to trade
				var lasttrade = tickerdata.result[pair].c[0]
				//var bid = tickerdata.result[pair].b[0] //todo
				var daylow = tickerdata.result[pair].l[1]
				var tradevolume = parseInt(tickerdata.result[pair].v[1] * lasttrade)
				var dayhi = tickerdata.result[pair].h[1]
				var weighedaverage = tickerdata.result[pair].p[1]

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

				// if we don't know our balance we should not trade
				if (!balance) return

				// TODO: before trading we should refresh the orders

				// determine to buy/sell
				if (move >= buyMoveLimit && distancefromlow <= buyTolerance) {
					
					// make sure we don't buy stuff below minimum trade volume
					if (tradevolume < minvolume) return

					log("Found interesting pair to buy: " + pair + " " + distancefromlow + "% " + move + "% vol: " + tradevolume) 

					var price = lasttrade * (1 - modifier)
					var volume = calculatevolume(pair, price).toFixed(8)

					// quick hack to ensure proper input for API
					price = cleanupPrice(pair, price)

					// TODO: don't buy if price is higher than market open
					
					// if we have too much of one asset (including orders!), don't buy more
					if (sumOpenOrders(pair) > 0.05 * balance) return

					// if we see we already own the asset, also check that
					if (wallet && wallet[asset] && balance && (wallet[asset]['amount'] * wallet[asset]['value']) + sumOpenOrders(pair) > 0.05 * balance) return

					// buy stuff
					buy(pair, volume, price, timer)

				} else if (wallet && wallet[asset] && wallet[asset]['amount'] > 0 && ((move >= sellMoveLimit && distancefromhi <= sellTolerance) || tradevolume < minvolume * 0.5)) {

					log("Found interesting pair to sell: " + pair + " " + distancefromlow + "% move: " + move + "% vol: " + tradevolume)

					// TODO: check open orders to see if a trade is even possible

					var price = lasttrade * (1 + modifier);

					// quick hack
					price = cleanupPrice(pair, price);

					var volume = calculatevolume(pair, price).toFixed(8)

					// if possible, check if we have enough to sell or break
					if (wallet[asset] && wallet[asset]['amount'] < volume) return

					// sell stuff
					sell(pair, volume, price, timer);
				}
			})
		}
	})
}, 1000 * engineTick)

// helper function to easily calculate the total amount of open order value for a given pair
function sumOpenOrders(pair) {

	var sum = 0

	if (!pair) return
	if (!orders) return

	for (i in orders) {
		if (orders[i].descr.pair == pair && orders[i].descr.type=="buy") {
			sum = sum + (orders[i].descr.price*orders[i].vol)
		}
	}

	if (sum > 0) log("Open orders for " + pair + ": " + sum)

	return sum

}

var orders = []

// get ticker info
setInterval(function () {
	kraken.api('OpenOrders', null, function (error, data) {

		orders = []

		if (error) { log("Error fetching open orders: " + error) } 
		else {
			// get current time to see which orders are too old
			currentTime = Math.floor(new Date() / 1000);
			var openorders = Object.keys(data.result.open).length
			if (openorders > 0) log("Open orders: " + openorders + ", max age: " + maxAgeSeconds / 60 + "m");

			var numOrders = 0;

			// iterate through all the open orders
			for (var order in data.result.open) {

				orders.push(data.result.open[order])

				numOrders++;

				// get the order open time 
				orderTime = data.result.open[order].opentm;
				orderType = data.result.open[order].descr.type;
				orderType2 = data.result.open[order].descr.ordertype;

				// cancel our orders if one is too old
				if (orderTime + maxAgeSeconds < currentTime && orderType2 == "limit") {
					log("Cancelling order #" + numOrders + " " + order + "...");
					kraken.api('CancelOrder', {
						"txid": order
					}, function (error, data) {
						if (error) {
							log("Error cancelling order: " + error)
						} 
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
		if (error) {
			log("Error updating trades history: " + error)
		}
		else {
			trades = []
			for (var trade in tradesHistoryData.result.trades)
				trades.push(tradesHistoryData.result.trades[trade])
			//log("Updated trades history.")
		}
	});
}, 1000 * 57)

var wallet = {}

var balanceHistory = []

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

			balanceHistory[new Date().toISOString().substring(0,13)] = balance

			// get asset balance
			kraken.api('Balance', null, function (error, balanceData) {

				if (error) {
					log("Error getting balance: " + error)
				} 
				else {
					if (!wallet) wallet = {}
					for (var asset in balanceData.result) {
						var amount = parseFloat(balanceData.result[asset])
						if (amount==0) continue

						if (!wallet[asset]) wallet[asset] = {}
						wallet[asset]['asset'] = asset
						wallet[asset]['amount'] = amount
						// TODO: special hack to give base currency balance also a value
						if (asset == "ZEUR") wallet[asset]['value'] = amount
					}
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
	else {
		log("Error while calculating volume for " + pair)
		process.exit(1)
		
	}
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
			if (error) { log("Error adding buy order: " + error) } else if (buydata) {
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
			if (error) { log("Error adding sell order: " + error) } //error) log("Sell order failed: "+error,pair)
			else if (selldata) {
				log("[TRADE] " + selldata["result"]["descr"]["order"], pair);
			}
		});
	}
}

// clean up price to deal with new trade restrictions
function cleanupPrice(pair, price) {

	var precision = pairPrecision[pair]
	if (precision) return price.toFixed(precision)
	else {
		log("Error: Unknown price format for pair: " + pair)
		return price
	}
}
