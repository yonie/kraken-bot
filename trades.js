// set up kraken api
var settings = require("./settings.js");
var KrakenClient = require('kraken-api');
var kraken = new KrakenClient(settings.krakenkey,settings.krakenpasscode);

// logging
var log = require('./log.js');

// get trade balance info
kraken.api('TradesHistory', null, function(error, tradesHistoryData) {
	if (!error) for (var trade in tradesHistoryData.result.trades) {
		var logString = "";
		var d = new Date(tradesHistoryData.result.trades[trade].time * 1000);

		var datestring = ("0" + d.getDate()).slice(-2) + "-" + ("0"+(d.getMonth()+1)).slice(-2) + "-" + d.getFullYear() + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);

		logString += datestring + " ";
		logString += tradesHistoryData.result.trades[trade].pair + " "; 
		logString += tradesHistoryData.result.trades[trade].type + " ";
		logString += tradesHistoryData.result.trades[trade].ordertype + " ";
		logString += parseFloat(tradesHistoryData.result.trades[trade].vol).toFixed(5) + " @ ";
		logString += tradesHistoryData.result.trades[trade].price + " = ";
		logString += tradesHistoryData.result.trades[trade].cost + " ";
		console.log(logString);
	}
});

// simple log helper function
function log(string) {
	var d = new Date();
	var datestring = ("0" + d.getDate()).slice(-2) + "-" + ("0"+(d.getMonth()+1)).slice(-2) + "-" + d.getFullYear() + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
	console.log(datestring + " " + string);
}
