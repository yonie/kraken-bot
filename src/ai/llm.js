// @ts-check
/**
 * LLM Provider Module
 * Handles communication with different LLM providers
 */

const https = require('https');
const http = require('http');

let config = {
  provider: 'openrouter',
  apiKey: null,
  model: 'x-ai/grok-3-mini-beta',
  ollamaHost: 'localhost',
  ollamaPort: 11434,
  timeout: 180000
};

function setConfig(options) {
  if (typeof options === 'string') {
    config.apiKey = options;
    if (arguments[1]) config.model = arguments[1];
  } else {
    config.provider = options.provider || config.provider;
    config.apiKey = options.apiKey || null;
    config.model = options.model || config.model;
    config.ollamaHost = options.ollamaHost || config.ollamaHost;
    config.ollamaPort = options.ollamaPort || config.ollamaPort;
    config.timeout = options.timeout || config.timeout;
  }
}

function getConfig() {
  return { ...config };
}

function sanitizeResponse(text) {
  if (!text) return text;
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2026]/g, '...')
    .replace(/[\u20AC]/g, 'EUR');
}

async function callLLM(prompt) {
  if (config.provider === 'ollama') {
    return callOllamaWithRetry(prompt);
  }
  return callOpenRouter(prompt);
}

async function callOllamaWithRetry(prompt, maxRetries = 2) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const currentTimeout = config.timeout * (attempt + 1);
    
    try {
      const result = await callOllama(prompt, currentTimeout);
      return result;
    } catch (e) {
      lastError = e;
      if (attempt === maxRetries) break;
      
      const backoff = Math.pow(2, attempt) * 1000;
      console.log(`[AI] Retry ${attempt + 1}/${maxRetries} in ${backoff}ms: ${e.message}`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  
  throw lastError;
}

async function callOllama(prompt, timeoutMs) {
  const startTime = Date.now();
  const timeout = timeoutMs || config.timeout;
  
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: config.model,
      prompt: prompt,
      stream: false
    });

    const promptSize = Buffer.byteLength(postData, 'utf8');
    console.log(`[AI] Request: model=${config.model}, size=${(promptSize / 1024).toFixed(1)}KB, timeout=${(timeout/1000).toFixed(0)}s`);

    const req = http.request({
      hostname: config.ollamaHost,
      port: config.ollamaPort,
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error(`[AI] Ollama error: ${parsed.error}`);
            reject(new Error(parsed.error));
          } else {
            const duration = Date.now() - startTime;
            const tokensIn = parsed.prompt_eval_count || 0;
            const tokensOut = parsed.eval_count || 0;
            console.log(`[AI] Response: ${(duration/1000).toFixed(1)}s, tokens=${tokensOut} (prompt=${tokensIn}, gen=${tokensOut})`);
            resolve(sanitizeResponse(parsed.response));
          }
        } catch (e) {
          console.error(`[AI] Parse error: ${e.message}`);
          reject(new Error('Failed to parse Ollama response: ' + e.message));
        }
      });
    });

    req.on('error', e => {
      console.error(`[AI] Connection error: ${e.message}`);
      reject(new Error('Ollama connection failed: ' + e.message));
    });
    
    req.on('timeout', () => {
      const duration = Date.now() - startTime;
      console.error(`[AI] Timeout after ${(duration/1000).toFixed(1)}s (limit: ${(timeout/1000).toFixed(0)}s)`);
      req.destroy();
      reject(new Error('Ollama timeout'));
    });
    
    req.write(postData);
    req.end();
  });
}

async function callOpenRouter(prompt) {
  if (!config.apiKey) {
    console.error('[AI] No API key configured');
    return null;
  }
  
  const startTime = Date.now();
  const timeout = config.timeout || 60000;
  
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 600
    });
    
    const promptSize = Buffer.byteLength(postData, 'utf8');
    console.log(`[AI] OpenRouter request: model=${config.model}, size=${(promptSize / 1024).toFixed(1)}KB`);

    const req = https.request({
      hostname: 'openrouter.ai',
      port: 443,
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'HTTP-Referer': 'https://kraken-bot.local',
        'X-Title': 'Kraken Trading Bot'
      },
      timeout: timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error(`[AI] OpenRouter error: ${parsed.error.message}`);
            reject(new Error(parsed.error.message));
          } else {
            const duration = Date.now() - startTime;
            console.log(`[AI] OpenRouter response: ${(duration/1000).toFixed(1)}s`);
            resolve(sanitizeResponse(parsed.choices?.[0]?.message?.content));
          }
        } catch (e) {
          console.error(`[AI] OpenRouter parse error: ${e.message}`);
          reject(new Error('Failed to parse OpenRouter response'));
        }
      });
    });

    req.on('error', e => {
      console.error(`[AI] OpenRouter connection error: ${e.message}`);
      reject(e);
    });
    
    req.on('timeout', () => {
      const duration = Date.now() - startTime;
      console.error(`[AI] OpenRouter timeout after ${(duration/1000).toFixed(1)}s`);
      req.destroy();
      reject(new Error('OpenRouter timeout'));
    });
    
    req.write(postData);
    req.end();
  });
}

module.exports = {
  setConfig,
  getConfig,
  sanitizeResponse,
  callLLM,
  callOllama,
  callOpenRouter
};