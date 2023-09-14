# npm-kraken-bot

## Disclaimer 

I AM NOT RESPONSIBLE FOR ANY LOSS OF FUNDS OR ANY OTHER DAMAGES FOLLOWING USE OF THIS SOFTWARE. USE AT YOUR OWN RISK. NEVER INVEST FUNDS THAT YOU CANNOT MISS.

## Introduction

I became interested in automated crypto trading, and as I don't want to monitor a website for market data myself, I decided to write a bot that decides when to buy/sell and execute the commands. This project makes use of the Kraken API to do some basic automated crypto trading using a custodial wallet that you configure using an API key. Conceptually it leans on the idea that the most important decision in trading is when to *buy* and that selling is only a natural consequence. Therefor, the configuration leans on when to buy crypto, which generally means defining how much an asset should drop over time before it becomes interesting. Some additional safeguards and checks have been built in to ensure that the bot will not amass too much of the same asset (promoting diversification) and limits amounts invested when markets are getting too high.

## Key features

* Includes a web interface for manual inspection of recent trades and orders.
* Exposes basic balance data so it can be logged or graphed by external software (see crypto-stats).
* Automatically monitors all trading pairs available on the exchange and responds to any price change on minute-by-minute basis.
* Will only invest a smaller percentage of the wallet when prices get higher (as observed by BTC price) to reduce risk. 
* The bot has built-in logic to dump a token if it dropped more than 10x the desired sell price. 
* As Kraken volume is larger on EUR compared to USD or other currencies, the bot is hardwired to trade against the EUR asset. You need to have some EUR balance for it to be able to work.

## Known issues

* The bot tries to keep at most X percentage of any asset in wallet. However, if an asset price drops dramatically (eg. the 2022 Terra/Luna asset collapse) it could mean that the bot keeps buying more of the asset while it drops further. Thread with caution, and never put funds in your wallet that you cannot miss.
* If you configure the bot to buy too fast (eg when assets are not actually dropping in price at all) you might end up buying for higher price than you sell. 

## Configuration

The `settings.js` file contains all important settings, which are as follows:



## Installation

To use; 

1. rename `settings.js.example` to `settings.js`, review settings and provide with proper API keys
2. install the dependencies using `npm -i`
3. run the code using `node server.js`

## License

Licensed under GPL-3.0.

## Donations

Made some money using this bot and want to thank me? Feel free to send donations to:

ETH: 0xf923fe5103D9FA645161c244024e9f8c7Ed67E29
Solana: 9eFx8BNJGNN1PLkWxAxX3kLHVSLnnApFZfdcNMr3TjcR
