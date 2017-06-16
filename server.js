// get settings 
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

var fixedTradeEur = 5;
var fixedTradeBtc = 0.001;
var fixedTradeEth = 0.025;

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

// logging
var log = require("./log.js");
var createGraph = require("./createGraph.js");

// add currency to make the trade pair
var pair = asset+currency;

// first get our balance			
kraken.api('Balance', null, function(error, data) {
	if(error) {
		log(error,pair);
	} else {
		var currencyBalance = data.result[currency];
		var assetBalance = data.result[asset];

		// get ticker info
		kraken.api('Ticker', {"pair": pair}, function(error, data) {
	
			if(error) {
			
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
				log(createGraph(lasttrade, distancefromlow, daylow, dayhi, buyTolerance, sellTolerance),pair);
			
				// get ticker info
				kraken.api('Spread', {"pair":pair}, function(error, data) {
					if(error) {
	
					} else {
						var bidsarray = data["result"][pair];
						var arraysize = bidsarray.length;
						var resolution = Math.floor(arraysize/3);
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
						log(direction + " " + velocity + "%", pair);
						
						var buyPrice = lasttrade * (1-priceMod);
						var buyVolume = (currencyBalance / buyPrice) * caution;

						// some fixed trade amounts
						if (currency == "ZEUR" || currency == "EUR") buyVolume = fixedTradeEur / buyPrice;
						else if (currency == "XXBT" || currency == "XBT") buyVolume = fixedTradeBtc / buyPrice;
						else if (currency == "XETH" || currency == "ETH") buyVolume = fixedTradeEth / buyPrice;

						// determine to buy/sell
						if (move < moveLimit) { } // only trade sufficient moving assets
						else if ((currency == "ZEUR" || currency == "EUR") && (buyVolume * buyPrice < fixedTradeEur)) { } // dont trade too low 
						else if ((currency == "XXBT" || currency == "XBT") && (buyVolume * buyPrice < fixedTradeBtc)) { } // dont trade too low
						else if ((currency == "XETH" || currency == "ETH") && (buyVolume * buyPrice < fixedTradeEth)) { } // dont trade too low
						else if (distancefromlow <= buyTolerance) buy(pair, buyVolume, buyPrice, timer, move*.75);

					}
				});
			}
		});
	}
});

// buy for a given price with built in timer with profit close order
function buy(pair, buyVolume, buyPrice, timer, profitPrice) {
	
	if (buyVolume>=minTrade && (buyVolume * buyPrice) >= minTradeAmount) {

		return kraken.api('AddOrder', {
			"pair" : pair, 
			"type" : "buy", 
			"ordertype" :  "limit", 
			"volume" : buyVolume, 
			"price" : buyPrice, 
			"expiretm" : "+"+timer, 
			"close[ordertype]": "take-profit",
			"close[price]" : "#"+profitPrice+"%"
		}, function(error, data) { 
			if (error) {
			
			}
			else if (data) {
				log("[TRADE] " + data["result"]["descr"]["order"], pair);
				log("[TRADE] " + data["result"]["descr"]["close"], pair);
			}
		});
	}
}


