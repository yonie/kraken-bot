// @ts-check
/**
 * LLM Provider Module
 * Handles communication with different LLM providers
 */

const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

let config = {
  provider: 'openrouter',
  apiKey: null,
  model: 'x-ai/grok-3-mini-beta',
  ollamaHost: 'localhost',
  ollamaPort: 11434,
  opencodePath: '/zen/v1',
  cli: null,        // which coding CLI to spawn when provider === 'cli': 'claude' | 'codex' | 'opencode'
  cliBin: null,     // optional override for the CLI executable name/path
  timeout: 180000,
  fallback: null, // optional { provider, model, apiKey, ollamaHost, ollamaPort, cli, cliBin, timeout }
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
    config.cli = options.cli || config.cli;
    config.cliBin = options.cliBin || config.cliBin;
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
    opencodePath: overrides.opencodePath || config.opencodePath,
    cli: overrides.cli || config.cli,
    cliBin: overrides.cliBin || config.cliBin,
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
  if (cfg.provider === 'cli') {
    return callCli(prompt, cfg);
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

// Local coding CLIs that expose a subscription login (no API key). Each reads
// the prompt from stdin and prints the final assistant message to stdout, so the
// same buildPrompt() text used by the HTTP providers flows through unchanged.
const CLI_PRESETS = {
  claude: {
    bin: 'claude',
    // `claude -p` (print/non-interactive) reads the prompt from stdin.
    buildArgs: (model) => ['-p', ...(model ? ['--model', model] : [])],
    docUrl: 'https://docs.anthropic.com/en/docs/claude-code (run `claude login`)',
  },
  codex: {
    bin: 'codex',
    // `codex exec -` reads the prompt from stdin; read-only sandbox keeps it from
    // touching the filesystem, and it never prompts for approval in exec mode.
    buildArgs: (model) => [
      'exec', '-s', 'read-only', '--skip-git-repo-check', '--color', 'never',
      ...(model ? ['-m', model] : []), '-',
    ],
    docUrl: 'https://github.com/openai/codex (run `codex login`)',
  },
  opencode: {
    bin: 'opencode',
    // `opencode run` reads the prompt from stdin when no message argument is given.
    buildArgs: (model) => ['run', ...(model ? ['--model', model] : [])],
    docUrl: 'https://opencode.ai (run `opencode auth login`)',
  },
};

function getCliPresets() {
  return CLI_PRESETS;
}

/**
 * Run the prompt through a local coding CLI that carries its own subscription
 * login (claude / codex / opencode), instead of an HTTP API + key.
 * @param {string} prompt
 * @param {any} cfg active config (must include cfg.cli)
 */
async function callCli(prompt, cfg) {
  cfg = cfg || buildActiveConfig({});
  const name = String(cfg.cli || '').toLowerCase();
  const preset = CLI_PRESETS[name];
  if (!preset) {
    throw new Error(`Unknown CLI '${cfg.cli}'. Supported: ${Object.keys(CLI_PRESETS).join(', ')}`);
  }

  const bin = cfg.cliBin || preset.bin;
  // Treat the ollama-style default and the literal 'default' as "let the CLI
  // pick its own configured model" rather than forwarding a bogus model flag.
  const model = cfg.model && cfg.model !== 'default' ? cfg.model : null;
  const args = preset.buildArgs(model);
  const startTime = Date.now();
  const timeout = cfg.timeout || 180000;

  const promptSize = Buffer.byteLength(prompt, 'utf8');
  console.log(`[AI] CLI request: ${bin} ${args.join(' ')}, size=${(promptSize / 1024).toFixed(1)}KB, timeout=${(timeout / 1000).toFixed(0)}s`);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        // On Windows the CLIs are .cmd/.ps1 shims that spawn cannot resolve
        // without a shell. The prompt travels via stdin (never argv), so no
        // shell-quoting/injection surface is introduced by this.
        shell: process.platform === 'win32',
        windowsHide: true,
      });
    } catch (e) {
      reject(new Error(`Failed to spawn '${bin}': ${e.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(() => {
      const duration = Date.now() - startTime;
      console.error(`[AI] CLI timeout after ${(duration / 1000).toFixed(1)}s (limit: ${(timeout / 1000).toFixed(0)}s)`);
      try { child.kill('SIGKILL'); } catch (e) {}
      finish(reject, new Error(`${name} CLI timeout`));
    }, timeout);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (e) => {
      console.error(`[AI] CLI spawn error: ${e.message}`);
      finish(reject, new Error(`${name} CLI failed to start: ${e.message} (is '${bin}' installed and on PATH? ${preset.docUrl})`));
    });

    child.on('close', (code) => {
      const duration = Date.now() - startTime;
      if (code !== 0) {
        const tail = (stderr || stdout || '').trim().split('\n').slice(-3).join(' ');
        console.error(`[AI] CLI exited ${code}: ${tail}`);
        finish(reject, new Error(`${name} CLI exited ${code}: ${tail || 'no output'}`));
        return;
      }
      const content = stdout.trim();
      console.log(`[AI] CLI response: ${(duration / 1000).toFixed(1)}s, ${content.length} chars`);
      lastCallMeta = {
        provider: 'cli', model: model || `${name}:default`, host: bin, port: null,
        wall_ms: duration, prompt_tokens: null, eval_tokens: null,
        done_reason: `exit_${code}`, cli: name,
      };
      if (!content) {
        finish(reject, new Error(`${name} CLI returned empty output`));
        return;
      }
      finish(resolve, sanitizeResponse(content));
    });

    // Ignore EPIPE if the CLI closes stdin early.
    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
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
  callCli,
  getCliPresets,
  getLastCallMeta,
};