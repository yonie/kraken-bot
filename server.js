// TODO: make currency pair configurable
// TODO: make minBTC and maxBTC price configurable

// logging including date/time
let log = require("./log.js");
log("initializing..");

// eslint-disable-next-line no-unused-vars
let dns = require("dns"),
  // eslint-disable-next-line no-unused-vars
  dnscache = require("dnscache")({
    enable: true,
    ttl: 1800,
    cachesize: 1000,
  });

// get the secrets
let secrets = require("./.env");
const krakenKey = secrets.krakenkey;
const krakenPasscode = secrets.krakenpasscode;

// get the settings
let settings = require("./settings.js");
let percentageDrop = settings.percentageDrop;
const stopLossMode = settings.stopLossMode;
const minTradeVolume = settings.minTradeVolume;
const maxSharePerAssetPercent = settings.maxSharePerAssetPercent;
const fixedBuyAmount = settings.fixedBuyAmount;

// internal flag used to keep the engine aware whether orders have been updated
let ORDERS_DIRTY = true;

// how often does the engine refresh data, in seconds
const ENGINE_TICK = 31;

// minimum trade amount before trying a sell order (in eur)
const MIN_SELL_AMOUNT = 10;

// set to false to disable any trading actions, rendering the bot passive 
const IS_TRADING = true;

// how many trades to show in the history list of the web client
const NUM_HISTORY = 150;

// tolerance determines how much % near low the lasttrade needs to be to begin acting
const BUY_TOLERANCE = 25;

// set up kraken api
let KrakenClient = require("kraken-api");
let kraken = new KrakenClient(krakenKey, krakenPasscode);

const http = require("http");
const url = require("url");

const HTTP_PORT = 8000;
const server = http.createServer().listen(HTTP_PORT);

server.on("listening", function () {
  log("listening on port " + HTTP_PORT);
});

let balance;

server.on("request", (request, response) => {
  var contenttype;

  if (request.url.includes("/wallet")) {
    contenttype = "application/json";
    response.writeHead(200, {
      "Content-Type": contenttype,
    });
    response.write(JSON.stringify(wallet));
    response.end();
    return;
  }

  if (request.url.includes("/balance/btc")) {
    contenttype = "application/json";
    response.writeHead(200, {
      "Content-Type": contenttype,
    });
    if (balance && ticker && ticker["XXBTZEUR"]) {
      var result = balance / parseInt(ticker["XXBTZEUR"].split(" ")[0]);
      response.write(JSON.stringify(result));
    }
    response.end();
    return;
  }

  if (request.url.includes("/balance/eur")) {
    contenttype = "application/json";
    response.writeHead(200, {
      "Content-Type": contenttype,
    });
    if (balance) {
      response.write(JSON.stringify(parseFloat(balance)));
    }
    response.end();
    return;
  }

  if (request.url.includes("/trades")) {
    contenttype = "application/json";
    response.writeHead(200, {
      "Content-Type": contenttype,
    });
    response.write(JSON.stringify(trades));
    response.end();
    return;
  }

  if (request.url.includes("/orders")) {
    contenttype = "application/json";
    response.writeHead(200, {
      "Content-Type": contenttype,
    });
    response.write(JSON.stringify(orders));
    response.end();
    return;
  }

  if (request.url.includes("/ticker")) {
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
  response.write("<h1><a href=\"/\">kraken</a></h1>");
  if (balance && wallet["ZEUR"] && wallet["ZEUR"].value)
    response.write(
      "<h2>latest balance: " +
      balance +
      " (" +
      ((wallet["ZEUR"].value / balance) * 100).toFixed(0) +
      "% free)</h2>"
    );

  if (balance && ticker && ticker["XXBTZEUR"])
    response.write(
      `<h3>${(
        balance / parseInt(ticker["XXBTZEUR"].split(" ")[0])
      ).toPrecision(4)} btc</h3>`
    );

  response.write('<a href="/wallet">wallet</a><br/>');
  response.write('<a href="/trades">trades</a><br/>');
  if (orders)
    response.write(
      '<a href="/orders">orders (' + orders.length + ")</a><br/>"
    );
  response.write('<a href="/ticker">ticker</a><br/>');

  let requestedPair = url.parse(request.url, true).query["pair"];
  if (requestedPair)
    response.write(
      "<h3>" +
      requestedPair +
      ": " +
      (ticker ? ticker[requestedPair] : "") +
      "</h3>"
    );

  if (trades) {
    response.write("<p>latest trades:</p>");
    response.write("<ul>");
    for (let i = 0; i < Math.min(trades.length, NUM_HISTORY); i++) {
      if (!trades[i]) continue;
      if (!requestedPair || trades[i]["pair"] === requestedPair) {
        response.write("<li>");
        response.write(
          "" + new Date(trades[i]["time"] * 1000).toLocaleString()
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
    for (let i = 0; i < orders.length; i++) {
      if (!orders[i]) continue;
      if (!requestedPair || orders[i].descr.pair === requestedPair) {
        response.write("<li>");
        response.write(
          "" + new Date(orders[i].opentm * 1000).toLocaleString()
        );
        response.write(" ");
        response.write(orders[i].descr.type);
        response.write(" ");
        response.write(orders[i].vol);
        response.write(' <a href="?pair=' + orders[i].descr.pair + '">');
        response.write(orders[i].descr.pair);
        response.write("</a> ");
        response.write(" @ ");
        response.write(orders[i].descr.price);
        response.write(" = ");
        response.write("" + orders[i].descr.price * orders[i].vol);
        response.write("</li>");
      }
    }
    response.write("</ul>");
  }

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

let altnames = [];
let pairPrecision = [];
let ordermin = [];

// determine pairs
// TODO: this should be re-run after some time to prevent "asset unknown" errors after a while of running
kraken.api("AssetPairs", null, function (error, pairdata) {
  if (error) {
    console.error("Critical error fetching asset pairs:", error);
    process.exit(1);
  }

  // push all pairs into an array
  pairs = [];
  for (let assetpair in pairdata["result"]) {
    pairs.push(assetpair);
    altnames[assetpair] = pairdata["result"][assetpair].altname;
    pairPrecision[assetpair] = pairdata["result"][assetpair].pair_decimals;
    ordermin[assetpair] = pairdata["result"][assetpair].ordermin;
  }

  // filter out what we want
  pairs = pairs.filter(function (pair) {
    return pair.endsWith("EUR");
  });

  // call cleanup to see if we have covered all the asset pairs
  pairs.forEach(function (pair) {
    trimToPrecision(pair, 1);
  });

  shuffleArray(pairs);

  // get the exploded variant
  pairsExploded = pairs.join();

  IS_TRADING ? log("trading on " + pairs.length + " pairs.") : log("NOT trading!");

  // do initial requests
  setTimeout(getTradeBalance, 1000);
  setTimeout(getTradeHistory, 4000);
  setTimeout(updateOpenOrders, 2000);
  setTimeout(getTicker, 3000);
});

/* Randomize array in-place using Durstenfeld shuffle algorithm */
function shuffleArray(array) {
  for (var i = array.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
}

var ticker;

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
        console.error(error);
        return;
      }

      ticker = {};

      // loop through the pairs
      shuffleArray(pairs);
      pairs.forEach(function (pair) {
        // TODO: this only works for ZEUR now and it breaks on XTZEUR :)
        var asset = pair.replace("ZEUR", "").replace("EUR", "");
        if (pair.indexOf("XTZEUR") > -1) asset = "XTZ";
        if (pair.indexOf("CHZEUR") > -1) asset = "CHZ";
        if (pair.indexOf("BLZEUR") > -1) asset = "BLZ";

        // for each pair see if we need to trade
        var lasttrade = trimToPrecision(
          pair,
          parseFloat(tickerdata.result[pair].c[0])
        );
        var daylow = trimToPrecision(
          pair,
          parseFloat(tickerdata.result[pair].l[1])
        );
        var tradevolume = parseFloat(tickerdata.result[pair].v[1] * lasttrade);
        var dayhi = trimToPrecision(
          pair,
          parseFloat(tickerdata.result[pair].h[1])
        );

        if (!daylow || !dayhi || !lasttrade) {
          console.error("Missing ticker data.", daylow, dayhi, lasttrade)
          return
        }

        // update wallet
        if (wallet[asset]) {
          wallet[asset]["price"] = parseFloat(lasttrade);
          if (wallet[asset]["amount"]) {
            wallet[asset]["value"] =
              wallet[asset]["amount"] * wallet[asset]["price"];
          }
        }

        // do some basic intepretation of the data
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
          tradevolume.toFixed(2);

        // check if we have hard set to skip trading
        if (!IS_TRADING) {
          return;
        }

        // if we don't know our balance we should not trade
        if (!balance) {
          return;
        }

        // make sure we have order info before we start trading
        if (ORDERS_DIRTY) {
          return;
        }

        console.info(
          "considering pair",
          pair,
          "move",
          move,
          "distancefromlow",
          distancefromlow,
          "tradevolume",
          tradevolume.toFixed(2)
        );

        // determine if we want to buy
        if (!stopLossMode && move >= percentageDrop && distancefromlow <= BUY_TOLERANCE) {
          // adjust how much we buy based on btc price
          let shareOfWallet = 0.75;
          let btcPrice = ticker["XXBTZEUR"]
            ? parseFloat(ticker["XXBTZEUR"].split(" ")[0])
            : null;
          if (btcPrice && btcPrice < 45000) shareOfWallet = 0.86;
          if (btcPrice && btcPrice < 40000) shareOfWallet = 0.67;
          if (btcPrice && btcPrice < 35000) shareOfWallet = 0.52;
          if (btcPrice && btcPrice < 30000) shareOfWallet = 0.4;
          if (btcPrice && btcPrice < 25000) shareOfWallet = 0.31;
          if (btcPrice && btcPrice < 20000) shareOfWallet = 0.24;
          if (btcPrice && btcPrice < 15000) shareOfWallet = 0.19;

          // make sure stable coins don't count toward "share of wallet"
          const stablestuff =
            wallet["PAXG"] && wallet["PAXG"].value ? wallet["PAXG"].value : 0;

          // also make sure we don't buy stuff below minimum trade volume
          if (
            wallet["ZEUR"] &&
            wallet["ZEUR"].amount + stablestuff > balance * shareOfWallet &&
            tradevolume > minTradeVolume
          ) {
            let buyPrice = lasttrade;
            let buyVolume = (fixedBuyAmount / buyPrice).toFixed(8);

            if (ordermin[pair]) buyVolume = Math.max(buyVolume, ordermin[pair]);

            // if we have too much of one asset (including orders!), don't buy more
            var buyOrderValue = sumOpenBuyOrderValue(pair);
            var ownedAssetValue =
              wallet && wallet[asset] ? wallet[asset]["value"] : null;

            if ((buyVolume * buyPrice) + buyOrderValue + ownedAssetValue < (maxSharePerAssetPercent / 100) * balance) {
              // buy stuff
              buy(pair, buyVolume);

              // make the order book "dirty" again (otherwise we keep ordering until next order book update)
              ORDERS_DIRTY = true;
              setTimeout(updateOpenOrders, 5000);
            }
          }
        }

        if (wallet && wallet[asset] && wallet[asset]["amount"] > 0) {
          // determine the sell price based on observed movement and a magic value: ex. (10-3) * 0.61 = 4.27%
          const SELL_RATIO = 0.61;
          var sellmod =
            (Math.max(move, percentageDrop) - BUY_TOLERANCE / 10) * SELL_RATIO * 0.01 +
            1;
          var sellPrice = lasttrade * sellmod;

          // quick hack for API
          sellPrice = trimToPrecision(pair, sellPrice);
          if (!sellPrice) {
            console.error("Error calculating sell price.", pair, sellPrice)
            return
          }

          // check open orders to see if a sell order is even still possible
          const openSellOrderVolume = getSellOrderVolume(pair);
          const notForSale = wallet[asset]["amount"] - openSellOrderVolume;
          if (notForSale * lasttrade > fixedBuyAmount / 2) console.info("Found asset somehow not for sale:", pair, notForSale, notForSale * lasttrade)

          const walletAmount = wallet[asset].amount;

          // sell volume is what remains decucing open orders from the held amount
          let sellVolume = walletAmount - openSellOrderVolume;

          // don't trade if have too little to sell
          if (sellVolume * sellPrice > MIN_SELL_AMOUNT) {

            if (!stopLossMode) sell("limit", pair, sellVolume, sellPrice);
            if (stopLossMode) sell("stop-loss", pair, sellVolume, lasttrade * 0.97)

            // make the order book "dirty" again otherwise we keep ordering until next update
            ORDERS_DIRTY = true;
            setTimeout(updateOpenOrders, 5000);
          }
        }
      });
    }
  );
}

// helper function to easily calculate the total amount of open order value for a given pair
function sumOpenBuyOrderValue(pair) {
  if (!pair) return;
  if (!orders) return;
  if (!altnames) return;

  var sum = 0;

  for (var i in orders) {
    // we need to use altnames lookup because of shitty kraken implementation
    if (
      orders[i].descr.pair == altnames[pair] &&
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
  if (!altnames) return;

  var sum = 0;

  for (var i in orders) {
    // we need to use altnames lookup because of shitty kraken implementation
    if (
      orders[i].descr.pair == altnames[pair] &&
      orders[i].descr.type == "sell"
    ) {
      sum = sum + parseFloat(orders[i].vol);
    }
  }

  return sum;
}

var orders = [];

setInterval(updateOpenOrders, (1000 * ENGINE_TICK) / 2);

// update open orders
function updateOpenOrders() {
  kraken.api("OpenOrders", null, function (error, openOrders) {
    // reinitialize orders
    orders = [];

    if (error) {
      console.error("Error fetching open orders: ", error);
      ORDERS_DIRTY = true;
      return;
    }

    // we're not going to cancel orders if we are not trading
    if (!IS_TRADING) return;

    // iterate through all the open orders
    for (var order in openOrders.result.open) {

      // fill the orders storage
      orders.push(openOrders.result.open[order]);

      // get the order information
      var orderBuySell = openOrders.result.open[order].descr.type;
      var orderLimitMarket = openOrders.result.open[order].descr.ordertype;
      var orderPrice = openOrders.result.open[order].descr.price;
      var orderPair = openOrders.result.open[order].descr.pair;

      var currentPrice = (ticker && ticker[orderPair]) ? ticker[orderPair].split(" ")[0] : null;

      // if we are in stoploss mode, cancel all limit sell orders
      if (stopLossMode && orderBuySell == "sell" && orderLimitMarket == "limit") cancelOrder(order);

      // in normal mode, cancel orders that are too far out
      if (!stopLossMode && orderBuySell == "sell" && orderLimitMarket == "limit" && currentPrice && orderPrice > currentPrice * 10) cancelOrder(order)

      // in stop loss mode, if we have a stop loss order that we should replan, cancel it so a new one can be made
      if (stopLossMode && orderBuySell == "sell" && orderLimitMarket == "stop-loss" && currentPrice && orderPrice < currentPrice * 0.97) cancelOrder(order);
    }

    ORDERS_DIRTY = false;
  });
}

var trades = [];

// get trade history info
setInterval(getTradeHistory, 1000 * ENGINE_TICK * 2);

// cancels order for given order id
function cancelOrder(order) {
  log("Cancelling order: " + order + "...");
  kraken.api(
    "CancelOrder",
    {
      txid: order,
    },
    function (error) {
      if (error) {
        console.error("Error cancelling order:", error);
      }
    }
  );
}

function getTradeHistory() {
  kraken.api("TradesHistory", null, function (error, tradesHistoryData) {
    if (error) {
      console.error("Error updating trades history:", error);
      return;
    }

    trades = [];
    for (var trade in tradesHistoryData.result.trades)
      trades.push(tradesHistoryData.result.trades[trade]);

    kraken.api(
      "TradesHistory",
      {
        ofs: 50,
      },
      function (error, tradesHistoryData) {
        if (error) {
          console.error("Error updating trades history:", error);
          return;
        }

        for (var trade in tradesHistoryData.result.trades)
          trades.push(tradesHistoryData.result.trades[trade]);

        kraken.api(
          "TradesHistory",
          {
            ofs: 100,
          },
          function (error, tradesHistoryData) {
            if (error) {
              console.error("Error updating trades history:", error);
              return;
            }

            for (var trade in tradesHistoryData.result.trades)
              trades.push(tradesHistoryData.result.trades[trade]);
          }
        );
      }
    );
  });
}

var wallet = {};

var balanceHistory = [];

// get trade balance info
setInterval(getTradeBalance, (1000 * ENGINE_TICK) / 2);

function getTradeBalance() {
  kraken.api(
    "TradeBalance",
    {
      asset: "ZEUR",
    },
    function (error, tradeBalanceData) {
      if (error) {
        console.error("Error getting trade balance:", error);
        return;
      }

      balance = parseFloat(tradeBalanceData.result.eb).toFixed(2);
      log("Trade balance: " + balance);

      balanceHistory[new Date().toISOString().substring(0, 13)] = balance;

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

        for (var balanceAsset in balanceData.result) {
          var amount = parseFloat(balanceData.result[balanceAsset]);

          // FIXME: dirty hack due to messy kraken API
          // ticker uses XDGEUR, balance uses XXDG
          if (balanceAsset.indexOf("XXDG") > -1) {
            balanceAsset = "XDG";
          }

          if (!wallet[balanceAsset]) wallet[balanceAsset] = {};
          wallet[balanceAsset]["asset"] = balanceAsset;
          wallet[balanceAsset]["amount"] = amount;

          // FIXME: special hack to give base currency balance also a value
          if (balanceAsset == "ZEUR") wallet[balanceAsset]["value"] = amount;
        }
      });
    }
  );
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
        volume: volume
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
          console.error(pair, volume, price, "Error adding sell order", error.message);
          return;
        }

        if (selldata) {
          log("[ORDER] " + selldata["result"]["descr"]["order"], pair);
        }
      }
    );
  }
}

// clean up price to deal with specifications imposed by kraken API
function trimToPrecision(pair, price) {
  if (!pair || !price) {
    console.error("Invalid arguments.", pair, price);
    return;
  }
  var precision = pairPrecision[pair];

  if (precision > -1) return price.toFixed(precision);

  console.error("Unknown price format for pair.", pair);
  return price;
}
