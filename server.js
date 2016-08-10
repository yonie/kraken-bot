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
var marginratio = settings.marginratio;
var margintrade = settings.margintrade;
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
				// fetch data from the kraken ticker
				var lasttrade = data.result[pair].c[0];
				var daylow = data.result[pair].l[1];
				var dayhi = data.result[pair].h[1];
				var weighedaverage = data.result[pair].p[1];
	
				// do some basic intepretation of the data
				var distancefromlow = Math.round((lasttrade - daylow) / (dayhi - daylow) * 100);
				var distancefromhi = Math.round((dayhi - lasttrade) / (dayhi - daylow) * 100);
				var move = Math.round(((dayhi - daylow) / dayhi) * 100);
					
				// output fancy graph
				log(createGraph(distancefromlow, daylow, dayhi, buyTolerance, sellTolerance));
			
				// see if we are going to trade at all
				if (move >= moveLimit) {
						
					// are we buying?
					if (distancefromlow > 0 && distancefromlow <= buyTolerance) {

						// we should buy
	
						// buy ratio, the closer to 0 the more to buy
						var buyRatio = 1 - (distancefromlow / buyTolerance)

						// determine the volume to buy
						var buyVolume = (currencyBalance / lasttrade) * buyRatio * caution;
						var buyPrice = lasttrade * 1.00005;
						buy(buyVolume, buyPrice);
						
						if (addonratio > 0) {
							// try to directly insert a sale order for what we just bought
							var sellVolume = buyVolume * addonratio;
							var sellPrice = lasttrade * (1 + addontrade);
							sell(sellVolume, sellPrice);
						}

					} else if (distancefromhi > 0 && distancefromhi <= sellTolerance) { 
						
						// otherwise, we should sell

						// sell ratio, the closer to 0 the more to buy
						var sellRatio = 1 - (distancefromhi / sellTolerance)

						// determine how much to sell 
						var sellVolume = assetBalance * sellRatio * caution;
						var sellPrice = lasttrade * 0.99995;
						sell(sellVolume, sellPrice);

					} else if (marginratio > 0 && distancefromlow < 70) {
						
						// if neither, do some minor trading to stay busy

						var priceMod=margintrade;
						var buyRatio=marginratio/2;
						var sellRatio=marginratio;

						// volume to trade
						var buyVolume = (currencyBalance / lasttrade) * buyRatio;
						var sellVolume = assetBalance * sellRatio;

						// get ticker info
						kraken.api('Spread', {"pair":pair}, function(error, data) {
							
							var bidsarray = data["result"][pair];
							var arraysize = Math.min(bidsarray.length,10);
							var resolution = Math.floor(arraysize/3);

							var spreaddata = [];
							var lowest;
							var highest;
							var average;

							// iterate the array of spread data and get some meaningful averages
							for (var m=0;m<Math.floor(arraysize/resolution);m++) {

								for (var n=0;n<resolution;n++) {

									var counter = parseFloat(n)+(resolution*parseFloat(m));

									if (n==0) {
										lowest = bidsarray[counter][1];
										highest = bidsarray[counter][1];
									}

									if (bidsarray[counter][1]<lowest) lowest = bidsarray[counter][1];
									if (bidsarray[counter][1]>highest) highest = bidsarray[counter][1];
							
									average = ((parseFloat(lowest) + parseFloat(highest)) / 2).toFixed(5);
								}

								spreaddata.push(average);
							}
							log("Spread analysis (n="+arraysize+"): " + spreaddata);

							// scenario A: falling
							if (spreaddata[2] < spreaddata[1] && spreaddata[1] < spreaddata[0]) {
								log("Margin trade / Falling");
								sell(sellVolume, lasttrade * .99995);
							}
							// scenario B: rising
							else if (spreaddata[2] > spreaddata[1] && spreaddata[1] > spreaddata[0]) {
								log("Margin trade / Rising");
								buy(buyVolume, lasttrade * 1.00005);
								sell(buyVolume, lasttrade * (1+priceMod));
							}
							// scenario E: peak
							else if (spreaddata[2] < spreaddata[1] && spreaddata[1] > spreaddata[0]) {
								log("Margin trade / Peak");
								sell(sellVolume, lasttrade * .99995);

							}
							// scenario F: dip
							else if (spreaddata[2] > spreaddata[1] && spreaddata[1] < spreaddata[0]) {
								log("Margin trade / Dip");
								buy(buyVolume, lasttrade * 1.00005);
								sell(buyVolume, lasttrade * (1+priceMod));
						
							}
							else if (spreaddata[2] == spreaddata[1] && spreaddata[1] == spreaddata[0]) {
								log("Margin trade / Flat");
							}
							else {
								log("Margin trade / Other");
							}
						});



					}
				}
			}
		});
	}
});

// buy stuff through kraken API
function buy(buyVolume, buyPrice) { // asset minTrade minTradeAmount currency pair 
	log("Checking if we can buy " + parseFloat(buyVolume).toFixed(5) + " for " + parseFloat(buyPrice).toFixed(5) + "...");
	if (buyVolume>=minTrade && buyVolume * buyPrice >= minTradeAmount) {
		log("[TRADE] Buying " + parseFloat(buyVolume).toFixed(5) + " of " + asset + " for "+parseFloat(buyPrice).toFixed(5)+" ("+parseFloat(buyVolume*buyPrice).toFixed(2)+" "+currency+")...");
		kraken.api('AddOrder', {"pair": pair, "type": "buy", "ordertype": "limit", "volume": buyVolume, "price": buyPrice}, function(error, data) { if (error) log(error); });
	}
}

// sell stuff through kraken API
function sell(sellVolume, sellPrice) {
	log("Checking if we can sell " + parseFloat(sellVolume).toFixed(5) + " for " + parseFloat(sellPrice).toFixed(5) + "...");
	if (sellVolume >= minTrade && sellVolume * sellPrice >= minTradeAmount) {
		log("[TRADE] Selling " + parseFloat(sellVolume).toFixed(5) + " of " + asset + " for "+parseFloat(sellPrice).toFixed(5)+" ("+parseFloat(sellVolume*sellPrice).toFixed(2)+" "+currency+")...");
		kraken.api('AddOrder', {"pair": pair, "type": "sell", "ordertype": "limit", "volume": sellVolume, "price": sellPrice}, function(error, data) { if (error) log(error); });
	}
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
