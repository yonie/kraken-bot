// set up kraken api
var settings = require("./settings.js");
var KrakenClient = require('kraken-api');
var kraken = new KrakenClient(settings.krakenkey,settings.krakenpasscode);

// logging
var log = require("./log.js");

// how long may an order live
var maxAgeSeconds = settings.maxAgeSeconds;
if (process.argv>2) maxAgeSeconds=[process.argv[2]];

// get ticker info
kraken.api('OpenOrders', null, function(error, data) {
	if (error) log(error);
	else {
		// get current time to see which orders are too old
		currentTime = Math.floor(new Date()/1000);
		log("Current open orders: " + Object.keys(data.result.open).length + ", max age: " + maxAgeSeconds / 60 / 60 +"h");

		var numOrders = 0;

		// iterate through all the open orders
		for (var order in data.result.open) {

			numOrders++;
				
			log("order: " + data.result.open[order].descr.order);

			// get the order open time 
			orderTime = data.result.open[order].opentm;
			orderType = data.result.open[order].descr.type;
			// cancel order if it is too old
			if (orderTime + maxAgeSeconds < currentTime) {
				log("Cancelling order #" + numOrders + " " + order + "...");
				kraken.api('CancelOrder', { "txid" : order }, function (error, data) { 
					if (error) log(error);
				});
			}

		}
	}	
});
