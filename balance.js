// set up kraken api
var settings = require("./settings.js");
var KrakenClient = require('kraken-api');
var kraken = new KrakenClient(settings.krakenkey,settings.krakenpasscode);

//if (Math.random()<0.9) process.exit();

// get ticker info
kraken.api('TradeBalance', {"asset":"ZEUR"}, function(error, data) {
	log("Trade balance: "+data.result.eb);
	kraken.api('Balance',null, function(error,data) {
		for (var m in data.result)
			log(m+": "+ data.result[m]);
	});	
});

// simple log helper function
function log(string) {
	var d = new Date();
	var datestring = ("0" + d.getDate()).slice(-2) + "-" + ("0"+(d.getMonth()+1)).slice(-2) + "-" + d.getFullYear() + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
	console.log(datestring + " " + string);
}

// fancy graph to quickly see how asset is trading [bbb--*----ss]
function createGraph(distancefromlow, low, hi, buyTolerance, sellTolerance) {
	var width = 28;
	var result = low.substring(0,7) + " [";
	for (i=0;i<=width;i++) {
		if ((i / width) * 100 >= distancefromlow && (i / width) * 100 < distancefromlow + (100 / width))
			result = result + "*";
		else if ((i / width) * 100 < buyTolerance)
			result = result + "b";
		else if ((i / width) * 100 > 100 - sellTolerance)
			result = result + "s";
		else
			result = result + "-";
	}

	result = result + "] " + hi.substring(0,7) + " (" + distancefromlow + "%)";
	return result;
}
