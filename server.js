// get settings from external file
var settings = require("./settings.js");
var krakenkey = settings.krakenkey;
var krakenpasscode = settings.krakenpasscode;
var buyTolerance = settings.buyTolerance;
var sellTolerance = settings.sellTolerance;
var moveLimit = settings.moveLimit;
var caution = settings.caution;
var addonratio = settings.addonratio;
var addontrade = settings.addontrade;
var minTrade = settings.minTrade;
var minTradeAmount = settings.minTradeAmount;

// set up kraken api
var KrakenClient = require('kraken-api');
var kraken = new KrakenClient(krakenkey,krakenpasscode);

// set trade asset (bitcoin=XBTC, litecoin=XLTC, ether=XETH), or get from CMDLINE if given
var asset=['XLTC']; // default to litecoin
if (process.argv.length > 2) {
	asset=[process.argv[2]];
}
var currency=['ZEUR']; // default to euro
if (process.argv.length > 3) {
	currency=[process.argv[3]];
}

// add currency to make the trade pair
var pair = asset+currency;

// first get our balance			
kraken.api('Balance', null, function(error, data) {
	if(error) {
		log(error);
	} else {
		var currencyBalance = data.result[currency];
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
				if (move >= moveLimit && (distancefromlow <= buyTolerance || distancefromhi <= sellTolerance)) {

					// are we buying?
					if (distancefromlow <= buyTolerance) {
						log("wanna buy..");						
						// we should buy

						// buy ratio, the closer to 0 the more to buy
						var buyRatio = 1-(distancefromlow/buyTolerance)
						log("buyRatio " + buyRatio);						

						// determine the volume to buy
						var volume = (currencyBalance / lasttrade) * buyRatio * caution;
						log("volume " + parseFloat(volume).toFixed(3));						
					
						// see if it makes sense to trade
						if (volume * lasttrade >= minTradeAmount && volume >= minTrade) {

							log("[TRADE] Buying " + parseFloat(volume).toFixed(5) + " of " + asset + " for "+parseFloat(lasttrade*1.00001).toFixed(5)+"...");
							kraken.api('AddOrder', {"pair": pair, "type": "buy", "ordertype": "limit", "volume": volume, "price": lasttrade*1.00001}, function(error, data) {
								if (error) {
									log(error);
								} else {
									// buy successful!
						
									// directly insert a sale order for what we just bought
									log("[TRADE] Selling " + parseFloat(volume*addonratio).toFixed(5) + " of " + asset + " for "+parseFloat(lasttrade*(1+addontrade)).toFixed(5)+"...");
									kraken.api('AddOrder', {"pair": pair, "type": "sell", "ordertype": "limit", "volume": volume* addonratio, "price": lasttrade * (1+addontrade)}, function(error, data) {
										if (error) {
											log(error);
										} else {
											// buy successful!
											log("[TRADE] Selling " + parseFloat(volume*addonratio).toFixed(5) + " of " + asset + " for "+parseFloat(lasttrade*(1+(addontrade*2))).toFixed(5)+"...");
											kraken.api('AddOrder', {"pair": pair, "type": "sell", "ordertype": "limit", "volume": volume* addonratio, "price": lasttrade * (1+(addontrade*2))}, function(error, data) {
												if (error) log(error);
											});
										}
									});
								}
							});
						} else {
							// trade volume too low 
						}
					} else { 
						
						// we should sell
						log("wanna sell..");

						// sell ratio, the closer to 0 the more to buy
						var sellRatio = 1-(distancefromhi/sellTolerance)
						log("sellRatio "+sellRatio);

						// determine how much to sell 
						var volume = assetBalance * sellRatio * caution;
						log("volume " + parseFloat(volume).toFixed(3));						

						// make sure we are trading decent amounts
						if (volume * lasttrade >= minTradeAmount && volume >= minTrade) {
							log("[TRADE] Selling " + parseFloat(volume).toFixed(5) + " of " + asset + " for "+parseFloat(lasttrade*0.99999).toFixed(5)+"...");
							kraken.api('AddOrder', {"pair": pair, "type": "sell", "ordertype": "limit", "volume": volume, "price": lasttrade*0.99999}, function(error, data) {
								if (error) {
									log(error);
								} else {
									// sale complete!
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
	console.log(datestring + (asset!=null?" "+asset+currency:null) + " " + string);
}

// fancy graph to quickly see how asset is trading [bbb--*----ss]
function createGraph(distancefromlow, low, hi, buyTolerance, sellTolerance) {
	var width = 10;
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
