#!/usr/bin/env node
/**
 * Prompt Variant Testing Framework
 * Tests different prompt variants against Ollama (qwen3.5:cloud)
 * Runs 3 parallel calls per variant, saves results for evaluation
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const OLLAMA_HOST = 'localhost';
const OLLAMA_PORT = 11434;
const OLLAMA_MODEL = 'qwen3.5:cloud';
const RUNS_PER_VARIANT = 3;
const VARIANTS = ['A', 'B', 'C', 'D'];

const TEST_DIR = path.join(__dirname);
const VARIANTS_DIR = path.join(TEST_DIR, 'variants');
const RESULTS_DIR = path.join(TEST_DIR, 'results');

function loadContext() {
  const contextPath = path.join(TEST_DIR, 'context.json');
  const data = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  return data.dataSection;
}

function loadVariant(variantId) {
  const variantPath = path.join(VARIANTS_DIR, `variant-${variantId}-current.txt`);
  const fallbackName = {
    'A': 'variant-A-current.txt',
    'B': 'variant-B-changes.txt',
    'C': 'variant-C-anti-echo.txt',
    'D': 'variant-D-multi-perspective.txt'
  };
  const actualPath = path.join(VARIANTS_DIR, fallbackName[variantId]);
  return fs.readFileSync(actualPath, 'utf8');
}

function callOllama(prompt, runId) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: {
        temperature: 0.7
      }
    });

    const startTime = Date.now();
    
    const req = http.request({
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 120000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error));
          } else {
            const duration = Date.now() - startTime;
            resolve({
              runId,
              content: parsed.message?.content || '',
              model: parsed.model,
              duration,
              tokens: {
                prompt: parsed.prompt_eval_count,
                completion: parsed.eval_count
              }
            });
          }
        } catch (e) {
          reject(new Error('Failed to parse Ollama response: ' + e.message));
        }
      });
    });

    req.on('error', e => reject(new Error('Ollama connection failed: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log('=== PROMPT VARIANT TESTING FRAMEWORK ===\n');
  console.log(`Model: ${OLLAMA_MODEL}`);
  console.log(`Runs per variant: ${RUNS_PER_VARIANT}`);
  console.log(`Total calls: ${VARIANTS.length * RUNS_PER_VARIANT}\n`);

  const context = loadContext();
  console.log(`Context loaded: ${context.length} chars\n`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(RESULTS_DIR, `run-${timestamp}`);
  fs.mkdirSync(runDir, { recursive: true });
  console.log(`Results directory: ${runDir}\n`);

  const allResults = {};

  for (const variant of VARIANTS) {
    console.log(`\n--- Variant ${variant} ---`);
    const variantTemplate = loadVariant(variant);
    const fullPrompt = variantTemplate.replace('{{CONTEXT}}', context);
    
    console.log(`Prompt length: ${fullPrompt.length} chars`);
    console.log(`Running ${RUNS_PER_VARIANT} parallel calls...`);

    const promises = [];
    for (let i = 1; i <= RUNS_PER_VARIANT; i++) {
      promises.push(callOllama(fullPrompt, `${variant}-run${i}`));
    }

    try {
      const responses = await Promise.all(promises);
      allResults[variant] = responses;
      
      responses.forEach((r, i) => {
        console.log(`  Run ${i + 1}: ${r.duration}ms, ${r.content.length} chars`);
      });

      const variantFile = path.join(runDir, `variant-${variant}.json`);
      fs.writeFileSync(variantFile, JSON.stringify({
        variant,
        promptLength: fullPrompt.length,
        runs: responses
      }, null, 2));

    } catch (error) {
      console.error(`  ERROR: ${error.message}`);
      allResults[variant] = { error: error.message };
    }
  }

  const summaryFile = path.join(runDir, 'summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify({
    timestamp,
    model: OLLAMA_MODEL,
    runsPerVariant: RUNS_PER_VARIANT,
    results: Object.keys(allResults).map(v => ({
      variant: v,
      success: !allResults[v].error,
      avgDuration: allResults[v].runs 
        ? Math.round(allResults[v].runs.reduce((a, r) => a + r.duration, 0) / allResults[v].runs.length)
        : null
    }))
  }, null, 2));

  console.log('\n\n=== GENERATING EVALUATION FILE ===\n');
  
  let evalMd = `# Prompt Variant Evaluation\n\n`;
  evalMd += `**Timestamp:** ${timestamp}\n`;
  evalMd += `**Model:** ${OLLAMA_MODEL}\n`;
  evalMd += `**Runs per variant:** ${RUNS_PER_VARIANT}\n\n`;
  evalMd += `---\n\n`;

  for (const variant of VARIANTS) {
    const variantNames = {
      'A': 'Current (baseline)',
      'B': 'CHANGES section',
      'C': 'Anti-echo instruction',
      'D': 'Multi-perspective reasoning'
    };
    
    evalMd += `## Variant ${variant}: ${variantNames[variant]}\n\n`;
    
    if (allResults[variant].error) {
      evalMd += `**ERROR:** ${allResults[variant].error}\n\n`;
      continue;
    }

    allResults[variant].runs.forEach((run, i) => {
      evalMd += `### Run ${i + 1} (${run.duration}ms)\n\n`;
      evalMd += `\`\`\`\n${run.content}\n\`\`\`\n\n`;
    });
    evalMd += `---\n\n`;
  }

  evalMd += `## Evaluation Criteria\n\n`;
  evalMd += `Score each variant 1-5 on:\n\n`;
  evalMd += `| Metric | Description |\n`;
  evalMd += `|--------|-------------|\n`;
  evalMd += `| **Echo** | Does it repeat previous analysis unnecessarily? (5=no echo, 1=heavy echo) |\n`;
  evalMd += `| **Freshness** | Does it notice new/critical things? (5=insightful, 1=stale) |\n`;
  evalMd += `| **Action Clarity** | Are commands clear and appropriate? (5=crisp, 1=vague) |\n`;
  evalMd += `| **Brevity** | Is it concise without losing value? (5=tight, 1=rambling) |\n`;
  evalMd += `| **Groundedness** | Does it reference actual current data? (5=factual, 1=hallucinating) |\n`;
  evalMd += `| **XNAP Handling** | Does it appropriately ignore XNAP? (5=ignores, 1=still mentions) |\n\n`;

  const evalFile = path.join(runDir, 'evaluation.md');
  fs.writeFileSync(evalFile, evalMd);
  
  console.log(`Evaluation file: ${evalFile}`);
  console.log(`\n=== DONE ===`);
  console.log(`\nTo evaluate: Read ${evalFile} and score each variant.`);
}

runTests().catch(console.error);