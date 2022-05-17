// logging
var log = require("./log.js");
log("initializing..")

// eslint-disable-next-line no-unused-vars
var dns = require('dns'),
    // eslint-disable-next-line no-unused-vars
    dnscache = require('dnscache')({
        "enable": true,
        "ttl": 1800,
        "cachesize": 1000
    });

// get settings 
var settings = require("./settings.js");
var krakenKey = settings.krakenkey;
var krakenPasscode = settings.krakenpasscode;
var buyTolerance = settings.buyTolerance;
var buyMoveLimit = settings.buyMoveLimit;
var timer = settings.timer;
var maxAgeSeconds = settings.maxAgeSeconds;

// how often does the engine refresh stuff, in seconds
var engineTick = 61

// set to false to disable any trading actions, rendering the bot passive
const trading = true

// how many trades to show in the history list of the web client
const numHistory = 150

// how much to buy each trade (in eur)
const fixedBuyAmount = 30

// minimum trade amount before trying a sell order (in eur)
const minSellAmount = 5;

// maximum % each asset can take up of total balance
const maxSharePerAsset = 0.05;

// minimum trade volume we want to see (in eur)
const minTradeVolume = 50000

// flag used to keep the engine aware whether orders have been updated
let ordersDirty = true

// set up kraken api
var KrakenClient = require('kraken-api');
var kraken = new KrakenClient(krakenKey, krakenPasscode);

var balance

const http = require('http')
const url = require('url')
const port = 8000
const server = http.createServer().listen(port)

server.on('listening', function () {
    log("listening on port " + port)
})

server.on('request', (request, response) => {

    var contenttype

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
        if (balance && wallet['ZEUR'] && wallet['ZEUR'].value) response.write("<h2>latest balance: " + balance + " (" + ((wallet['ZEUR'].value / balance) * 100).toFixed(0) + "% free)</h2>")
        response.write("<a href=\"/wallet\">wallet</a><br/>")
        response.write("<a href=\"/trades\">trades</a><br/>")
        if (orders) response.write("<a href=\"/orders\">orders (" + orders.length + ")</a><br/>")
        response.write("<a href=\"/ticker\">ticker</a><br/>")

        var requestedPair = url.parse(request.url, true).query['pair']
        if (requestedPair) response.write("<h3>" + requestedPair + ": " + (ticker ? ticker[requestedPair] : "") + "</h3>")

        if (trades) {
            response.write("<p>latest trades:</p>")
            response.write("<ul>")
            for (i = 0; i < Math.min(trades.length, numHistory); i++) {
                if (!trades[i]) continue
                if (!requestedPair || trades[i]['pair'] === requestedPair) {
                    response.write("<li>")
                    response.write("" + new Date(trades[i]['time'] * 1000).toLocaleString())
                    response.write(" ")
                    response.write(trades[i]['type'])
                    response.write(" ")
                    response.write(trades[i]['vol'])
                    response.write(" <a href=\"?pair=" + trades[i]['pair'] + "\">")
                    response.write(trades[i]['pair'])
                    response.write("</a> ")
                    response.write(" @ ")
                    response.write(trades[i]['price'])
                    response.write(" = ")
                    response.write(trades[i]['cost'])
                    response.write("</li>")
                }
            }
            response.write("</ul>")
        }

        // FIXME: if (orders) display filtered orders

        if (balanceHistory) {
            for (var i in balanceHistory) {
                response.write("<p>" + i + " " + balanceHistory[i] + "</p>")
            }
        }
        response.write("</body></html>")
    }
    response.end()
});

var pairs = []
var pairsExploded

var altnames = []
var pairPrecision = []
var ordermin = []

// determine pairs
kraken.api('AssetPairs', null, function (error, pairdata) {

    if (error) {

        log("Critical error fetching asset pairs: " + error)
        process.exit(1)

    } else {

        // push all pairs into an array
        for (var assetpair in pairdata['result']) {
            pairs.push(assetpair)
            altnames[assetpair] = pairdata['result'][assetpair].altname
            pairPrecision[assetpair] = pairdata['result'][assetpair].pair_decimals
            ordermin[assetpair] = pairdata['result'][assetpair].ordermin
        }

        // filter out what we want
        pairs = pairs.filter(function (pair) {
            return pair.endsWith("EUR")
        })

        // call cleanup to see if we have covered all the asset pairs
        pairs.forEach(function (pair) {
            trimPriceForAPI(pair, 1)
        })

        shuffleArray(pairs)

        // get the exploded variant 
        pairsExploded = pairs.join()

        if (trading) log("trading on pairs: " + pairsExploded)
        else log("NOT trading!")

        // do initial requests
        setTimeout(getTradeBalance, 1000)
        setTimeout(getTradeHistory, 4000)
        setTimeout(updateOpenOrders, 2000)
        setTimeout(getTicker, 3000)

    }

})

/* Randomize array in-place using Durstenfeld shuffle algorithm */
function shuffleArray(array) {
    for (var i = array.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
}

var ticker

// main routine
setInterval(getTicker, 1000 * engineTick)

function getTicker() {

    // get ticker info for all pairs
    kraken.api('Ticker', {
        "pair": pairsExploded
    }, function (error, tickerdata) {

        if (error) {
            log("Error updating ticker: " + error)
        } else {

            ticker = {}

            // loop through the pairs
            shuffleArray(pairs)
            pairs.forEach(function (pair) {

                // TODO: this only works for ZEUR now and it breaks on XTZEUR :) 
                var asset = pair.replace("ZEUR", "").replace("EUR", "")
                if (pair.indexOf("XTZEUR") > -1) asset = "XTZ"

                // for each pair see if we need to trade
                var lasttrade = tickerdata.result[pair].c[0]
                var daylow = tickerdata.result[pair].l[1]
                var tradevolume = parseInt(tickerdata.result[pair].v[1] * lasttrade)
                var dayhi = tickerdata.result[pair].h[1]

                // update wallet
                if (wallet[asset]) {
                    wallet[asset]['price'] = parseFloat(lasttrade)
                    if (wallet[asset]['amount']) {
                        wallet[asset]['value'] = wallet[asset]['amount'] * wallet[asset]['price']
                    }
                }

                // do some basic intepretation of the data
                var distancefromlow = Math.round((lasttrade - daylow) / (dayhi - daylow) * 100);
                var move = Math.round(((dayhi - daylow) / dayhi) * 100);

                // build ticker
                ticker[pair] = lasttrade + " (" + distancefromlow + "%/" + move + "%) lo:" + daylow + "/hi:" + dayhi + " vol(EUR): " + (tradevolume).toFixed(2)

                // check if we have hard set to skip trading
                if (!trading) return

                // if we don't know our balance we should not trade
                if (!balance) return

                // make sure we have order info before we start trading
                if (ordersDirty) return

                // adjust how fact we buy based on btc price
                let btcPrice = ticker['XXBTZEUR'] ? parseFloat(ticker['XXBTZEUR'].split(" ")[0]) : null
                if (btcPrice && btcPrice < 50000) buyMoveLimit = 25
                if (btcPrice && btcPrice < 35000) buyMoveLimit = 20
                if (btcPrice && btcPrice < 25000) buyMoveLimit = 15

                // determine if we want to buy
                if (move >= buyMoveLimit && distancefromlow <= buyTolerance) {

                    // adjust how much we buy based on btc price
                    let shareOfWallet = 0.75
                    if (btcPrice && btcPrice < 40000) shareOfWallet = 0.66
                    if (btcPrice && btcPrice < 35000) shareOfWallet = 0.60
                    if (btcPrice && btcPrice < 30000) shareOfWallet = 0.50
                    if (btcPrice && btcPrice < 25000) shareOfWallet = 0.40
                    if (btcPrice && btcPrice < 20000) shareOfWallet = 0.25

                    // make sure stable coins don't count toward "share of wallet"
                    const stablestuff = (wallet['PAXG'] ? wallet['PAXG'].value : 0)

                    // also make sure we don't buy stuff below minimum trade volume
                    if (wallet['ZEUR'] && (wallet['ZEUR'].amount + stablestuff) > balance * shareOfWallet && tradevolume > minTradeVolume) {

                        var buyPrice = lasttrade * 0.995
                        var buyVolume = (fixedBuyAmount / buyPrice).toFixed(8)
                        if (ordermin[pair]) buyVolume = Math.max(buyVolume, ordermin[pair])

                        // quick hack to ensure proper input for API
                        buyPrice = trimPriceForAPI(pair, buyPrice)

                        // if we have too much of one asset (including orders!), don't buy more
                        var openBuyOrderValue = sumOpenBuyOrderValue(pair)
                        var ownedAmount = (wallet && wallet[asset] ? wallet[asset]['value'] : null)

                        if ((buyVolume * buyPrice) + openBuyOrderValue + ownedAmount < maxSharePerAsset * balance) {

                            // buy stuff
                            buy(pair, buyVolume, buyPrice, timer)

                            // make the order book "dirty" again otherwise we keep ordering until next update
                            ordersDirty = true
                            setTimeout(updateOpenOrders, 5000)

                        }
                    }
                }

                if (wallet && wallet[asset] && wallet[asset]['amount'] > 0) {

                    // raise the sell price based on movement and a magic value: (10-3) * 0.61 = 4.27%
                    var sellmod = (((Math.max(move, buyMoveLimit) - (buyTolerance / 10)) * 0.61) * .01) + 1
                    var sellPrice = lasttrade * sellmod

                    // quick hack for API
                    sellPrice = trimPriceForAPI(pair, sellPrice)

                    // check open orders to see if a sell order is even still possible
                    var openSellOrderVolume = getSellOrderVolume(pair)
                    var sellVolume = wallet[asset].amount - openSellOrderVolume

                    // don't trade if have too little to sell
                    if (sellVolume * sellPrice > minSellAmount) {

                        sell(pair, sellVolume, sellPrice, timer);

                        // make the order book "dirty" again otherwise we keep ordering until next update
                        ordersDirty = true
                        setTimeout(updateOpenOrders, 5000)

                    }
                }


            })
        }
    })
}

// helper function to easily calculate the total amount of open order value for a given pair
function sumOpenBuyOrderValue(pair) {

    if (!pair) return
    if (!orders) return
    if (!altnames) return

    var sum = 0

    for (var i in orders) {
        // we need to use altnames lookup because of shitty kraken implementation
        if (orders[i].descr.pair == altnames[pair] && orders[i].descr.type == "buy") {
            sum = sum + (orders[i].descr.price * orders[i].vol)
        }
    }

    return sum

}

// helper function to easily calculate the total amount of open order value for a given pair
function getSellOrderVolume(pair) {

    if (!pair) return
    if (!orders) return
    if (!altnames) return

    var sum = 0

    for (var i in orders) {
        // we need to use altnames lookup because of shitty kraken implementation
        if (orders[i].descr.pair == altnames[pair] && orders[i].descr.type == "sell") {
            sum = sum + parseFloat(orders[i].vol)
        }
    }

    return sum

}

var orders = []

setInterval(updateOpenOrders, 1000 * engineTick / 2)

// get ticker info
function updateOpenOrders() {
    kraken.api('OpenOrders', null, function (error, openOrders) {

        // reinitialize orders 
        orders = []

        if (error) {
            log("Error fetching open orders: " + error)
        } else {
            var numOpenOrders = Object.keys(openOrders.result.open).length
            if (numOpenOrders > 0) log("Open orders: " + numOpenOrders)

            // we're not going to cancel orders if we are not trading
            if (!trading) return

            // get current time used to see which orders are too old
            var currentTime = Math.floor(new Date() / 1000);

            // iterate through all the open orders
            for (var order in openOrders.result.open) {

                // fill the orders storage
                orders.push(openOrders.result.open[order])

                // get the order open time 
                var orderTime = openOrders.result.open[order].opentm;
                var orderBuySell = openOrders.result.open[order].descr.type;
                var orderLimitMarket = openOrders.result.open[order].descr.ordertype;

                // cancel our buy limit orders if one is too old
                if (orderTime + maxAgeSeconds < currentTime && orderBuySell == "buy" && orderLimitMarket == "limit") {

                    log("Cancelling order: " + order + "...");
                    kraken.api('CancelOrder', {
                        "txid": order
                    }, function (error) {
                        if (error) {
                            log("Error cancelling order: " + error)
                        }
                    });
                }

            }

            ordersDirty = false

        }
    });
}

var trades = []

// get trade history info
setInterval(getTradeHistory, 1000 * engineTick * 2)

function getTradeHistory() {
    kraken.api('TradesHistory', null, function (error, tradesHistoryData) {
        if (error) {
            log("Error updating trades history: " + error)
        } else {
            trades = []
            for (var trade in tradesHistoryData.result.trades)
                trades.push(tradesHistoryData.result.trades[trade])

            kraken.api('TradesHistory', {
                'ofs': 50
            }, function (error, tradesHistoryData) {
                if (error) {
                    log("Error updating trades history: " + error)
                } else {
                    for (var trade in tradesHistoryData.result.trades)
                        trades.push(tradesHistoryData.result.trades[trade])

                    kraken.api('TradesHistory', {
                        'ofs': 100
                    }, function (error, tradesHistoryData) {
                        if (error) {
                            log("Error updating trades history: " + error)
                        } else {
                            for (var trade in tradesHistoryData.result.trades)
                                trades.push(tradesHistoryData.result.trades[trade])
                        }
                    })

                }
            })
        }
    })
}

var wallet = {}

var balanceHistory = []

// get trade balance info
setInterval(getTradeBalance, 1000 * engineTick / 2)

function getTradeBalance() {
    kraken.api('TradeBalance', {
        "asset": "ZEUR"
    }, function (error, tradeBalanceData) {

        if (error) {
            log("Error getting trade balance: " + error)
        } else {
            balance = parseFloat(tradeBalanceData.result.eb).toFixed(2)
            log("Trade balance: " + balance)

            balanceHistory[new Date().toISOString().substring(0, 13)] = balance

            // get asset balance
            kraken.api('Balance', null, function (error, balanceData) {

                if (error) {

                    log("Error getting balance: " + error)

                } else {

                    // check the items in our current wallet if they are still there
                    for (var walletAsset in wallet) {
                        if (balanceData.result[walletAsset] == null) {
                            wallet[walletAsset] = null
                        }
                    }

                    for (var balanceAsset in balanceData.result) {
                        var amount = parseFloat(balanceData.result[balanceAsset])

                        // FIXME: dirty hack due to messy kraken API 
                        // ticker uses XDGEUR, balance uses XXDG
                        if (balanceAsset.indexOf("XXDG") > -1) {
                            balanceAsset = "XDG"
                        }

                        if (!wallet[balanceAsset]) wallet[balanceAsset] = {}
                        wallet[balanceAsset]['asset'] = balanceAsset
                        wallet[balanceAsset]['amount'] = amount

                        // FIXME: special hack to give base currency balance also a value
                        if (balanceAsset == "ZEUR") wallet[balanceAsset]['value'] = amount

                    }
                }
            });
        }
    });
}

// buy for a given price with built in timer with profit close order
function buy(pair, volume, price, timer) {

    if (volume * price > 0) {

        log("Adding order: buy " + volume + " " + pair + " @ " + price + "...")

        return kraken.api('AddOrder', {
            "pair": pair,
            "type": "buy",
            "ordertype": "limit",
            "volume": volume,
            "price": price,
            "expiretm": "+" + timer,
        }, function (error, buydata) {
            if (error) {
                log("Error adding buy order: " + error.message)
            } else if (buydata) {
                log("[ORDER] " + buydata["result"]["descr"]["order"], pair);
            }
        });
    }
}

// sell order with timed expiration
function sell(pair, volume, price, timer) {

    if (volume * price > 0) {

        log("Adding order: sell " + volume + " " + pair + " @ " + price + "...")

        return kraken.api('AddOrder', {
            "pair": pair,
            "type": "sell",
            "ordertype": "limit",
            "volume": volume,
            "price": price,
            "expiretm": "+" + timer,
        }, function (error, selldata) {
            if (error) {
                log("Error adding sell order: " + error.message)
            } else if (selldata) {
                log("[ORDER] " + selldata["result"]["descr"]["order"], pair);
            }
        });
    }
}

// clean up price to deal with new trade restrictions
function trimPriceForAPI(pair, price) {

    var precision = pairPrecision[pair]
    if (precision > -1) return price.toFixed(precision)
    else {
        log("Error: Unknown price format for pair: " + pair)
        return price
    }
}