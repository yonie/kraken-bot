// @ts-check

let logs = [];

// simple log helper, tradepair is optional
function log(string, pair) {
  if (typeof pair === "undefined") {
    pair = "";
  }

  var d = new Date();
  var datestring =
    ("0" + d.getDate()).slice(-2) +
    "-" +
    ("0" + (d.getMonth() + 1)).slice(-2) +
    "-" +
    d.getFullYear() +
    " " +
    ("0" + d.getHours()).slice(-2) +
    ":" +
    ("0" + d.getMinutes()).slice(-2);

  let fullMessage = datestring + " " + (pair != "" ? pair + " " : "") + string;

  console.log(fullMessage);
  logs.unshift(fullMessage);
}

// logging including date/time
log("initializing..");

// eslint-disable-next-line no-unused-vars
let dns = require("dns"),
  dnscache = require("dnscache")({ enable: true, ttl: 1800, cachesize: 1000 });

// get the secrets
require("dotenv").config();
const krakenKey = process.env.KRAKEN_KEY;
const krakenPasscode = process.env.KRAKEN_PASSCODE;

// get the settings
let settings = require("./settings.js");
const percentageDrop = settings.percentageDrop;
const stopLossPercentage = settings.stopLossPercentage;
const minTradeVolume = settings.minTradeVolume;
const maxSharePerAssetPercent = settings.maxSharePerAssetPercent;
const fixedBuyAmount = settings.fixedBuyAmount;
const maxGreedPercentage = settings.maxGreedPercentage;

if (
  !percentageDrop ||
  !stopLossPercentage ||
  !minTradeVolume ||
  !maxSharePerAssetPercent ||
  !fixedBuyAmount ||
  !maxGreedPercentage
) {
  console.error("Critical error: missing (part of) settings.js file.");
  process.exit(1);
}

// how often does the engine refresh data, in seconds
// note anything lower than about 30 will get you into API rate limiting
const ENGINE_TICK = 31;

// minimum trade amount before trying a sell order (in eur)
// note values lower than 10 can lead to API errors from Kraken
const MIN_SELL_AMOUNT = 10;

// set to false to disable any trading actions, rendering the bot passive
const TRADING_ENABLED = true;

// how many trades to show in the history list of the web client
const NUM_TRADE_HISTORY = 150;

// determines how much % near low the lasttrade needs to be to consider buying
// eg. set to 0 to only buy assets that are at their lowest observed point
const BUY_TOLERANCE = 20;

// the maximum amount an asset can crash before we begin to ignore it
const MAX_DROP = 40;

// internally used to check if we are in stoploss mode
let STOP_LOSS_MODE;

// internal flag used to keep the engine aware whether orders have been updated
let ORDERS_DIRTY = true;

// set up kraken api
let KrakenClient = require("kraken-api");
let kraken = new KrakenClient(krakenKey, krakenPasscode);

const http = require("http");
const url = require("url");

// port where the internal web interface is available. set to -1 to disable internal web server
const HTTP_PORT = 8000;

const server = http.createServer();
if (HTTP_PORT > -1) server.listen(HTTP_PORT);

server.on("listening", function () {
  log("listening on port " + HTTP_PORT);
});

let tradeBalance;

// internal web server, can be used for inspection of operation
server.on("request", (request, response) => {
  var contenttype;

  // json array of wallet data
  if (request.url?.includes("/wallet")) {
    contenttype = "application/json";
    response.writeHead(200, {
      "Content-Type": contenttype,
    });
    response.write(JSON.stringify(wallet));
    response.end();
    return;
  }

  // endpoint for external value trackers
  if (request.url?.includes("/balance/btc")) {
    contenttype = "application/json";
    response.writeHead(200, {
      "Content-Type": contenttype,
    });
    if (tradeBalance && ticker && ticker["XXBTZEUR"]) {
      var result = tradeBalance / parseInt(ticker["XXBTZEUR"].split(" ")[0]);
      response.write(JSON.stringify(result));
    }
    response.end();
    return;
  }

  // endpoint for external value trackers
  if (request.url?.includes("/balance/eur")) {
    contenttype = "application/json";
    response.writeHead(200, {
      "Content-Type": contenttype,
    });
    if (tradeBalance) {
      response.write(JSON.stringify(parseFloat(tradeBalance)));
    }
    response.end();
    return;
  }

  // json array of known trade history
  if (request.url?.includes("/trades")) {
    contenttype = "application/json";
    response.writeHead(200, {
      "Content-Type": contenttype,
    });
    response.write(JSON.stringify(trades));
    response.end();
    return;
  }

  // json array of current orders
  if (request.url?.includes("/orders")) {
    contenttype = "application/json";
    response.writeHead(200, {
      "Content-Type": contenttype,
    });
    response.write(JSON.stringify(orders));
    response.end();
    return;
  }

  // json array of logs
  if (request.url?.includes("/logs")) {
    contenttype = "application/json";
    response.writeHead(200, {
      "Content-Type": contenttype,
    });
    response.write(JSON.stringify(logs.slice(0,1000)));
    response.end();
    return;
  }

  // custom formatted price information
  if (request.url?.includes("/ticker")) {
    contenttype = "application/json";
    response.writeHead(200, {
      "Content-Type": contenttype,
    });
    response.write(JSON.stringify(ticker));
    response.end();
    return;
  }

  contenttype = "text/html";
  response.writeHead(200, {
    "Content-Type": contenttype,
  });
  response.write(
    "<!doctype HTML><html><head><title>kraken</title></head><body>"
  );
  response.write('<h1><a href="/">kraken</a></h1>');
  if (tradeBalance && wallet["ZEUR"] && wallet["ZEUR"].value)
    response.write(
      "<h2>latest balance: " +
        tradeBalance +
        " (" +
        ((wallet["ZEUR"].value / tradeBalance) * 100).toFixed(0) +
        "% free)</h2>"
    );

  // try to show btc value next to eur value
  if (tradeBalance && ticker && ticker["XXBTZEUR"]) {
    response.write(
      `<h3>${(
        tradeBalance / parseInt(ticker["XXBTZEUR"].split(" ")[0])
      ).toPrecision(4)} btc`
    );
    if (greedValue) response.write(` (greed index: ${greedValue}%)`);
    response.write(`</h3>`);
    if (STOP_LOSS_MODE) response.write(`<h4>note: stop loss mode active!</h4>`);
  }

  response.write('<a href="/wallet">wallet</a><br/>');
  response.write('<a href="/trades">trades</a><br/>');
  if (orders)
    response.write(
      '<a href="/orders">orders (' + Object.keys(orders).length + ")</a><br/>"
    );
  response.write('<a href="/ticker">ticker</a><br/>');
  response.write('<a href="/logs">logs</a><br/>');

  // we support selecting a single assets to see data for eg. ?pair=btceur
  let requestedPair = request.url
    ? getPrimaryNameForAsset(url.parse(request.url, true).query["pair"])
    : null;
  if (requestedPair) {
    response.write(
      "<h3>" +
        requestedPair +
        ": " +
        (ticker && ticker[requestedPair] ? ticker[requestedPair] : "") +
        "</h3>"
    );
    //const asset = requestedPair.slice(0, -3);
    const asset = pairs[requestedPair].base;
    if (wallet[asset].amount && wallet[asset].value)
      response.write(
        "<h4>Current holdings: " +
          " $" +
          asset +
          " " +
          wallet[asset].amount +
          " (eur " +
          wallet[asset].value.toFixed(2) +
          ")</h4>"
      );
  }

  if (trades) {
    response.write("<p>latest trades:</p>");
    response.write("<ul>");
    for (let i = 0; i < Math.min(trades.length, NUM_TRADE_HISTORY); i++) {
      if (!trades[i]) continue;
      // filter for desired pair if provided
      if (
        !requestedPair ||
        trades[i].pair === requestedPair ||
        trades[i].pair == pairs[requestedPair]?.altname
      ) {
        response.write("<li>");
        response.write(
          "" + new Date(trades[i]["time"] * 1000).toLocaleString("nl-NL")
        );
        response.write(" ");
        response.write(trades[i]["type"]);
        response.write(" ");
        response.write(trades[i]["vol"]);
        response.write(' <a href="?pair=' + trades[i]["pair"] + '">');
        response.write(trades[i]["pair"]);
        response.write("</a> ");
        response.write(" @ ");
        response.write(trades[i]["price"]);
        response.write(" = ");
        response.write(trades[i]["cost"]);
        response.write("</li>");
      }
    }
    response.write("</ul>");
  }

  if (orders) {
    response.write("<p>latest orders:</p>");
    response.write("<ul>");
    Object.keys(orders).forEach(function (orderId) {
      const order = orders[orderId];
      // filter for desired pair if provided
      if (
        !requestedPair ||
        order.descr.pair === requestedPair ||
        order.descr.pair === pairs[requestedPair]?.altname
      ) {
        response.write("<li>");
        response.write(
          "" + new Date(order.opentm * 1000).toLocaleString("nl-NL")
        );
        response.write(" ");
        response.write(order.descr.type);
        response.write(" ");
        response.write(order.vol);
        response.write(' <a href="?pair=' + order.descr.pair + '">');
        response.write(order.descr.pair);
        response.write("</a> ");
        response.write(" @ ");
        response.write(order.descr.price);
        response.write(" = ");
        response.write("" + order.descr.price * order.vol);
        response.write("</li>");
      }
    });
    response.write("</ul>");
  }

  // basic history showing recent balance changes over time
  if (balanceHistory) {
    for (let i in balanceHistory) {
      response.write("<p>" + i + " " + balanceHistory[i] + "</p>");
    }
  }
  response.write("</body></html>");
  response.end();
});

let pairs;
let pairsExploded;

// determine pairs
kraken.api("AssetPairs", null, function (error, pairdata) {
  if (error) {
    console.error("Critical error fetching asset pairs:", error);
    process.exit(1);
  }

  // push all pairs into an object
  pairs = {};
  for (let assetpair in pairdata["result"]) {
    if (assetpair.endsWith("EUR"))
      pairs[assetpair] = pairdata["result"][assetpair];
  }

  // get the exploded variant
  pairsExploded = Object.keys(pairs).join();

  TRADING_ENABLED
    ? log("trading on " + Object.keys(pairs).length + " pairs.")
    : log("NOT trading!");

  // do initial requests
  setTimeout(updateBalance, 1000);
  setTimeout(getTradeHistory, 4000);
  setTimeout(updateOpenOrders, 2000);
  setTimeout(getTicker, 3000);
});

var ticker = {};

// main routine
setInterval(getTicker, 1000 * ENGINE_TICK);

function getTicker() {
  // get ticker info for all pairs
  kraken.api(
    "Ticker",
    {
      pair: pairsExploded,
    },
    function (error, tickerdata) {
      if (error) {
        console.error("Critical error fetching ticker data:", error);
        process.exit(1);
      }

      let balanceSum = 0;

      // loop through the pairs in a random order
      Object.keys(tickerdata.result).forEach(function (pair) {
        const asset = pairs[pair].base;

        // for each pair see if we need to trade
        var lasttrade = trimToPrecision(
          pair,
          parseFloat(tickerdata.result[pair].c[0])
        );
        var daylow = trimToPrecision(
          pair,
          parseFloat(tickerdata.result[pair].l[1])
        );
        var tradevolume = Math.round(tickerdata.result[pair].v[1] * lasttrade);
        var dayhi = trimToPrecision(
          pair,
          parseFloat(tickerdata.result[pair].h[1])
        );

        if (!daylow || !dayhi || !lasttrade) {
          console.error("Missing ticker data.", daylow, dayhi, lasttrade);
          return;
        }

        // update wallet
        if (wallet[asset]) {
          wallet[asset]["price"] = parseFloat(lasttrade);
          if (wallet[asset]["amount"]) {
            wallet[asset]["value"] =
              wallet[asset]["amount"] * wallet[asset]["price"];

            // add to our total observed balance
            balanceSum += wallet[asset].value;
          }
        }

        // do some basic intepretation of the ticker data
        var distancefromlow = Math.round(
          ((lasttrade - daylow) / (dayhi - daylow)) * 100
        );
        var move = Math.round(((dayhi - daylow) / dayhi) * 100);

        // build ticker
        ticker[pair] =
          lasttrade +
          " (" +
          distancefromlow +
          "%/" +
          move +
          "%) lo:" +
          daylow +
          "/hi:" +
          dayhi +
          " vol(EUR): " +
          tradevolume;

        // check if we have hard set to skip trading
        if (!TRADING_ENABLED) return;

        // if we don't know our balance we should not trade
        if (!tradeBalance) return;

        // make sure we have order info before we start trading
        if (ORDERS_DIRTY) return;

        // check if we want to buy
        if (
          greedValue && 
          greedValue < maxGreedPercentage && 
          move >= percentageDrop &&
          move < MAX_DROP &&
          distancefromlow <= BUY_TOLERANCE &&
          tradevolume >= minTradeVolume
        )
          considerBuy(pair, lasttrade, asset);

        // check if we want to sell
        if (wallet && wallet[asset] && wallet[asset]["amount"] > 0)
          considerSell(move, lasttrade, pair, asset);
      });

      // add our non-asset balance to complete the sum
      if (wallet && wallet["ZEUR"] && wallet["ZEUR"].value) balanceSum += wallet["ZEUR"].value;
      tradeBalance = balanceSum.toFixed(2);
    }
  );
}

function considerBuy(pair, lasttrade, asset) {
  console.debug("Potentially interesting asset:", pair, ticker[pair]);

  const shareOfWallet = getShareOfWallet();
  if (shareOfWallet == null) return;

  // make sure stable coins don't count toward "share of wallet"
  const stablestuff =
    wallet["PAXG"] && wallet["PAXG"].value ? wallet["PAXG"].value : 0;

  // also make sure we don't buy stuff below minimum trade volume
  if (
    wallet["ZEUR"] &&
    wallet["ZEUR"].amount + stablestuff > tradeBalance * shareOfWallet
  ) {
    let buyPrice = lasttrade;
    let buyVolume = fixedBuyAmount / buyPrice;

    // clean up if we can
    if (pairs[pair].lot_decimals)
      buyVolume = Number(buyVolume.toFixed(pairs[pair].lot_decimals));

    // make sure the minimum order size works with the API
    if (pairs[pair].ordermin)
      buyVolume = Math.max(buyVolume, pairs[pair].ordermin);

    // if we have too much of one asset (including orders!), don't buy more
    const buyOrderValue = sumOpenBuyOrderValue(pair);
    const ownedAssetValue =
      wallet && wallet[asset] && wallet[asset].value
        ? wallet[asset]["value"]
        : 0;

    if (
      buyVolume * buyPrice + (buyOrderValue ?? 0) + ownedAssetValue <
      (maxSharePerAssetPercent / 100) * tradeBalance
    ) {
      // buy stuff
      buy(pair, buyVolume);

      // make the order book "dirty" again (otherwise we keep ordering until next order book update)
      ORDERS_DIRTY = true;
      setTimeout(updateOpenOrders, 5000);
    }
  }
}

function getShareOfWallet() {
  // adjust how much we buy based on btc price
  let btcPrice = ticker["XXBTZEUR"]
    ? parseFloat(ticker["XXBTZEUR"].split(" ")[0])
    : null;

  // if btc price is unknown we're not proceeding
  if (!btcPrice) {
    console.warn("BTC price not yet known, aborting potential trade.");
    return;
  }
  if (btcPrice < 15000) return 0.19;
  if (btcPrice < 20000) return 0.24;
  if (btcPrice < 25000) return 0.31;
  if (btcPrice < 30000) return 0.4;
  if (btcPrice < 35000) return 0.52;
  if (btcPrice < 40000) return 0.67;
  if (btcPrice < 45000) return 0.86;

  return 0.86;
}

function considerSell(move, lasttrade, pair, asset) {
  // determine the sell price based on observed movement and a magic value: ex. (10-3) * 0.61 = 4.27%
  const SELL_RATIO = 0.61;
  var sellmod =
    (Math.max(move, percentageDrop) - BUY_TOLERANCE / 10) * SELL_RATIO * 0.01 +
    1;
  var sellPrice = lasttrade * sellmod;

  // quick hack for API
  sellPrice = trimToPrecision(pair, sellPrice);
  if (!sellPrice) {
    console.error("Error calculating sell price.", pair, sellPrice);
    return;
  }

  // check open orders to see if a sell order is even still possible
  const openSellOrderVolume = getSellOrderVolume(pair);
  const notYetForSale = wallet[asset]["amount"] - (openSellOrderVolume ?? 0);
  if (notYetForSale * lasttrade > MIN_SELL_AMOUNT)
    console.info(
      "Found asset somehow not yet for sale:",
      pair,
      notYetForSale,
      notYetForSale * lasttrade
    );

  const walletAmount = wallet[asset].amount;

  // sell volume is what remains decucing open orders from the held amount
  let sellVolume = walletAmount - (openSellOrderVolume ?? 0);

  // clean up if we can
  if (pairs[pair].lot_decimals)
    sellVolume = Number(sellVolume.toFixed(pairs[pair].lot_decimals));

  // don't trade if have too little to sell
  if (sellVolume * sellPrice > MIN_SELL_AMOUNT) {
    if (!STOP_LOSS_MODE) sell("limit", pair, sellVolume, sellPrice);
    if (STOP_LOSS_MODE)
      sell(
        "stop-loss",
        pair,
        sellVolume,
        trimToPrecision(pair, lasttrade * ((100 - stopLossPercentage) / 100))
      );

    // make the order book "dirty" again otherwise we keep ordering until next update
    //ordersDirty = true;
    setTimeout(updateOpenOrders, 5000);
  }
}

// helper function to easily calculate the total amount of open order value for a given pair
function sumOpenBuyOrderValue(pair) {
  if (!pair) return;
  if (!orders) return;

  var sum = 0;

  for (var i in orders) {
    // we need to use altnames lookup because of shitty kraken implementation
    if (
      orders[i].descr.pair == pairs[pair].altname &&
      orders[i].descr.type == "buy"
    ) {
      sum = sum + orders[i].descr.price * orders[i].vol;
    }
  }

  return sum;
}

// helper function to easily calculate the total amount of open order value for a given pair
function getSellOrderVolume(pair) {
  if (!pair) return;
  if (!orders) return;

  var sum = 0;

  for (var i in orders) {
    // we need to use altnames lookup because of shitty kraken implementation
    if (
      orders[i].descr.pair == pairs[pair].altname &&
      orders[i].descr.type == "sell"
    ) {
      sum = sum + parseFloat(orders[i].vol);
    }
  }

  return sum;
}

let orders = {};

setInterval(updateOpenOrders, (1000 * ENGINE_TICK) / 2);

// update open orders
function updateOpenOrders() {
  kraken.api("OpenOrders", null, function (error, openOrders) {
    // reinitialize orders
    orders = {};

    if (error) {
      console.error("Error fetching open orders: ", error);
      ORDERS_DIRTY = true;
      return;
    }

    // we're not going to cancel orders if we are not trading
    if (!TRADING_ENABLED) return;

    // iterate through all the open orders
    for (var order in openOrders.result.open) {
      // fill the orders storage
      orders[order] = openOrders.result.open[order];

      // get the order information
      const orderBuySell = openOrders.result.open[order].descr.type;
      const orderLimitMarket = openOrders.result.open[order].descr.ordertype;
      const currentOrderPrice = openOrders.result.open[order].descr.price;
      const orderPair = getPrimaryNameForAsset(
        openOrders.result.open[order].descr.pair
      );
      const lastTradePrice =
        ticker && orderPair && ticker[orderPair]
          ? ticker[orderPair].split(" ")[0]
          : null;

      // in stoploss mode, cancel all existing limit sell orders so they can be replaced
      if (
        STOP_LOSS_MODE &&
        orderBuySell == "sell" &&
        orderLimitMarket == "limit"
      ) {
        log(
          "Cancelling limit order as we are in stoploss mode: " +
            orders[order].descr.order
        );
        cancelOrder(order);
      }

      // in normal mode, cancel limit orders that are too far out so they can be resent
      if (
        !STOP_LOSS_MODE &&
        orderBuySell == "sell" &&
        orderLimitMarket == "limit" &&
        lastTradePrice &&
        currentOrderPrice > lastTradePrice * 10
      ) {
        log(
          "Cancelling limit order because it has become unattainable: " +
            orders[order].descr.order
        );
        cancelOrder(order);
      }

      // if we have a stop loss order that we should replan, cancel it so a new one can be made
      const desiredStopLossPrice = lastTradePrice
        ? trimToPrecision(
            orderPair,
            lastTradePrice * ((100 - stopLossPercentage) / 100)
          )
        : null;
      if (
        orderBuySell == "sell" &&
        orderLimitMarket == "stop-loss" &&
        desiredStopLossPrice &&
        currentOrderPrice < desiredStopLossPrice
      ) {
        log(
          "Updating stop loss order with higher price: " +
            orderPair +
            " " +
            currentOrderPrice +
            " --> " +
            desiredStopLossPrice +
            " (+" +
            ((1 - desiredStopLossPrice / currentOrderPrice) * 100).toFixed(1) +
            "%)"
        );
        editOrder(order, orderPair, desiredStopLossPrice);
      }
    }

    ORDERS_DIRTY = false;
  });
}

// returns the primary name for an asset if an altname is provided
function getPrimaryNameForAsset(altname) {
  let found = null;
  if (!altname || !pairs) return null;
  Object.keys(pairs).forEach(function (pair) {
    if (pairs[pair].altname == altname || pair == altname) {
      found = pair;
    }
  });
  return found;
}

var trades = [];

// get trade history info
setInterval(getTradeHistory, 1000 * ENGINE_TICK * 2);

// fetch trade history in batches. this call is batched to prevent rate limiting by kraken.
function getTradeHistory() {
  trades = [];

  // hardcoded max size in kraken api
  const sample = 50;
  const delayms = 105;

  // how much history do we want
  const max = 50;

  for (let i = 0; i < max; i += sample) {
    setTimeout(function () {
      kraken.api(
        "TradesHistory",
        { ofs: i },
        function (error, tradesHistoryData) {
          if (error) {
            console.error("Error updating trades history:", error);
            return;
          }

          for (var trade in tradesHistoryData.result.trades) {
            trades.push(tradesHistoryData.result.trades[trade]);
          }
        }
      );
    }, delayms * i);
  }
}

var wallet = {};

var balanceHistory = [];

var greedValue = null;
var greedValueClassification = null;

// update greed
setTimeout(getGreedStatistics, 1000);
setInterval(getGreedStatistics, 1000 * ENGINE_TICK * 2 * 5);

// we are getting greed stats from an external source, which informs us if
// we need to enter stop loss mode.
function getGreedStatistics() {
  const https = require("https");
  const apiUrl = "https://api.alternative.me/fng/?limit=2";

  https
    .get(apiUrl, (response) => {
      let data = "";

      response.on("data", (chunk) => {
        data += chunk;
      });

      response.on("end", () => {

        try {
          const apiResponse = JSON.parse(data);
          greedValue = apiResponse.data[0].value;
          const previousGreedValue = apiResponse.data[1].value;
          greedValueClassification = apiResponse.data[0].value_classification;

          if (greedValue && greedValueClassification) {
            // if greed is too high, we should exit positions
            STOP_LOSS_MODE = (greedValue >= maxGreedPercentage && previousGreedValue >= maxGreedPercentage)
  
            log(
              "Current greed index: " +
                greedValueClassification +
                " (" +
                greedValue +
                "%). " +
                "Stop loss mode: " +
                STOP_LOSS_MODE
            );
          }

        } catch (error) {
          console.error("Error parsing greed data:", error);
        }

      });
    })
    .on("error", (error) => {
      console.error("Error fetching greed data:", error);
    });
}

// get trade balance info
setInterval(updateBalance, 1000 * ENGINE_TICK);

function updateBalance() {
  const btcValue = ticker["XXBTZEUR"]
    ? (tradeBalance / parseFloat(ticker["XXBTZEUR"]))
    : null;
  if (tradeBalance && btcValue)
    log("Trade balance: " + tradeBalance + " (" + btcValue.toFixed(3) + " btc)");
    log("Performance score: " + (Math.round(tradeBalance * btcValue * 100)/1000).toFixed(3));

  balanceHistory[new Date().toISOString().substring(0, 13)] = tradeBalance;

  // get asset balance
  kraken.api("Balance", null, function (error, balanceData) {
    if (error) {
      console.error("Error getting balance:", error);
      return;
    }

    // check the items in our current wallet if they are still there
    for (var walletAsset in wallet) {
      if (balanceData.result[walletAsset] == null) {
        wallet[walletAsset] = null;
      }
    }

    for (var assetName in balanceData.result) {
      var amount = parseFloat(balanceData.result[assetName]);

      if (!wallet[assetName]) wallet[assetName] = {};
      wallet[assetName]["asset"] = assetName;
      wallet[assetName]["amount"] = amount;

      // ensure base currency balance also has value
      if (assetName == "ZEUR") wallet[assetName]["value"] = amount;
    }
  });
}

// buy for a given price
function buy(pair, volume) {
  if (volume > 0) {
    log("Adding order: buy " + volume + " " + pair + " @ market...");

    return kraken.api(
      "AddOrder",
      {
        pair: pair,
        type: "buy",
        ordertype: "market", // NOTE we are market buying effectively ignoring price
        volume: volume,
      },
      function (error, buydata) {
        if (error) {
          console.error("Error adding buy order:", error.message);
          return;
        }

        if (buydata) {
          log("[ORDER] " + buydata["result"]["descr"]["order"], pair);
        }
      }
    );
  }
}

// sell order
function sell(type, pair, volume, price) {
  if (type != "limit" && type != "stop-loss") {
    log("Invalid sell order type.");
    return;
  }

  if (volume * price > 0) {
    log("Adding order: sell " + volume + " " + pair + " @ " + price + "...");

    return kraken.api(
      "AddOrder",
      {
        pair: pair,
        type: "sell",
        ordertype: type,
        volume: volume,
        price: price,
      },
      function (error, selldata) {
        if (error) {
          console.error(
            pair,
            volume,
            price,
            "Error adding sell order",
            error.message
          );
          return;
        }

        if (selldata) {
          log("[ORDER] " + selldata["result"]["descr"]["order"], pair);
        }
      }
    );
  }
}

// edits order for given order id
function editOrder(orderId, orderPair, newPrice) {
  if (!orderId || !orderPair || !newPrice) return false;

  console.debug("Edit order:", orderId, orderPair, newPrice);

  kraken.api(
    "EditOrder",
    {
      txid: orderId,
      pair: orderPair,
      price: newPrice,
    },
    function (error) {
      if (error) {
        console.error("Error editing order:", error);
        return false;
      }
      return true;
    }
  );
}

// cancels order for given order id
function cancelOrder(orderId) {
  if (!orderId) return false;

  console.debug("Cancelling order:", orderId);

  kraken.api(
    "CancelOrder",
    {
      txid: orderId,
    },
    function (error) {
      if (error) {
        console.error("Error cancelling order:", error);
        return false;
      }
      return true;
    }
  );
}

// clean up price to deal with specifications imposed by kraken API
function trimToPrecision(pair, priceToTrim) {
  if (!pair || !priceToTrim) {
    console.error("Invalid arguments.", pair, priceToTrim);
    return;
  }
  var precision = pairs[pair].pair_decimals;

  if (precision > -1) return priceToTrim.toFixed(precision);

  console.error("Unknown price format for pair.", pair);
  return priceToTrim;
}
