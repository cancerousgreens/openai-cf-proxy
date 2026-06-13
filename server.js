// server.js — OpenAI-compatible proxy for Cloudflare Workers AI
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Cloudflare credentials (set these as environment variables) ──────────────
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;   // Your Cloudflare Account ID
const CF_API_TOKEN  = process.env.CF_API_TOKEN;    // Your Workers AI API Token

// Cloudflare's OpenAI-compatible endpoint
const CF_BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1`;

// ── Model mapping: map whatever the client sends → actual CF model name ───────
// You can add, remove, or change these mappings freely.
const MODEL_MAPPING = {
  'gpt-3.5-turbo':          '@cf/meta/llama-3.2-3b-instruct',
  'gpt-3.5-turbo-instruct': '@cf/meta/llama-3.2-3b-instruct',
  'gpt-4':                  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'gpt-4-turbo':            '@cf/mistralai/mistral-small-3.1-24b-instruct',
  'gpt-4o':                 '@cf/qwen/qwen3-30b-a3b-fp8',
  'gpt-4o-mini':            '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
  'claude-3-opus':          '@cf/openai/gpt-oss-120b',
  'claude-3-sonnet':        '@cf/openai/gpt-oss-20b',
  'claude-3-haiku':         '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
  'gemini-pro':             '@cf/google/gemma-3-12b-it',
  'gemini-flash':           '@cf/google/gemma-4-26b-a4b-it',
  'deepseek':               '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  'mistral':                '@cf/mistral/mistral-7b-instruct-v0.1',
  'kimi':                    '@cf/moonshotai/kimi-k2.7-code',
  'deepseekv4':              'deepseek/deepseek-v4-pro',
};

// Default model when no mapping is found
const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';

// Helper: resolve the incoming model name to a Cloudflare model string
function resolveModel(requestedModel) {
  if (!requestedModel) return DEFAULT_MODEL;

  // Direct hit in the mapping table
  if (MODEL_MAPPING[requestedModel]) return MODEL_MAPPING[requestedModel];

  // Already looks like a CF model (starts with @cf/)
  if (requestedModel.startsWith('@cf/')) return requestedModel;

  // Fuzzy fallback: match by keywords
  const lower = requestedModel.toLowerCase();
  if (lower.includes('70b') || lower.includes('gpt-4')) {
    return '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  }
  if (lower.includes('deepseek') || lower.includes('reason')) {
    return '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b';
  }
  if (lower.includes('mistral')) {
    return '@cf/mistral/mistral-7b-instruct-v0.1';
  }

  return DEFAULT_MODEL;
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI → Cloudflare Workers AI proxy',
    account_configured: !!CF_ACCOUNT_ID,
    token_configured: !!CF_API_TOKEN,
  });
});

// ── List models (OpenAI-compatible) ──────────────────────────────────────────
app.get('/v1/models', (req, res) => {
  const models = [
    ...Object.keys(MODEL_MAPPING),
    // Also expose the real CF names so advanced clients can use them directly
    '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/openai/gpt-oss-120b',
    '@cf/openai/gpt-oss-20b',
    '@cf/qwen/qwen3-30b-a3b-fp8',
    '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    '@cf/mistralai/mistral-small-3.1-24b-instruct',
    '@cf/google/gemma-3-12b-it',
    '@cf/google/gemma-4-26b-a4b-it',
  ].map(id => ({
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'cloudflare',
  }));

  res.json({ object: 'list', data: models });
});

// ── Main proxy: /v1/chat/completions ─────────────────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
  try {
    // Validate credentials
    if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
      return res.status(500).json({
        error: {
          message: 'CF_ACCOUNT_ID or CF_API_TOKEN environment variables are not set.',
          type: 'configuration_error',
        },
      });
    }

    const { model, messages, temperature, max_tokens, stream, ...rest } = req.body;

    const cfModel = resolveModel(model);

    // Build the request body for Cloudflare's OpenAI-compatible endpoint
    const cfRequest = {
      model: cfModel,
      messages,
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 2048,
      stream: stream ?? false,
      ...rest, // forward any extra params (top_p, stop, etc.)
    };

    console.log(`[proxy] ${model} → ${cfModel} | stream=${cfRequest.stream}`);

    const cfResponse = await axios.post(
      `${CF_BASE_URL}/chat/completions`,
      cfRequest,
      {
        headers: {
          Authorization: `Bearer ${CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        responseType: stream ? 'stream' : 'json',
        timeout: 60000,
      }
    );

    if (stream) {
      // ── Streaming ────────────────────────────────────────────────────────
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      cfResponse.data.pipe(res);

      cfResponse.data.on('error', err => {
        console.error('[stream error]', err.message);
        res.end();
      });
    } else {
      // ── Non-streaming ────────────────────────────────────────────────────
      // Cloudflare's /ai/v1/chat/completions already returns OpenAI format,
      // so we can forward it almost as-is. We just normalise the model field
      // to match what the client originally asked for.
      const responseData = {
        ...cfResponse.data,
        model: model || cfModel, // echo back what the client sent
      };
      res.json(responseData);
    }
  } catch (error) {
    const status = error.response?.status || 500;
    const cfError = error.response?.data;

    console.error('[proxy error]', status, error.message);

    res.status(status).json({
      error: {
        message: cfError?.errors?.[0]?.message || error.message || 'Proxy error',
        type: 'proxy_error',
        code: status,
        cf_errors: cfError?.errors ?? null,
      },
    });
  }
});

// ── Catch-all 404 ─────────────────────────────────────────────────────────
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found on this proxy`,
      type: 'not_found',
    },
  });
});

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nOpenAI → Cloudflare Workers AI proxy running on port ${PORT}`);
  console.log(`Health:  http://localhost:${PORT}/health`);
  console.log(`Models:  http://localhost:${PORT}/v1/models`);
  console.log(`Chat:    http://localhost:${PORT}/v1/chat/completions\n`);

  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    console.warn('⚠️  WARNING: CF_ACCOUNT_ID or CF_API_TOKEN is not set.');
    console.warn('   Set them as environment variables before deploying.\n');
  }
});
