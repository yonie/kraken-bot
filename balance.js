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
		if (error) console.log(error);
		if (!error) {
			// get ticker info to determine total value
//			kraken.api('Ticker', {"pair":"BCHEUR,DASHEUR,EOSEUR,GNOEUR,XETCZEUR,XETHZEUR,XLTCZEUR,XREPZEUR,XXBTZEUR,XXLMZEUR,XXMRZEUR,XXRPZEUR,XZECZEUR"}, function(error,tickerData) {
			kraken.api('Ticker', {"pair":"BCHEUR,DASHEUR,XETCZEUR,XETHZEUR,XLTCZEUR,XREPZEUR,XXBTZEUR,XXMRZEUR,XXRPZEUR,XZECZEUR,EOSEUR,GNOEUR"}, function(error,tickerData) {
				if (error) console.log(error);
				else for (var asset in balanceData.result) {
					if (balanceData.result[asset] && balanceData.result[asset]>=0.00001) {
						var logString = asset+": " + parseFloat(balanceData.result[asset]).toFixed(5);
						if (tickerData.result[asset+"ZEUR"]) logString = logString + " for " + tickerData.result[asset+"ZEUR"].c[0] + " = "+parseFloat(balanceData.result[asset]*tickerData.result[asset+"ZEUR"].c[0]).toFixed(2)+" ZEUR";
						if (tickerData.result[asset+"EUR"]) logString = logString + " for " + tickerData.result[asset+"EUR"].c[0] + " = "+parseFloat(balanceData.result[asset]*tickerData.result[asset+"EUR"].c[0]).toFixed(2)+" EUR";
						log(logString);
					}
				}
			});
		}
	});	
});
