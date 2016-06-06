// set up kraken api
var settings = require("./settings.js");
var KrakenClient = require('kraken-api');
var kraken = new KrakenClient(settings.krakenkey,settings.krakenpasscode);

// get ticker info
kraken.api('AssetPairs', null, function(error, data) {
	
	if(error) log(error);
	else {
		var assetpair;
		console.log("Tradable asset pairs:");
		for (assetpair in data.result) console.log(assetpair);
	}
});
