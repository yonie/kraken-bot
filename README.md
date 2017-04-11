## Synopsis

This project makes use of the Kraken API to do some basic automated trading. 

## Code Example

npm start 

will run the bot for one go, and do some trading trade if applicable. it defaults to the XLTC cryptocurrency.

npm start XXBT

will run the bot on the XXBT cryptocurrency with ZEUR as currency. 

it can also simply be run by calling nodejs server.js

## Motivation

I don't want to monitor a website for market data myself, so I made a bot that decides when to buy/sell and execute the commands. 

## Installation

To use; 

1. rename settings.js.example to settings.js and provide with proper keys
2. be sure to set the proper default cryptocurrency and limits
3. npm -i
4. nodejs server.js

Note that the bot is set to use EUR currency. 

## License

Licensed under GPL-3.0.


