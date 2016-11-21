// get settings from external file
var settings = require("./settings.js");
var krakenkey = settings.krakenkey;
var krakenpasscode = settings.krakenpasscode;
var buyTolerance = settings.buyTolerance;
var sellTolerance = settings.sellTolerance;
var moveLimit = settings.moveLimit;
var caution = settings.caution;
var priceMod = settings.priceMod;
var minTrade = settings.minTrade;
var minTradeAmount = settings.minTradeAmount;
var timer = settings.timer;

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
				var bid = data.result[pair].b[0];//todo
				var daylow = data.result[pair].l[1];
				var dayhi = data.result[pair].h[1];
				var weighedaverage = data.result[pair].p[1];
	
				// do some basic intepretation of the data
				var distancefromlow = Math.round((lasttrade - daylow) / (dayhi - daylow) * 100);
				var distancefromhi = Math.round((dayhi - lasttrade) / (dayhi - daylow) * 100);
				var move = Math.round(((dayhi - daylow) / dayhi) * 100);
					
				// output fancy graph
				log(createGraph(lasttrade, distancefromlow, daylow, dayhi, buyTolerance, sellTolerance));
			
				// get ticker info
				kraken.api('Spread', {"pair":pair}, function(error, data) {
					if(error) {
						//log(error);
					} else {
						var bidsarray = data["result"][pair];
						var arraysize = bidsarray.length;
						var resolution = Math.floor(arraysize/3);
						var timer = 60;
						var spreaddata = [];
						var lowest;
						var highest;
						var average;
						var direction;
		
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
						
								average = (parseFloat(lowest) + parseFloat(highest)) / 2;
							}
							
							// add the average to the array
							spreaddata.push(average);
						}

						// scenario: falling
						if (spreaddata[2] < spreaddata[1] && spreaddata[1] < spreaddata[0]) {
							direction = "falling";
						}
						// scenario: rising
						else if (spreaddata[2] > spreaddata[1] && spreaddata[1] > spreaddata[0]) {
							direction = "rising";
						}
						// scenario: peak
						else if (spreaddata[2] < spreaddata[1] && spreaddata[1] > spreaddata[0]) {
							direction = "peak";
						}
						// scenario: dip
						else if (spreaddata[2] > spreaddata[1] && spreaddata[1] < spreaddata[0]) {
							direction = "dip";
						}
						// scenario: flat
						else if (spreaddata[2] == spreaddata[1] && spreaddata[1] == spreaddata[0]) {
							direction = "flat";
						}
						// scenario: Other
						else {
							direction = "other";
						}

						var velocity = parseFloat(((spreaddata[2]-spreaddata[0])/spreaddata[0])*100).toFixed(2);
						log(direction + " " + velocity + "%");
						
						var buyPrice = lasttrade * (1-priceMod);
						var buyVolume = (currencyBalance / buyPrice);
						var sellPrice = lasttrade * (1+priceMod);

						// determine to buy/sell
						if (move < moveLimit) { } 
						//else if (distancefromlow == 0 && direction == "falling") sellTimed(assetBalance * caution, sellPrice, timer);
						else if (distancefromlow > 5 && distancefromlow <= buyTolerance && direction == "rising" && velocity >= 0.02) buy(buyVolume * caution, buyPrice, timer, 2, moveLimit-1);
						//else if (distancefromhi > 10 && distancefromhi <= sellTolerance && direction == "falling" && velocity < -0.05) sellTimed(assetBalance * caution, sellPrice, timer);

					}
				});
			}
		});
	}
});

// buy for a given price with built in timer with stop loss and profit close order
function buy(buyVolume, buyPrice, timer, stopLossPrice, profitPrice) {
	
	if (buyVolume>=minTrade && (buyVolume * buyPrice) >= minTradeAmount) {

		return kraken.api('AddOrder', {
			"pair" : pair, 
			"type" : "buy", 
			"ordertype" :  "limit", 
			"volume" : buyVolume, 
			"price" : buyPrice, 
			"expiretm" : "+"+timer, 
			"close[ordertype]": "stop-loss-profit",
			"close[price]" : "#"+stopLossPrice+"%",
			"close[price2]" : "#"+profitPrice+"%"
		}, function(error, data) { 
			if (error) log(error); 
			else if (data) {
				log("[TRADE] " + data["result"]["descr"]["order"]);
				log("[TRADE] " + data["result"]["descr"]["close"]);
			}
		});
	}
}

// simple log helper function
function log(string) {
	var d = new Date();
	var datestring = ("0" + d.getDate()).slice(-2) + "-" + ("0"+(d.getMonth()+1)).slice(-2) + "-" + d.getFullYear() + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
	console.log(datestring + (asset!=null?" "+asset+currency:null) + " " + string);
}

// fancy graph to quickly see how asset is trading [bbb--*----ss]
function createGraph(lasttrade, distancefromlow, low, hi, buyTolerance, sellTolerance) {
	var width = 10;
	var move = Math.round(((hi-low)/hi)*100);
	var result = parseFloat(lasttrade).toFixed(5) + " | " + parseFloat(low).toFixed(5) + " [";
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

	result = result + "] " + parseFloat(hi).toFixed(5) + " (" + distancefromlow + "%/"+move+"%)";
	return result;
}
