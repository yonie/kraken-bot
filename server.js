// set up kraken api
var settings = require("./settings.js");
var KrakenClient = require('kraken-api');
var kraken = new KrakenClient(settings.krakenkey,settings.krakenpasscode);

// tolerance determines how much % near hi or low the lasttrade needs to be to begin acting
var buyTolerance = 60; // 45
var sellTolerance = 20; // 45
var moveLimit = 3; // 5
var caution = 1.0; // 0.1
var addonratio = 0.99; // 0.1
var addontrade = 0.001 + 0.0026; // min 0.0026 

// determine the minimum asset amount to trade (this prevents API errors)
var minTrade = 0.01;
var minTradeAmount = 0.25;

// set trade asset (bitcoin=XBTC, litecoin=XLTC, ether=XETH), or get from CMDLINE if given
var asset=['XLTC']; // default to litecoin
if (process.argv.length > 2) {
	asset=[process.argv[2]];
}

// add EUR to make the trade pair
var pair = asset+'ZEUR';
			
kraken.api('Balance', null, function(error, data) {
	if(error) {
		log(error);
	} else {
		var euroBalance = data.result.ZEUR;
		var assetBalance = data.result[asset];

		// get ticker info
		kraken.api('Ticker', {"pair": pair}, function(error, data) {
	
			if(error) {
				//log(error);
			} else {
				var lasttrade = data.result[pair].c[0];
				var daylow = data.result[pair].l[1];
				var dayhi = data.result[pair].h[1];
	
				// see if the difference between current and low/hi is less than tolerated spread
				var distancefromlow = Math.round((lasttrade - daylow) / (dayhi - daylow) * 100);
				var distancefromhi = Math.round((dayhi - lasttrade) / (dayhi - daylow) * 100);
				var move = Math.round(((dayhi-daylow)/dayhi)*100);

				// output fancy graph
				log(createGraph(distancefromlow, daylow, dayhi, buyTolerance, sellTolerance));
			
				// see if we are going to trade 
				if (distancefromlow <= buyTolerance || distancefromhi <= sellTolerance) {

					// are we buying?
					if (move >= moveLimit && distancefromlow <= buyTolerance) {
						
						// we should buy

						// buy ratio, the closer to 0 the more to buy
						var buyRatio = 1-(distancefromlow/buyTolerance)

						// determine the volume to buy, skip 50 cents for rounding issues
						var volume = ((euroBalance-0.5) / lasttrade) * buyRatio * caution;
					
						// we could end up with negative volume because of the 50 cents correction
						if (volume < 0) volume = 0;

						if (volume * lasttrade >= minTradeAmount && volume >= minTrade) {

							log("[TRADE] Buying " + parseFloat(volume).toFixed(5) + " of " + asset + "...");
							kraken.api('AddOrder', {"pair": pair, "type": "buy", "ordertype": "limit", "volume": volume, "price": lasttrade*1.00001}, function(error, data) {
								if (error) {
									log(error);
								} else {
									// buy successful!
									kraken.api('AddOrder', {"pair": pair, "type": "sell", "ordertype": "limit", "volume": volume* addonratio, "price": lasttrade * (1+addontrade)}, function(error, data) {});
								}
							});
						} else {
							// trade volume too low 
						}
					} else { 
						
						// we should sell

						// sell ratio, the closer to 0 the more to buy
						var sellRatio = 1-(distancefromhi/sellTolerance)

						// determine how much to sell 
						var volume = assetBalance * sellRatio * caution;

						// make sure we are trading decent amounts
						if (volume * lasttrade >= minTradeAmount && volume >= minTrade) {
							log("[TRADE] Selling " + parseFloat(volume).toFixed(5) + " of " + asset + "...");
							kraken.api('AddOrder', {"pair": pair, "type": "sell", "ordertype": "limit", "volume": volume, "price": lasttrade*0.99999}, function(error, data) {
								if (error) {
									log(error);
								} else {
									// sale complete!
//									kraken.api('AddOrder', {"pair": pair, "type": "buy", "ordertype": "limit", "volume": volume* addonratio, "price": lasttrade * (1-addontrade)}, function(error, data) {});
								}
							});
						} else {
							// trade volume too low 
						}
					}
				}
			}
		});
	}
});

// simple log helper function
function log(string) {
	var d = new Date();
	var datestring = ("0" + d.getDate()).slice(-2) + "-" + ("0"+(d.getMonth()+1)).slice(-2) + "-" + d.getFullYear() + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
	console.log(datestring + (asset!=null?" "+asset:null) + " " + string);
}

// fancy graph to quickly see how asset is trading [bbb--*----ss]
function createGraph(distancefromlow, low, hi, buyTolerance, sellTolerance) {
	var width = 28;
	var move = Math.round(((hi-low)/hi)*100);
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

	result = result + "] " + hi.substring(0,7) + " (" + distancefromlow + "%/"+move+"%)";
	return result;
}
