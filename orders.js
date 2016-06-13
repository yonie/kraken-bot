// set up kraken api
var settings = require("./settings.js");
var KrakenClient = require('kraken-api');
var kraken = new KrakenClient(settings.krakenkey,settings.krakenpasscode);

// how long may an order live
var maxAgeSeconds = settings.maxAgeSeconds;
if (process.argv>2) maxAgeSeconds=[process.argv[2]];

// max orders allowed by kraken
var maxOrders = 5200;

// get ticker info
kraken.api('OpenOrders', null, function(error, data) {
	if (error) log(error);
	else {
		// get current time to see which orders are too old
		currentTime = Math.floor(new Date()/1000);
		log("Current open orders: " + Object.keys(data.result.open).length);

		var numOrders = 0;

		// iterate through all the open orders
		for (var order in data.result.open) {

			numOrders++;

			// get the order open time 
			orderTime = data.result.open[order].opentm;
			// cancel order if it is too old
			if (orderTime + maxAgeSeconds < currentTime || numOrders > maxOrders) {
				log("Cancelling order #" + numOrders + " " + order + "...");
				kraken.api('CancelOrder', { "txid" : order }, function (error, data) { 
					if (error) log(error);
				});
			}

		}
	}	
});

// simple log helper function
function log(string) {
	var d = new Date();
	var datestring = ("0" + d.getDate()).slice(-2) + "-" + ("0"+(d.getMonth()+1)).slice(-2) + "-" + d.getFullYear() + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
	console.log(datestring + " " + string);
}
