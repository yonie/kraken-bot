// @ts-check
/**
 * AI Module Index
 * Re-exports all AI functions
 */

const analysis = require('./analysis');
const commands = require('./commands');
const context = require('./context');
const llm = require('./llm');

module.exports = {
  // Main analysis functions
  init: analysis.init,
  runAnalysis: analysis.runAnalysis,
  initContext: analysis.initContext,
  setEnabled: analysis.setEnabled,
  setInterval: analysis.setInterval,
  
  // Command utilities (exported for external use)
  parseCommands: commands.parseCommands,
  cleanAssetName: commands.cleanAssetName,
  executeCommands: commands.executeCommands,
  
  // Context utilities (exported for external use)
  fetchGlobalMarketData: context.fetchGlobalMarketData,
  computeAssetPerformance: context.computeAssetPerformance,
  getSessionInfo: context.getSessionInfo,
  buildContext: context.buildContext,
  
  // LLM utilities (exported for external use)
  callLLM: llm.callLLM,
  sanitizeResponse: llm.sanitizeResponse
};