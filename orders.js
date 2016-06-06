// set up kraken api
var settings = require("./settings.js");
var KrakenClient = require('kraken-api');
var kraken = new KrakenClient(settings.krakenkey,settings.krakenpasscode);

var maxAgeSeconds = 24 * 60 * 60;

// get ticker info
kraken.api('OpenOrders', null, function(error, data) {
	if (error) console.log(error);
	else {
		// get current time to see which orders are too old
		currentTime = Math.floor(new Date()/1000);
		console.log("Current open orders: " + Object.keys(data.result.open).length);

		// iterate through all the open orders
		for (var order in data.result.open) {

			// get the order open time 
			orderTime = data.result.open[order].opentm;
		
			// cancel order if it is too old
			if (orderTime + maxAgeSeconds < currentTime) {
				console.log("Cancelling order " + order + "...");
				kraken.api('CancelOrder', { "txid" : order }, function (error, data) { 
					if (error) console.log(error);
				});
			}
		}
	}	
});

			

