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

// get trade pair from CMDLINE
if (process.argv.length < 4) {
	console.log("No trade pair specified.");
	console.log("Usage: " + process.argv[1] + " [tradeAsset] [tradeCurrency]");
	console.log("Example: to trade Litecoin for Euro, execute " + process.argv[1] + " XLTC ZEUR");
	process.exit();
} else {
	asset=[process.argv[2]];
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
				if (move >= moveLimit) {
						
					// are we buying?
					if (distancefromlow <= buyTolerance) {

						// we should buy
	
						// buy ratio, the closer to 0 the more to buy
						var buyRatio = 1-(distancefromlow/buyTolerance)

						// determine the volume to buy
						var volume = (currencyBalance / lasttrade) * buyRatio * caution;
					
						// see if it makes sense to trade
						if (volume * lasttrade >= minTradeAmount && volume >= minTrade) {
							buy(volume,lasttrade*1.00001);
						
							// try to directly insert a sale order for what we just bought
							if (volume * addonratio >= minTrade && volume * addonratio * lasttrade * (1+addontrade) >= minTradeAmount) {
								sell(volume*addonratio,lasttrade*(1+addontrade));
							}
						}
					} 
					else if (distancefromhi <= sellTolerance) { 
						
						// we should sell

						// sell ratio, the closer to 0 the more to buy
						var sellRatio = 1-(distancefromhi/sellTolerance)
						// determine how much to sell 
						var volume = assetBalance * sellRatio * caution;
						// make sure we are trading decent amounts
						if (volume * lasttrade >= minTradeAmount && volume >= minTrade) {
							sell(volume, lasttrade*0.99999);
						}
					} else {
						
						// do some random margin trading, LOL!

						// determine how much to deviate from lasttrade
						var mod = 0.0005 + 0.0026; // 0.0026 goes to kraken
					
						// buy some
						var buyVolume = (currencyBalance / lasttrade) * 0.05;
						var buyPrice = lasttrade*(1-mod);
						if (buyVolume>=minTrade && buyVolume * buyPrice >= minTradeAmount) {
							buy(buyVolume, buyPrice);
						}
					
						// sell some
						var sellVolume = assetBalance * 0.02;
						var sellPrice = lasttrade * (1+mod);
						if (sellVolume>=minTrade && sellVolume * sellPrice >= minTradeAmount) {
							sell(sellVolume, sellPrice);
						}
					}
				}
			}
		});
	}
});

// buy stuff through kraken API
function buy(buyVolume, buyPrice) {
	log("[TRADE] Buying " + parseFloat(buyVolume).toFixed(5) + " of " + asset + " for "+parseFloat(buyPrice).toFixed(5)+"...");
	kraken.api('AddOrder', {"pair": pair, "type": "buy", "ordertype": "limit", "volume": buyVolume, "price": buyPrice}, function(error, data) { if (error) log(error); });
}

// sell stuff through kraken API
function sell(sellVolume, sellPrice) {
	log("[TRADE] Selling " + parseFloat(sellVolume).toFixed(5) + " of " + asset + " for "+parseFloat(sellPrice).toFixed(5)+"...");
	kraken.api('AddOrder', {"pair": pair, "type": "sell", "ordertype": "limit", "volume": sellVolume, "price": sellPrice}, function(error, data) { if (error) log(error); });
}

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
