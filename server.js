// get settings 
var settings = require("./settings.js");
var krakenkey = settings.krakenkey;
var krakenpasscode = settings.krakenpasscode;
var buyTolerance = settings.buyTolerance;
var sellTolerance = settings.sellTolerance;
var buyMoveLimit = settings.buyMoveLimit;
var sellMoveLimit = settings.sellMoveLimit;
var priceMod = settings.priceMod;
var minTrade = settings.minTrade;
var minTradeAmount = settings.minTradeAmount;
var timer = settings.timer;

var fixedTradeEur = 10;
var fixedTradeBtc = 0.003;
var fixedTradeEth = 0.05;

// set up kraken api
var KrakenClient = require('kraken-api');
var kraken = new KrakenClient(krakenkey,krakenpasscode);

// get trade pair from CMDLINE
// TODO: single pairs as cmdline
if (process.argv.length < 4) {
	console.log("No trade pair specified.");
	console.log("Usage: " + process.argv[1] + " [tradeAsset] [tradeCurrency]");
	console.log("Example: to trade Litecoin for Euro, execute " + process.argv[1] + " XLTC ZEUR");
	process.exit();
} else {
	asset=[process.argv[2]];
	currency=[process.argv[3]];
	takeprofit=[process.argv[4]];
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
		// TODO: request multiple pairs
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

						// determine to buy/sell
						if (move >= buyMoveLimit && distancefromlow <= buyTolerance) {
						
							var price = lasttrade * (1-priceMod);
							var volume;

							// some fixed trade amounts
							if (currency == "ZEUR" || currency == "EUR") volume = fixedTradeEur / price;
							else if (currency == "XXBT" || currency == "XBT") volume = fixedTradeBtc / price;
							else if (currency == "XETH" || currency == "ETH") volume = fixedTradeEth / price;

							// quick hack
							price = cleanupPrice(pair,price);

							// buy stuff
							buy(pair, volume, price, timer);
						}
						else if (move >= sellMoveLimit && distancefromhi <= sellTolerance) {

							var price = lasttrade * (1+priceMod);
							var volume = assetBalance / 10;

							// quick hack
							price = cleanupPrice(pair,price);
					
							// sell stuff
							sell(pair, volume, price, timer);
						}
					}
				});
			}
		});
	}
});

// buy for a given price with built in timer with profit close order
function buy(pair, volume, price, timer) {

	if (volume>=minTrade && (volume * price) >= minTradeAmount) {
	
		log("volume to buy = "+ volume);
		log("price to pay = "+ price);

		return kraken.api('AddOrder', {
			"pair" : pair, 
			"type" : "buy", 
			"ordertype" :  "limit", 
			"volume" : volume, 
			"price" : price, 
			"expiretm" : "+"+timer, 
		}, function(error, data) { 
			if (error) {
				log(error);
			}
			else if (data) {
				log("[TRADE] " + data["result"]["descr"]["order"], pair);
			}
		});
	}
}

// sell order with timed expiration
function sell(pair, volume, price, timer) {

	if (volume>=minTrade && (volume * price) >= minTradeAmount) {
	
		log("volume to sell = "+ volume);
		log("price to receive = "+ price);

		return kraken.api('AddOrder', {
			"pair" : pair, 
			"type" : "sell", 
			"ordertype" :  "limit", 
			"volume" : volume, 
			"price" : price, 
			"expiretm" : "+"+timer, 
		}, function(error, data) { 
			if (error) {
				log(error);
			}
			else if (data) {
				log("[TRADE] " + data["result"]["descr"]["order"], pair);
			}
		});
	}
}

function cleanupPrice(pair,price) {
	// quick hack: clean up volume to deal with new trade restrictions
	if (pair=="XZECZEUR") price = price.toFixed(2);
	else if (pair=="BCHEUR") price = price.toFixed(1);
	else if (pair=="DASHEUR") price = price.toFixed(2);
	else if (pair=="XETCZEUR") price = price.toFixed(3);
	else if (pair=="XETHZEUR") price = price.toFixed(2);
	else if (pair=="XLTCZEUR") price = price.toFixed(2);
	else if (pair=="XREPZEUR") price = price.toFixed(3);
	else if (pair=="XXBTZEUR") price = price.toFixed(1);
	else if (pair=="XXMRZEUR") price = price.toFixed(2);
	else if (pair=="XXRPZEUR") price = price.toFixed(5);
	else if (pair=="XZECXXBT") price = price.toFixed(5);
	else if (pair=="EOSXBT") price = price.toFixed(7);
	else if (pair=="BCHXBT") price = price.toFixed(5);
	else if (pair=="XICNXXBT") price = price.toFixed(6);
	else if (pair=="XXLMXXBT") price = price.toFixed(8);
	else if (pair=="GNOXBT") price = price.toFixed(5);
	else if (pair=="XETHXXBT") price = price.toFixed(5);
	else if (pair=="DASHXBT") price = price.toFixed(5);
	else if (pair=="XLTCXXBT") price = price.toFixed(6);
	else if (pair=="XETCXXBT") price = price.toFixed(6);
	else if (pair=="XXRPXXBT") price = price.toFixed(8);
	else if (pair=="XREPXXBT") price = price.toFixed(6);
	else if (pair=="XICNXETH") price = price.toFixed(6);
	else if (pair=="XMLNXETH") price = price.toFixed(5);
	else if (pair=="GNOETH") price = price.toFixed(4);
	return price;
}


function direction() {
	/*
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
	*/
}
