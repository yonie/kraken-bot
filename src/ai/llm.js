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
  opencodePath: '/zen/v1',
  timeout: 180000,
  fallback: null, // optional { provider, model, apiKey, ollamaHost, ollamaPort, timeout }
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
    config.opencodePath = options.opencodePath || config.opencodePath;
    config.timeout = options.timeout || config.timeout;
    if ('fallback' in options) config.fallback = options.fallback;
  }
}

function buildActiveConfig(overrides) {
  return {
    provider: overrides.provider || config.provider,
    apiKey: overrides.apiKey || config.apiKey,
    model: overrides.model || config.model,
    ollamaHost: overrides.ollamaHost || config.ollamaHost,
    ollamaPort: overrides.ollamaPort || config.ollamaPort,
    timeout: overrides.timeout || config.timeout,
  };
}

const MODEL_DEFAULTS = [
  {
    match: /^qwen3\.6:/,
    options: {
      temperature: 0.7,
      top_p: 0.80,
      top_k: 20,
      presence_penalty: 1.5,
      num_ctx: 65536,
      num_predict: 3000,
    },
    think: false,
    keep_alive: '15m',
  },
];

function getModelDefaults(model) {
  for (const d of MODEL_DEFAULTS) {
    if (d.match.test(model)) return d;
  }
  return null;
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

let lastCallMeta = null;
function getLastCallMeta() { return lastCallMeta; }

async function callLLM(prompt) {
  lastCallMeta = null;
  const primary = buildActiveConfig({});
  try {
    const result = await callWithConfig(prompt, primary);
    if (lastCallMeta) lastCallMeta.leg = 'primary';
    return result;
  } catch (primaryError) {
    if (!config.fallback) throw primaryError;
    const fb = buildActiveConfig(config.fallback);
    console.warn(`[AI] Primary (${primary.provider}/${primary.model}) failed: ${primaryError.message} — falling back to ${fb.provider}/${fb.model}`);
    try {
      const result = await callWithConfig(prompt, fb);
      if (lastCallMeta) lastCallMeta.leg = 'fallback';
      return result;
    } catch (fallbackError) {
      console.error(`[AI] Fallback (${fb.provider}/${fb.model}) also failed: ${fallbackError.message}`);
      throw fallbackError;
    }
  }
}

async function callWithConfig(prompt, cfg) {
  if (cfg.provider === 'ollama') {
    return callOllamaWithRetry(prompt, cfg);
  }
  if (cfg.provider === 'opencode') {
    return callOpenCode(prompt, cfg);
  }
  return callOpenRouter(prompt, cfg);
}

async function callOllamaWithRetry(prompt, cfg, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const currentTimeout = cfg.timeout * (attempt + 1);
    try {
      return await callOllama(prompt, currentTimeout, cfg);
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

async function callOllama(prompt, timeoutMs, cfg) {
  cfg = cfg || buildActiveConfig({});
  const startTime = Date.now();
  const timeout = timeoutMs || cfg.timeout;
  const defaults = getModelDefaults(cfg.model);

  return new Promise((resolve, reject) => {
    const payload = {
      model: cfg.model,
      prompt: prompt,
      stream: false,
    };
    if (defaults) {
      payload.options = defaults.options;
      if (typeof defaults.think === 'boolean') payload.think = defaults.think;
      if (defaults.keep_alive) payload.keep_alive = defaults.keep_alive;
    }
    const postData = JSON.stringify(payload);

    const promptSize = Buffer.byteLength(postData, 'utf8');
    console.log(`[AI] Request: model=${cfg.model}, size=${(promptSize / 1024).toFixed(1)}KB, timeout=${(timeout/1000).toFixed(0)}s`);

    const req = http.request({
      hostname: cfg.ollamaHost,
      port: cfg.ollamaPort,
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
            lastCallMeta = {
              provider: 'ollama', model: cfg.model, host: cfg.ollamaHost, port: cfg.ollamaPort,
              wall_ms: duration, prompt_tokens: tokensIn, eval_tokens: tokensOut,
              done_reason: parsed.done_reason || null,
            };
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

async function callOpenRouter(prompt, cfg) {
  cfg = cfg || buildActiveConfig({});
  if (!cfg.apiKey) {
    console.error('[AI] No API key configured');
    return null;
  }

  const startTime = Date.now();
  const timeout = cfg.timeout || 60000;

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 600
    });

    const promptSize = Buffer.byteLength(postData, 'utf8');
    console.log(`[AI] OpenRouter request: model=${cfg.model}, size=${(promptSize / 1024).toFixed(1)}KB`);

    const req = https.request({
      hostname: 'openrouter.ai',
      port: 443,
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
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
            lastCallMeta = {
              provider: 'openrouter', model: cfg.model, host: 'openrouter.ai', port: 443,
              wall_ms: duration, prompt_tokens: parsed.usage?.prompt_tokens || null,
              eval_tokens: parsed.usage?.completion_tokens || null, done_reason: null,
            };
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

async function callOpenCode(prompt) {
  if (!config.apiKey) {
    console.error('[AI] No OpenCode API key configured');
    throw new Error('OpenCode API key not configured');
  }
  
  const startTime = Date.now();
  const timeout = config.timeout || 60000;
  
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 16000
    });
    
    const promptSize = Buffer.byteLength(postData, 'utf8');
    console.log(`[AI] OpenCode request: model=${config.model}, size=${(promptSize / 1024).toFixed(1)}KB`);

    const req = https.request({
      hostname: 'opencode.ai',
      port: 443,
      path: `${config.opencodePath}/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      timeout: timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error(`[AI] OpenCode error: ${parsed.error.message}`);
            reject(new Error(parsed.error.message));
          } else {
            const duration = Date.now() - startTime;
            const content = parsed.choices?.[0]?.message?.content;
            const finishReason = parsed.choices?.[0]?.finish_reason;
            console.log(`[AI] OpenCode response: ${(duration/1000).toFixed(1)}s, finish_reason=${finishReason}`);
            if (!content) {
              reject(new Error('OpenCode returned empty content (possibly truncated reasoning or refusal)'));
              return;
            }
            resolve(sanitizeResponse(content));
          }
        } catch (e) {
          console.error(`[AI] OpenCode parse error: ${e.message}`);
          reject(new Error('Failed to parse OpenCode response'));
        }
      });
    });

    req.on('error', e => {
      console.error(`[AI] OpenCode connection error: ${e.message}`);
      reject(e);
    });
    
    req.on('timeout', () => {
      const duration = Date.now() - startTime;
      console.error(`[AI] OpenCode timeout after ${(duration/1000).toFixed(1)}s`);
      req.destroy();
      reject(new Error('OpenCode timeout'));
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
  callOpenRouter,
  callOpenCode,
  getLastCallMeta,
};