// set up kraken api
var settings = require("./settings.js");
var KrakenClient = require('kraken-api');
var kraken = new KrakenClient(settings.krakenkey,settings.krakenpasscode);

// logging
var log = require('./log.js');

// get trade balance info
kraken.api('TradeBalance', {"asset":"ZEUR"}, function(error, tradeBalanceData) {
	if (!error) log("Trade balance: "+parseFloat(tradeBalanceData.result.eb).toFixed(2));
	// get asset balance
	kraken.api('Balance',null, function(error,balanceData) {
		if (!error) {
			// get ticker info to determine total value
			kraken.api('Ticker', {"pair":"XETCZEUR,XETHZEUR,XLTCZEUR,XREPZEUR,XXBTZEUR,XXLMZEUR,XXMRZEUR,XZECZEUR"}, function(error,tickerData) {
				for (var asset in balanceData.result) {
					if (balanceData.result[asset] && balanceData.result[asset]>=0.00001) {
						var logString = asset+": " + parseFloat(balanceData.result[asset]).toFixed(5);
						if (tickerData.result[asset+"ZEUR"]) logString = logString + " for " + tickerData.result[asset+"ZEUR"].c[0] + " = "+parseFloat(balanceData.result[asset]*tickerData.result[asset+"ZEUR"].c[0]).toFixed(2)+" ZEUR";
						log(logString);
					}
				}
			});
		}
	});	
});
