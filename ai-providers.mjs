/* =========================================================
   AI PROVIDER REGISTRY - ai-providers.mjs
   One array describes every free / free-tier chat API we can
   talk to: how it authenticates, how its request body looks,
   how replies arrive (SSE, ndjson or plain JSON) and how to
   read text out of a chunk.

   The gateway at the bottom walks the array in order, opens a
   circuit breaker around every provider and keeps the keyless
   Pollinations entry as the last resort, so the app answers
   even with zero configuration.
   ========================================================= */

const MAX_TOKENS = 250;
const TEMPERATURE = 0.4;
const ATTEMPT_TIMEOUT = Number(process.env.PUHTOLA_AI_ATTEMPT_TIMEOUT || 12000);
const IDLE_TIMEOUT = Number(process.env.PUHTOLA_AI_IDLE_TIMEOUT || 20000);
const COOLDOWN_BASE = 60000;
const COOLDOWN_BUSY = 30000;
const COOLDOWN_AUTH = 600000;
const BREAKER_THRESHOLD = 2;

const firstEnv = (names) => {
    for (const name of names) {
        const value = process.env[name];
        if (value) return { name, value };
    }
    return null;
};

const jsonSafe = (text) => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

const blocksToText = (content) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('');
};

const classifyStatus = (status) => {
    if (status === 401 || status === 403) return 'auth';
    /* 402 is how several free tiers report an exhausted anonymous quota. */
    if (status === 402 || status === 429) return 'rate';
    if (status === 408) return 'timeout';
    if (status >= 500) return 'server';
    if (status >= 400) return 'client';
    return 'other';
};

const withSystem = (system, messages) => [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...messages
];

const ollamaBase = () => (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const ollamaProbe = { ready: false };

const openAiChunk = (json) => blocksToText(json?.choices?.[0]?.delta?.content);
const openAiFinal = (body) => blocksToText(jsonSafe(body)?.choices?.[0]?.message?.content);
const bearer = (key) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${key}` });

/* Pollinations mixes a few response shapes across versions, so read all of them. */
const looseChunk = (json) => {
    const choice = json?.choices?.[0];
    const candidates = [
        choice?.delta?.content,
        choice?.message?.content,
        choice?.text,
        json?.delta?.content,
        json?.message?.content,
        json?.content,
        json?.response,
        json?.result?.response,
        json?.result?.response?.content
    ];
    for (const candidate of candidates) {
        const text = blocksToText(candidate);
        if (text) return text;
    }
    return '';
};

const looseFinal = (body) => {
    const json = jsonSafe(body);
    if (json === undefined) return body;
    return looseChunk(json);
};

/* =========================================================
   REGISTRY - order matters, the keyless entry is first here
   but is always attempted last (see orderedCandidates).
   ========================================================= */
export const providers = [
    {
        id: 'pollinations',
        label: 'Pollinations (avoin, ei avainta)',
        needsKey: false,
        fallback: true,
        envKey: [],
        defaultModel: 'openai',
        stream: 'sse',
        resolveKeys: () => ({ model: process.env.POLLINATIONS_MODEL }),
        endpoint: () => 'https://text.pollinations.ai/',
        headers: () => ({ 'Content-Type': 'application/json' }),
        buildRequest: ({ system, messages, model, stream }) => ({
            model,
            messages: withSystem(system, messages),
            stream: stream !== false,
            referrer: 'kotiva',
            seed: Math.floor(Math.random() * 1e9)
        }),
        parseChunk: looseChunk,
        parseFinal: looseFinal,
        classify: classifyStatus
    },
    {
        id: 'gemini',
        label: 'Google Gemini',
        needsKey: true,
        envKey: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
        defaultModel: 'gemini-2.0-flash',
        stream: 'sse',
        resolveKeys: () => {
            const found = firstEnv(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
            return { key: found?.value, model: process.env.GEMINI_MODEL };
        },
        endpoint: ({ key }, { model, stream }) => {
            if (stream === false) {
                return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
            }
            return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
        },
        headers: () => ({ 'Content-Type': 'application/json' }),
        buildRequest: ({ system, messages }) => ({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
            generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: TEMPERATURE }
        }),
        parseChunk: (json) => blocksToText(json?.candidates?.[0]?.content?.parts),
        parseFinal: (body) => blocksToText(jsonSafe(body)?.candidates?.[0]?.content?.parts),
        classify: classifyStatus
    },
    {
        id: 'groq',
        label: 'Groq',
        needsKey: true,
        envKey: ['GROQ_API_KEY'],
        defaultModel: 'llama-3.3-70b-versatile',
        stream: 'sse',
        resolveKeys: () => {
            const found = firstEnv(['GROQ_API_KEY']);
            return { key: found?.value, model: process.env.GROQ_MODEL };
        },
        endpoint: () => 'https://api.groq.com/openai/v1/chat/completions',
        headers: (creds) => bearer(creds.key),
        buildRequest: ({ system, messages, model, stream }) => ({
            model,
            messages: withSystem(system, messages),
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            stream: stream !== false
        }),
        parseChunk: openAiChunk,
        parseFinal: openAiFinal,
        classify: classifyStatus
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        needsKey: true,
        envKey: ['OPENROUTER_API_KEY'],
        defaultModel: 'deepseek/deepseek-chat-v3-0324:free',
        stream: 'sse',
        resolveKeys: () => {
            const found = firstEnv(['OPENROUTER_API_KEY']);
            return { key: found?.value, model: process.env.OPENROUTER_MODEL };
        },
        endpoint: () => 'https://openrouter.ai/api/v1/chat/completions',
        headers: (creds) => ({
            ...bearer(creds.key),
'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://kotiva.local',
        'X-Title': process.env.OPENROUTER_TITLE || 'kotiva'
        }),
        buildRequest: ({ system, messages, model, stream }) => ({
            model,
            messages: withSystem(system, messages),
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            stream: stream !== false
        }),
        parseChunk: openAiChunk,
        parseFinal: openAiFinal,
        classify: classifyStatus
    },
    {
        id: 'huggingface',
        label: 'Hugging Face Inference',
        needsKey: true,
        envKey: ['HF_API_KEY', 'HUGGINGFACE_API_KEY'],
        defaultModel: 'meta-llama/Llama-3.1-8B-Instruct:fastest',
        stream: 'sse',
        resolveKeys: () => {
            const found = firstEnv(['HF_API_KEY', 'HUGGINGFACE_API_KEY']);
            return { key: found?.value, model: process.env.HF_MODEL };
        },
        endpoint: () => 'https://router.huggingface.co/v1/chat/completions',
        headers: (creds) => bearer(creds.key),
        buildRequest: ({ system, messages, model, stream }) => ({
            model,
            messages: withSystem(system, messages),
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            stream: stream !== false
        }),
        parseChunk: openAiChunk,
        parseFinal: openAiFinal,
        classify: classifyStatus
    },
    {
        id: 'cloudflare',
        label: 'Cloudflare Workers AI',
        needsKey: true,
        envKey: ['CLOUDFLARE_API_TOKEN'],
        defaultModel: '@cf/meta/llama-3.1-8b-instruct',
        stream: 'sse',
        resolveKeys: () => {
            const found = firstEnv(['CLOUDFLARE_API_TOKEN']);
            return { token: found?.value, accountId: process.env.CLOUDFLARE_ACCOUNT_ID, model: process.env.CLOUDFLARE_MODEL };
        },
        endpoint: ({ accountId, model }) =>
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId || '')}/ai/run/${model}`,
        headers: (creds) => bearer(creds.token),
        buildRequest: ({ messages, stream }) => ({ messages, stream: stream !== false }),
        parseChunk: looseChunk,
        parseFinal: looseFinal,
        classify: classifyStatus
    },
    {
        id: 'mistral',
        label: 'Mistral',
        needsKey: true,
        envKey: ['MISTRAL_API_KEY'],
        defaultModel: 'mistral-small-latest',
        stream: 'sse',
        resolveKeys: () => {
            const found = firstEnv(['MISTRAL_API_KEY']);
            return { key: found?.value, model: process.env.MISTRAL_MODEL };
        },
        endpoint: () => 'https://api.mistral.ai/v1/chat/completions',
        headers: (creds) => bearer(creds.key),
        buildRequest: ({ system, messages, model, stream }) => ({
            model,
            messages: withSystem(system, messages),
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            stream: stream !== false
        }),
        parseChunk: openAiChunk,
        parseFinal: openAiFinal,
        classify: classifyStatus
    },
    {
        id: 'cohere',
        label: 'Cohere',
        needsKey: true,
        envKey: ['COHERE_API_KEY'],
        defaultModel: 'command-r-plus',
        stream: 'none',
        streaming: false,
        resolveKeys: () => {
            const found = firstEnv(['COHERE_API_KEY']);
            return { key: found?.value, model: process.env.COHERE_MODEL };
        },
        endpoint: () => 'https://api.cohere.com/v2/chat',
        headers: (creds) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${creds.key}` }),
        buildRequest: ({ system, messages, model }) => ({
            model,
            messages: withSystem(system, messages),
            stream: false,
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE
        }),
        parseChunk: () => '',
        parseFinal: (body) => {
            const json = jsonSafe(body);
            const content = json?.message?.content;
            if (typeof content === 'string') return content;
            return blocksToText(content);
        },
        classify: classifyStatus
    },
    {
        id: 'openai',
        label: 'OpenAI-yhteensopiva rajapinta',
        needsKey: true,
        envKey: ['OPENAI_API_KEY'],
        defaultModel: 'gpt-4o-mini',
        stream: 'sse',
        resolveKeys: () => {
            const found = firstEnv(['OPENAI_API_KEY']);
            return { key: found?.value, url: process.env.OPENAI_API_URL, model: process.env.OPENAI_MODEL };
        },
        endpoint: ({ url }) => url || 'https://api.openai.com/v1/chat/completions',
        headers: (creds) => bearer(creds.key),
        buildRequest: ({ system, messages, model, stream }) => ({
            model,
            messages: withSystem(system, messages),
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            stream: stream !== false
        }),
        parseChunk: openAiChunk,
        parseFinal: openAiFinal,
        classify: classifyStatus
    },
    {
        id: 'ollama',
        label: 'Ollama (paikallinen)',
        needsKey: false,
        envKey: ['OLLAMA_URL', 'OLLAMA_MODEL'],
        defaultModel: 'llama3.2',
        stream: 'ndjson',
        enabled: () => Boolean(process.env.OLLAMA_URL || process.env.OLLAMA_MODEL),
        probeResult: ollamaProbe,
        resolveKeys: () => ({ base: ollamaBase(), model: process.env.OLLAMA_MODEL }),
        endpoint: ({ base }) => `${base}/api/chat`,
        headers: () => ({ 'Content-Type': 'application/json' }),
        buildRequest: ({ system, messages, model, stream }) => ({
            model,
            messages: withSystem(system, messages),
            stream: stream !== false,
            options: { num_predict: MAX_TOKENS, temperature: TEMPERATURE }
        }),
        parseChunk: (json) => (typeof json?.message?.content === 'string' ? json.message.content : ''),
        parseFinal: (body) => {
            const json = jsonSafe(body);
            return typeof json?.message?.content === 'string' ? json.message.content : '';
        },
        classify: classifyStatus,
        probe: async () => {
            try {
                const response = await fetch(`${ollamaBase()}/api/tags`, { signal: AbortSignal.timeout(1500) });
                ollamaProbe.ready = response.ok;
            } catch {
                ollamaProbe.ready = false;
            }
        }
    }
];

/* =========================================================
   READINESS + CIRCUIT BREAKER
   ========================================================= */
const breakers = new Map();

const isConfigured = (provider) => {
    if (typeof provider.enabled === 'function' && !provider.enabled()) return false;
    if (!provider.needsKey) return true;
    return Boolean(firstEnv(provider.envKey));
};

const isReady = (provider) => {
    if (!isConfigured(provider)) return false;
    if (provider.probe) return Boolean(provider.probeResult?.ready);
    return true;
};

const inCooldown = (id) => {
    const breaker = breakers.get(id);
    if (!breaker?.disabledUntil) return false;
    if (Date.now() >= breaker.disabledUntil) {
        breaker.disabledUntil = 0;
        breaker.failures = 0;
        return false;
    }
    return true;
};

const cooldownFor = (kind) => {
    if (kind === 'auth') return COOLDOWN_AUTH;
    if (kind === 'rate' || kind === 'timeout') return COOLDOWN_BUSY;
    return COOLDOWN_BASE;
};

const recordSuccess = (id) => {
    breakers.set(id, { failures: 0, disabledUntil: 0 });
};

const recordFailure = (id, kind) => {
    const breaker = breakers.get(id) || { failures: 0, disabledUntil: 0 };
    breaker.failures += 1;
    if (breaker.failures >= BREAKER_THRESHOLD) breaker.disabledUntil = Date.now() + cooldownFor(kind);
    breakers.set(id, breaker);
};

/* Keyed providers that are configured come first, the keyless fallback last.
   The fallback is exempt from the breaker: it is the only thing keeping the
   app alive without configuration, so it is always worth an attempt. */
const orderedCandidates = () => {
    const live = [];
    const fallback = [];
    for (const provider of providers) {
        if (!isReady(provider)) continue;
        if (!provider.fallback && inCooldown(provider.id)) continue;
        (provider.fallback ? fallback : live).push(provider);
    }
    return live.concat(fallback);
};

export function describeProviders() {
    return providers.map(provider => ({
        id: provider.id,
        label: provider.label,
        ready: isReady(provider),
        needsKey: provider.needsKey
    }));
}

export function defaultProviderId() {
    const candidates = orderedCandidates();
    return candidates.length ? candidates[0].id : null;
}

export async function initProviders() {
    for (const provider of providers) {
        if (typeof provider.probe !== 'function') continue;
        if (!isConfigured(provider)) continue;
        await provider.probe();
    }
}

/* =========================================================
   STREAM READING
   ========================================================= */
async function consumeStream(response, provider, onDelta) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const raw = [];
    let buffer = '';
    let text = '';
    let finished = false;

    const handle = (line) => {
        const trimmed = line.trim();
        if (!trimmed || finished) return;
        const payload = trimmed.startsWith('data:')
            ? trimmed.slice(5).trim()
            : (provider.stream === 'ndjson' ? trimmed : null);
        if (payload === null || payload === '[DONE]') {
            if (payload === '[DONE]') finished = true;
            return;
        }
        const json = jsonSafe(payload);
        if (json === undefined) return;
        if (json?.done === true) finished = true;
        const delta = provider.parseChunk(json) || '';
        if (!delta) return;
        text += delta;
        if (onDelta(delta) === false) finished = true;
    };

    while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        const piece = decoder.decode(value, { stream: true });
        raw.push(piece);
        buffer += piece;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
            handle(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
        }
    }
    if (!finished) handle(buffer);
    try {
        await reader.cancel();
    } catch {
        /* body already closed */
    }

    /* Several free APIs ignore stream:true and answer with one JSON body. */
    if (!text) {
        const late = provider.parseFinal(raw.join('')) || '';
        if (late) {
            text = late;
            onDelta(late);
        }
    }
    return text;
}

/* =========================================================
   GATEWAY
   ========================================================= */
const timeoutError = () => {
    const error = new Error('timeout');
    error.kind = 'timeout';
    return error;
};

const errorKind = (error) => {
    if (error?.kind) return error.kind;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
    return 'network';
};

/**
 * Try every ready provider in order until one answers.
 * onMeta(providerId, model) fires when a provider starts replying.
 * onDelta(text) fires per chunk; returning false stops the stream.
 */
export async function chat({ system, messages, stream = false, onMeta, onDelta }) {
    const candidates = orderedCandidates();
    if (!candidates.length) {
        const error = new Error('no providers');
        error.kind = 'unavailable';
        throw error;
    }

    const kinds = [];
    const keyNames = [];

    for (const provider of candidates) {
        const creds = provider.resolveKeys();
        const model = creds.model || provider.defaultModel;
        const wantsStream = stream !== false && provider.streaming !== false;
        const controller = new AbortController();
        const attemptTimer = setTimeout(() => controller.abort(timeoutError()), ATTEMPT_TIMEOUT);
        let idleTimer = null;
        const bumpIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => controller.abort(timeoutError()), IDLE_TIMEOUT);
        };

        const fail = (kind, status) => {
            kinds.push(kind);
            if (keyNames.length === 0 && kind === 'auth') keyNames.push(...provider.envKey);
            recordFailure(provider.id, kind);
            console.warn(`[ai] ${provider.id} -> ${kind}${status ? ` (${status})` : ''}`);
        };

        try {
            const response = await fetch(provider.endpoint(creds, { stream: wantsStream, model }), {
                method: 'POST',
                headers: provider.headers(creds, { stream: wantsStream }),
                body: JSON.stringify(provider.buildRequest({ system, messages, model, stream: wantsStream })),
                signal: controller.signal
            });
            if (!response.ok) {
                fail(provider.classify(response.status), response.status);
                continue;
            }

            /* Time-to-first-byte is what the attempt budget covers. */
            clearTimeout(attemptTimer);
            bumpIdle();
            onMeta?.(provider.id, model);

            let stopped = false;
            const push = (delta) => {
                if (stopped) return false;
                try {
                    if (onDelta?.(delta) === false) stopped = true;
                } catch {
                    stopped = true;
                }
                return !stopped;
            };

            const text = wantsStream
                ? await consumeStream(response, provider, push)
                : (provider.parseFinal(await response.text()) || '');

            if (!text.trim()) {
                fail('empty');
                continue;
            }
            recordSuccess(provider.id);
            return { reply: text.trim(), provider: provider.id, model, streamed: wantsStream };
        } catch (error) {
            fail(errorKind(error));
        } finally {
            clearTimeout(attemptTimer);
            if (idleTimer) clearTimeout(idleTimer);
        }
    }

    const failure = new Error('all providers failed');
    if (kinds.length && kinds.every(kind => kind === 'auth')) {
        failure.kind = 'auth';
        failure.hint = keyNames[0] || '';
    } else if (kinds.length && kinds.every(kind => kind === 'timeout')) {
        failure.kind = 'timeout';
    } else {
        failure.kind = 'exhausted';
    }
    throw failure;
}
