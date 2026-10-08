import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chat, defaultProviderId, describeProviders, initProviders } from './ai-providers.mjs';
import { calculateDeliveryPrice } from './booking.js';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = (process.env.KOTIVA_PUBLIC_DIR || process.env.PUHTOLA_PUBLIC_DIR) === 'dist' ? join(root, 'dist') : root;
const files = new Set(['index.html', 'style.css', 'app.js', 'robot.js', 'stage.js', 'booking.js', 'sound.js']);
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const port = Number(process.env.PORT || 3000);

/* Kotiva delivery requests are forwarded to the company inbox with Formspree.
   The endpoint lives here, not in the browser, so it can be swapped or
   pointed at a self-hosted form without touching the shipped site. */
const REQUEST_ENDPOINT = process.env.KOTIVA_REQUEST_ENDPOINT || process.env.PUHTOLA_REQUEST_ENDPOINT || 'https://formspree.io/f/xaeyljvb';
const REQUEST_TIMEOUT = 10000;

const MAX_BODY = 12000;
const MAX_MESSAGE_CHARS = 1200;
const MAX_HISTORY = 8;
const MAX_REPLY_CHARS = 1200;
const RATE_LIMIT = 20;
const RATE_WINDOW = 60000;

/* Per-field caps keep a delivery request compact and predictable. */
const REQUEST_LIMITS = {
    service: 60,
    name: 80,
    phone: 40,
    email: 120,
    address: 160,
    pickupAddress: 160,
    dropoffAddress: 160,
    size: 40,
    date: 12,
    time: 6,
    notes: 400
};

const VALID_SERVICES = new Set(["Pikatoimitus", "Pakettikuljetus", "Kauppakyyti", "Yrityskuljetus"]);
const ROUTE_QUOTE_TTL = 30 * 60 * 1000;
const ROUTE_CACHE_TTL = 10 * 60 * 1000;
const routeQuotes = new Map();
const geocodeCache = new Map();
const MAP_USER_AGENT = process.env.KOTIVA_MAP_USER_AGENT || 'kotiva/1.0 (route estimation; https://kotiva.local)';
let nominatimQueue = Promise.resolve();
let lastNominatimRequest = 0;

const SYSTEM_PROMPT = 'Olet kotivan suomenkielinen digitaalinen kuljetusavustaja. Autat tilaamaan pikatoimituksia, pakettikuljetuksia, kauppakyytejä ja yrityskuljetuksia Helsingissä, Espoossa ja Vantaalla. Vastaa ytimekkäästi suomeksi ja ohjaa käyttäjä valitsemaan palvelun, täyttämään nimen, puhelinnumeron, nouto-osoitteen ja toimitusosoitteen sekä valitsemaan aikaikkunan sovelluksen lomakkeella. Pikatoimitus alkaa 9 eurosta, pakettikuljetus 12 eurosta ja kauppakyyti 15 eurosta; yrityskuljetukset sovitaan tarpeen mukaan. Älä väitä tehneesi tilausta, vahvistaneesi kuljettajaa tai näyttäväsi reaaliaikaista seurantaa, ellei käyttöliittymä sitä erikseen kerro. Pidä sävy selkeänä, luotettavana ja käytännöllisenä.';

const errorText = {
    noProviders: 'AI-palvelu ei ole käytettävissä. Yritä hetken kuluttua uudelleen.',
    auth: 'AI-palvelut eivät ole käytettävissä. Aseta yksi API-avain palvelimen ympäristöön.',
    timeout: 'AI-palvelu vastasi liian hitaasti.',
    exhausted: 'AI-palvelu ei vastaa.',
    noKey: 'Aseta ilmainen avain (esim. GEMINI_API_KEY) palvelimen ympäristöön.',
    empty: 'AI-palvelu ei palauttanut vastausta.',
    rate: 'Liikaa pyyntöjä. Yritä hetken kuluttua uudelleen.',
    form: 'Pyyntöä ei voitu lähettää. Yritä hetken kuluttua uudelleen tai soita meille.',
    incomplete: 'Tilaus on keskeneräinen. Täytä nimi, puhelinnumero, nouto-osoite ja toimitusosoite.',
    badEmail: 'Sähköpostiosoite ei ole kelvollinen.',
    badJson: 'Virheellinen pyyntö.'
};

function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
}

function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
}

/* Per-IP sliding window, pruned on read so the map cannot grow forever. */
const hits = new Map();
function rateLimited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(time => now - time < RATE_WINDOW);
    if (recent.length >= RATE_LIMIT) {
        hits.set(ip, recent);
        return true;
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 500) {
        for (const [key, times] of hits) {
            if (!times.length || now - times[times.length - 1] >= RATE_WINDOW) hits.delete(key);
        }
    }
    return false;
}

const sseHeaders = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
};

function validMessages(messages) {
    return Array.isArray(messages) && messages.length >= 1 && messages.length <= MAX_HISTORY &&
        messages.every(m => m && ['user', 'assistant'].includes(m.role) &&
            typeof m.content === 'string' && m.content.trim().length > 0 && m.content.length <= MAX_MESSAGE_CHARS);
}

function failureMessage(error) {
    if (error?.kind === 'unavailable') return { status: 503, text: errorText.noProviders };
    if (error?.kind === 'auth') {
        const hint = error.hint ? ` (${error.hint})` : '';
        return { status: 502, text: `${errorText.auth}${hint}` };
    }
    if (error?.kind === 'timeout') return { status: 504, text: errorText.timeout };
    /* With no key configured the only candidate is the open endpoint, so
       say what actually turns the AI on instead of a bare failure. */
    const hasKeyed = describeProviders().some(p => p.ready && p.needsKey);
    return {
        status: 502,
        text: hasKeyed ? errorText.exhausted : `${errorText.exhausted} ${errorText.noKey}`
    };
}

/* =========================================================
   REQUEST BODY

   Reads a bounded JSON body once for both endpoints. Returns
   { body } when the payload parsed, otherwise { status, error }
   for the caller to answer with. `label` keeps the Finnish
   wording of each endpoint.
   ========================================================= */

async function readJsonBody(req, label) {
    let body = '';
    let tooLong = false;

    try {
        for await (const chunk of req) {
            body += chunk;
            if (body.length > MAX_BODY) {
                tooLong = true;
                break;
            }
        }
    } catch {
        return { status: 400, error: `Virheellinen ${label}.` };
    }

    if (tooLong) {
        req.resume();
        return { status: 413, error: `${label[0].toUpperCase()}${label.slice(1)} on liian pitkä.` };
    }

    try {
        const payload = JSON.parse(body);
        if (!payload || typeof payload !== 'object') return { status: 400, error: `Virheellinen ${label}.` };
        return { body: payload };
    } catch {
        return { status: 400, error: `Virheellinen ${label}.` };
    }
}

/* =========================================================
   REQUEST -> FORMSPREE

   The booking wizard posts here instead of straight to the form
   service, so the endpoint stays on the server, the payload is
   validated twice (here and in booking.js) and the existing
   per-IP rate limit covers form spam as well.
   ========================================================= */

function clean(value, max) {
    if (typeof value !== 'string') return '';
    /* Line breaks would scramble the forwarded body, so whitespace
       collapses to single spaces before the length cap. */
    return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function pruneRouteQuotes() {
    const now = Date.now();
    for (const [id, quote] of routeQuotes) {
        if (quote.expiresAt <= now) routeQuotes.delete(id);
    }
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function queueNominatim(query) {
    const task = nominatimQueue.then(async () => {
        const sinceLast = Date.now() - lastNominatimRequest;
        if (sinceLast < 1100) await wait(1100 - sinceLast);
        lastNominatimRequest = Date.now();

        const cached = geocodeCache.get(query.toLowerCase());
        if (cached && cached.expiresAt > Date.now()) return cached.value;

        const url = new URL('https://nominatim.openstreetmap.org/search');
        url.searchParams.set('q', `${query}, Finland`);
        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('limit', '1');
        url.searchParams.set('countrycodes', 'fi');

        const response = await fetch(url, {
            headers: {
                Accept: 'application/json',
                'User-Agent': MAP_USER_AGENT
            },
            signal: AbortSignal.timeout(9000)
        });
        if (!response.ok) throw new Error(`Geocoder HTTP ${response.status}`);

        const results = await response.json();
        const first = Array.isArray(results) ? results[0] : null;
        if (!first || !Number.isFinite(Number(first.lat)) || !Number.isFinite(Number(first.lon))) {
            throw new Error('Address not found');
        }

        const value = {
            lat: Number(first.lat),
            lon: Number(first.lon),
            label: first.display_name || query
        };
        geocodeCache.set(query.toLowerCase(), { value, expiresAt: Date.now() + ROUTE_CACHE_TTL });
        return value;
    });

    /* A rejected task must not permanently poison the queue. */
    nominatimQueue = task.catch(() => undefined);
    return task;
}

function haversineMeters(a, b) {
    const radians = (degrees) => degrees * Math.PI / 180;
    const earthRadius = 6371000;
    const dLat = radians(b.lat - a.lat);
    const dLon = radians(b.lon - a.lon);
    const lat1 = radians(a.lat);
    const lat2 = radians(b.lat);
    const value = Math.sin(dLat / 2) ** 2
        + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

async function getRoute(origin, destination) {
    const url = `https://router.project-osrm.org/route/v1/driving/${origin.lon},${origin.lat};${destination.lon},${destination.lat}`
        + '?overview=full&geometries=geojson&steps=false';

    try {
        const response = await fetch(url, {
            headers: { Accept: 'application/json', 'User-Agent': MAP_USER_AGENT },
            signal: AbortSignal.timeout(9000)
        });
        if (!response.ok) throw new Error(`Router HTTP ${response.status}`);
        const data = await response.json();
        const route = data?.routes?.[0];
        if (data?.code !== 'Ok' || !route?.geometry?.coordinates?.length) throw new Error('Route unavailable');
        return {
            distanceMeters: Number(route.distance),
            durationSeconds: Number(route.duration),
            coordinates: route.geometry.coordinates,
            source: 'osrm'
        };
    } catch (error) {
        /* Keep the order flow usable when the public demo router is busy. */
        const distanceMeters = haversineMeters(origin, destination) * 1.25;
        return {
            distanceMeters,
            durationSeconds: (distanceMeters / 1000 / 32) * 3600,
            coordinates: [[origin.lon, origin.lat], [destination.lon, destination.lat]],
            source: 'estimate'
        };
    }
}

async function handleRoute(req, res) {
    if (rateLimited(clientIp(req))) return json(res, 429, { error: errorText.rate });

    const contentType = req.headers['content-type'];
    if (contentType && !contentType.includes('json')) {
        return json(res, 415, { error: 'Väärä sisältötyyppi.' });
    }

    const read = await readJsonBody(req, 'reitti');
    if (read.error) return json(res, read.status, { error: read.error });
    const payload = read.body;
    const service = clean(payload.service, REQUEST_LIMITS.service);
    const pickupAddress = clean(payload.pickupAddress, REQUEST_LIMITS.pickupAddress);
    const dropoffAddress = clean(payload.dropoffAddress, REQUEST_LIMITS.dropoffAddress);

    if (!VALID_SERVICES.has(service) || pickupAddress.length < 4 || dropoffAddress.length < 4) {
        return json(res, 400, { error: errorText.incomplete });
    }

    pruneRouteQuotes();
    const cacheKey = `${service}|${pickupAddress.toLowerCase()}|${dropoffAddress.toLowerCase()}`;
    const cachedQuote = [...routeQuotes.values()].find((quote) => quote.cacheKey === cacheKey && quote.expiresAt > Date.now());
    if (cachedQuote) return json(res, 200, cachedQuote.response);

    try {
        const [origin, destination] = await Promise.all([
            queueNominatim(pickupAddress),
            queueNominatim(dropoffAddress)
        ]);
        const route = await getRoute(origin, destination);
        const pricing = calculateDeliveryPrice(service, route.distanceMeters);
        if (!pricing) throw new Error('Price unavailable');

        const quoteId = randomUUID();
        const response = {
            ok: true,
            quoteId,
            service,
            pickupAddress,
            dropoffAddress,
            pickup: origin,
            dropoff: destination,
            distanceMeters: Math.round(route.distanceMeters),
            distanceKm: pricing.distanceKm,
            durationSeconds: Math.round(route.durationSeconds),
            priceEuros: pricing.euros,
            price: pricing.label,
            geometry: route.coordinates,
            source: route.source,
            expiresAt: Date.now() + ROUTE_QUOTE_TTL
        };
        routeQuotes.set(quoteId, { ...response, cacheKey, response });
        return json(res, 200, response);
    } catch (error) {
        console.warn('Route lookup failed:', error?.message || error);
        return json(res, 502, { error: 'Reittiä ei voitu laskea. Tarkista osoitteet ja yritä uudelleen.' });
    }
}

function getValidQuote(quoteId, request) {
    pruneRouteQuotes();
    const quote = routeQuotes.get(quoteId);
    if (!quote || quote.expiresAt <= Date.now()) return null;
    if (quote.service !== request.service
        || quote.pickupAddress !== request.pickupAddress
        || quote.dropoffAddress !== request.dropoffAddress) return null;
    return quote;
}

async function handleRequest(req, res) {
    if (rateLimited(clientIp(req))) return json(res, 429, { error: errorText.rate });

    const contentType = req.headers['content-type'];
    if (contentType && !contentType.includes('json')) {
        return json(res, 415, { error: 'Väärä sisältötyyppi.' });
    }

    const read = await readJsonBody(req, 'pyyntö');
    if (read.error) return json(res, read.status, { error: read.error });
    const payload = read.body;

    /* Honeypot: a real visitor never sees this field, so anything in it
       is a bot. Answer as if it worked - the bot learns nothing - and
       never forward it. */
    if (clean(payload.company, 60)) {
        return json(res, 200, { ok: true, forwarded: false });
    }

    const request = {
        service: clean(payload.service, REQUEST_LIMITS.service),
        name: clean(payload.name, REQUEST_LIMITS.name),
        phone: clean(payload.phone, REQUEST_LIMITS.phone),
        email: clean(payload.email, REQUEST_LIMITS.email),
        address: clean(payload.address, REQUEST_LIMITS.address),
        pickupAddress: clean(payload.pickupAddress || payload.address, REQUEST_LIMITS.pickupAddress),
        dropoffAddress: clean(payload.dropoffAddress, REQUEST_LIMITS.dropoffAddress),
        size: clean(payload.size, REQUEST_LIMITS.size),
        date: clean(payload.date, REQUEST_LIMITS.date),
        time: clean(payload.time, REQUEST_LIMITS.time),
        notes: clean(payload.notes, REQUEST_LIMITS.notes),
        quoteId: clean(payload.quoteId, 80)
    };

    if (!VALID_SERVICES.has(request.service) || request.name.length < 2
        || request.phone.replace(/\D/g, '').length < 6
        || request.pickupAddress.length < 4 || request.dropoffAddress.length < 4) {
        return json(res, 400, { error: errorText.incomplete });
    }

    if (request.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(request.email)) {
        return json(res, 400, { error: errorText.badEmail });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(request.date) || !/^\d{2}:\d{2}$/.test(request.time)) {
        return json(res, 400, { error: errorText.incomplete });
    }

    const quote = getValidQuote(request.quoteId, request);
    if (!quote) {
        return json(res, 409, { error: 'Reittihinta on vanhentunut. Laske reitti ja hinta uudelleen.' });
    }

    try {
        const upstream = await fetch(REQUEST_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                ...request,
                quoteId: quote.quoteId,
                distanceKm: quote.distanceKm,
                estimatedDurationMinutes: Math.max(1, Math.round(quote.durationSeconds / 60)),
                quotedPrice: quote.price,
                _subject: `Uusi kuljetustilaus: ${request.service} - ${request.date} ${request.time}`
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT)
        });

        const result = await upstream.json().catch(() => ({}));

        if (!upstream.ok || result?.ok !== true) {
            /* Log the upstream reason once; the browser only ever sees
               the Finnish sentence, never the provider's internals. */
            console.warn(`Formspree rejected a request (${upstream.status}):`,
                result?.errors?.[0]?.message || result);
            return json(res, 502, { error: errorText.form });
        }

        return json(res, 200, { ok: true, forwarded: true });
    } catch (error) {
        console.warn('Formspree request failed:', error?.message || error);
        return json(res, 502, { error: errorText.form });
    }
}

async function handleChat(req, res) {
    if (rateLimited(clientIp(req))) return json(res, 429, { error: errorText.rate });
    const contentType = req.headers['content-type'];
    if (contentType && !contentType.includes('json')) {
        return json(res, 415, { error: 'Väärä sisältötyyppi.' });
    }

    const read = await readJsonBody(req, 'viesti');
    if (read.error) return json(res, read.status, { error: read.error });
    const payload = read.body;

    if (!validMessages(payload.messages)) {
        return json(res, 400, { error: 'Virheellinen viesti.' });
    }

    const messages = payload.messages
        .slice(-MAX_HISTORY)
        .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

    if (payload.stream === true) {
        res.writeHead(200, sseHeaders);
        const send = (frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`);
        let full = '';
        let closed = false;
        req.on('close', () => { closed = true; });
        try {
            const result = await chat({
                system: SYSTEM_PROMPT,
                messages,
                stream: true,
                onMeta: (provider, model) => send({ type: 'meta', provider, model }),
                onDelta: (text) => {
                    if (closed) return false;
                    full += text;
                    send({ type: 'delta', text });
                    if (full.length >= MAX_REPLY_CHARS) {
                        full = full.slice(0, MAX_REPLY_CHARS);
                        return false;
                    }
                    return true;
                }
            });
            if (!full.trim()) send({ type: 'delta', text: result.reply });
            full = full.trim() || result.reply;
            send({ type: 'done', reply: full.slice(0, MAX_REPLY_CHARS), provider: result.provider });
        } catch (error) {
            if (full.trim()) {
                send({ type: 'done', reply: full.slice(0, MAX_REPLY_CHARS), provider: 'partial' });
            } else {
                send({ type: 'error', error: failureMessage(error).text });
            }
        }
        return res.end();
    }

    try {
        const result = await chat({ system: SYSTEM_PROMPT, messages, stream: false });
        const reply = result.reply.slice(0, MAX_REPLY_CHARS);
        if (!reply.trim()) return json(res, 502, { error: errorText.empty });
        return json(res, 200, { reply, provider: result.provider, model: result.model, streamed: false });
    } catch (error) {
        const failure = failureMessage(error);
        return json(res, failure.status, { error: failure.text });
    }
}

const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/api/config' && req.method === 'GET') {
        return json(res, 200, {
            aiEnabled: true,
            streaming: true,
            requests: Boolean(REQUEST_ENDPOINT),
            providers: describeProviders(),
            defaultProvider: defaultProviderId()
        });
    }
    if (path === '/api/route' && req.method === 'POST') return handleRoute(req, res);
    if (path === '/api/request' && req.method === 'POST') return handleRequest(req, res);
    if (path === '/api/chat' && req.method === 'POST') return handleChat(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    const name = path === '/' ? 'index.html' : path.slice(1);
    if (!files.has(name)) return json(res, 404, { error: 'Not found' });
    try {
        const file = join(publicDir, name);
        const size = statSync(file).size;
        res.writeHead(200, { 'Content-Type': `${mime[extname(file)]}; charset=utf-8`, 'Content-Length': size });
        if (req.method === 'HEAD') res.end();
        else createReadStream(file).pipe(res);
    } catch {
        json(res, 404, { error: 'Not found' });
    }
});

await initProviders();

server.listen(port, () => {
    const ready = describeProviders().filter(p => p.ready).map(p => p.id);
    console.log(`kotiva ready at http://localhost:${port} (AI: ${ready.length} providers ready -> ${ready.join(', ') || 'none'})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    });
}
