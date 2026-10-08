/* =========================================================
   KOTIVA APP - marketplace UI, 3D stage, speech and order wiring
   ================================================================
   The droid lives in robot.js, the stage in stage.js and the
   order rules in booking.js. This file wires them to the
   DOM, microphone and text chat.

   Everything the customer sees or hears is Finnish (fi-FI):
   the speech language, the microphone language and the service
   names taken from SERVICES in booking.js.
   ========================================================= */

import * as THREE from "three";
import { createPuhtoRobot, ROBOT_STATE } from "./robot.js";
import { createStage } from "./stage.js";
import { createBooking, cancelBooking, getAvailableSlots, getService } from "./booking.js";
import { createSound } from "./sound.js";

/* =========================================================
   DOM ELEMENTS
   ========================================================= */

const container = document.getElementById("robot-container");
const assistantPanel = document.getElementById("assistant-panel");
const startOverlay = document.getElementById("start-overlay");
const startBookingButton = document.getElementById("start-booking-button");
const assistantMessage = document.getElementById("assistant-message");
const userMessage = document.getElementById("user-message");
const microphoneButton = document.getElementById("microphone-button");
const microphoneStatus = document.getElementById("mic-status");
const bookingPanel = document.getElementById("booking-panel");
const bookingService = document.getElementById("booking-service");
const customerName = document.getElementById("customer-name");
const customerPhone = document.getElementById("customer-phone");
const customerAddress = document.getElementById("booking-address");
const customerDropoff = document.getElementById("booking-dropoff");
const customerEmail = document.getElementById("booking-email");
const bookingWebsite = document.getElementById("booking-website");
const customerSize = document.getElementById("booking-size");
const bookingNotes = document.getElementById("booking-notes");
const bookingDate = document.getElementById("booking-date");
const bookingTime = document.getElementById("booking-time");
const confirmation = document.getElementById("confirmation");
const confirmationText = document.getElementById("confirmation-text");
const pricePreviewValue = document.getElementById("price-preview-value");
const calculateRouteButton = document.getElementById("calculate-route");
const routeStatus = document.getElementById("route-status");
const routeMapShell = document.getElementById("route-map-shell");
const routeMapElement = document.getElementById("route-map");
const routeSummary = document.getElementById("route-summary");
const routeDistance = document.getElementById("route-distance");
const routeDuration = document.getElementById("route-duration");
const routePrice = document.getElementById("route-price");
const serviceButtons = Array.from(document.querySelectorAll(".service-button"));
const muteButton = document.getElementById("mute-button");
const muteIcon = muteButton ? muteButton.querySelector(".btn-ico") : null;
const muteText = muteButton ? muteButton.querySelector(".btn-txt") : null;
const themeToggle = document.getElementById("theme-toggle");
const themeMeta = document.getElementById("meta-theme-color");
const aiBadge = document.getElementById("ai-badge");
const aiBadgeText = document.getElementById("ai-badge-text");

/* One console: the scrolling workspace and docked service quick picks. */
const consoleBody = document.querySelector(".console-body");
const conversationPane = document.querySelector(".conversation");
const quickRail = document.querySelector(".quick-rail");
const quickButtons = Array.from(document.querySelectorAll(".quick-chip"));

/* Route quote + map state. Quotes are intentionally short-lived and are
   invalidated whenever the service or either address changes. */
let routeQuote = null;
let routeMap = null;
let routeMapLayer = null;
let routeRequestVersion = 0;

/* =========================================================
   FEED SCROLL

   The workspace is the only pane that scrolls. It follows the visitor
   when they are already near the edge they care about, and only jumps
   when the caller says the jump is the point (a booking step change).
   ========================================================= */

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function scrollFeed({ force = false, align = "bottom", smooth = true, anchor = null } = {}) {
    if (!consoleBody) return;

    const maxScroll = consoleBody.scrollHeight - consoleBody.clientHeight;
    let target;

    if (anchor) {
        /* A pane that just opened (the booking form, the time picker) is
           worth more than the end of the feed: on short screens the fields
           sit below the fold, so the scroll lands on the pane itself. */
        const bodyRect = consoleBody.getBoundingClientRect();
        const paneRect = anchor.getBoundingClientRect();
        target = consoleBody.scrollTop + paneRect.top - bodyRect.top - 12;

        /* Tall pane title, short workspace: the first field would still be
           cut off, so the field wins over the title. Measured against the
           pane itself, not the pane's current position in the feed. */
        const firstField = anchor.querySelector("input, select, textarea");
        if (firstField) {
            const fieldRect = firstField.getBoundingClientRect();
            const fieldBottomInPane = fieldRect.bottom - paneRect.top;
            if (fieldBottomInPane + 12 > consoleBody.clientHeight - 16) {
                target = consoleBody.scrollTop + fieldRect.top - bodyRect.top - 12;
            }
        }
    } else {
        target = align === "top" ? 0 : maxScroll;
    }

    target = Math.min(Math.max(target, 0), Math.max(maxScroll, 0));

    if (!force) {
        const slack = 200;
        if (Math.abs(target - consoleBody.scrollTop) > slack) return;
    }

    consoleBody.scrollTo({
        top: target,
        behavior: (smooth && !reducedMotion.matches) ? "smooth" : "auto"
    });
}

/* Mobile browsers resize the visual viewport when the keyboard opens. Keep
   the active field above that resized edge without moving the whole page. */
let focusScrollFrame = 0;

function keepFocusedFieldVisible() {
    focusScrollFrame = 0;
    if (!consoleBody) return;

    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (!active.matches("input, select, textarea")) return;

    const bodyRect = consoleBody.getBoundingClientRect();
    const fieldRect = active.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportTop = viewport ? viewport.offsetTop : 0;
    const viewportBottom = viewportTop + (viewport ? viewport.height : window.innerHeight);
    const topLimit = Math.max(bodyRect.top, viewportTop) + 12;
    const bottomLimit = Math.min(bodyRect.bottom, viewportBottom) - 22;

    let adjustment = 0;
    if (fieldRect.bottom > bottomLimit) adjustment = fieldRect.bottom - bottomLimit;
    if (fieldRect.top < topLimit) adjustment = fieldRect.top - topLimit;
    if (!adjustment) return;

    const maxScroll = Math.max(consoleBody.scrollHeight - consoleBody.clientHeight, 0);
    const target = Math.min(Math.max(consoleBody.scrollTop + adjustment, 0), maxScroll);
    consoleBody.scrollTo({
        top: target,
        behavior: reducedMotion.matches ? "auto" : "smooth"
    });
}

function scheduleFocusedFieldScroll() {
    if (focusScrollFrame) cancelAnimationFrame(focusScrollFrame);
    focusScrollFrame = requestAnimationFrame(() => {
        focusScrollFrame = requestAnimationFrame(keepFocusedFieldVisible);
    });
}

document.addEventListener("focusin", scheduleFocusedFieldScroll);
if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleFocusedFieldScroll, { passive: true });
    window.visualViewport.addEventListener("scroll", scheduleFocusedFieldScroll, { passive: true });
}

/* A new turn starts at the top of the pinned conversation: the question and
   the first line of the answer are what the visitor needs to see. */
function resetConversation() {
    if (conversationPane) conversationPane.scrollTop = 0;
}

/* =========================================================
   THEME

   The stylesheet owns the palette; this only mirrors the choice
   onto the 3D stage so the droid never sits in the wrong lighting,
   and keeps the browser chrome colour in step.
   ========================================================= */

const THEME_COLOR = { light: "#eef5f1", dark: "#102b2b" };
const mobileThemeQuery = window.matchMedia("(max-width: 900px)");

function savedTheme() {
    try {
        const stored = localStorage.getItem("kotiva_theme") || localStorage.getItem("puhtola_theme");
        return stored === "dark" ? "dark" : "light";
    } catch (error) {
        return "light";
    }
}

function currentTheme() {
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme, { persist = true } = {}) {
    const nextTheme = mobileThemeQuery.matches ? "dark" : theme;
    document.documentElement.dataset.theme = nextTheme;
    if (themeMeta) themeMeta.content = THEME_COLOR[nextTheme];
    if (themeToggle) {
        themeToggle.textContent = nextTheme === "dark" ? "🌙" : "☀️";
        themeToggle.setAttribute("aria-pressed", String(nextTheme === "dark"));
    }
    if (persist && !mobileThemeQuery.matches) {
        try {
            localStorage.setItem("kotiva_theme", nextTheme);
        } catch (error) {
            /* Storage blocked: the choice simply lasts this session. */
        }
    }
    stage.setTheme(nextTheme);
}

function syncResponsiveTheme() {
    applyTheme(mobileThemeQuery.matches ? "dark" : savedTheme(), { persist: false });
}

if (typeof mobileThemeQuery.addEventListener === "function") {
    mobileThemeQuery.addEventListener("change", syncResponsiveTheme);
} else {
    mobileThemeQuery.addListener(syncResponsiveTheme);
}

/* =========================================================
   SOUND ENGINE (procedural sci-fi cues, no audio files)
   AudioContext can only start after a user gesture, so the
   first pointerdown / keydown unlocks it and starts the hum.
   ========================================================= */

const sound = createSound();

let soundUnlocked = false;
function unlockSound() {
    if (soundUnlocked) return;
    soundUnlocked = true;
    if (sound.unlock()) sound.startHum();
}
document.addEventListener("pointerdown", unlockSound, { once: true, passive: true });
document.addEventListener("keydown", unlockSound, { once: true });

if (muteButton) {
    const paint = () => {
        const muted = sound.isMuted();
        if (muteIcon) muteIcon.textContent = muted ? "◌" : "◒";
        if (muteText) muteText.textContent = muted ? "ÄÄNI POIS" : "ÄÄNI";
        muteButton.setAttribute("aria-pressed", String(muted));
    };
    paint();
    muteButton.addEventListener("click", () => {
        sound.toggleMute();
        paint();
        sound.cues.click();
    });
}

/* Release the audio hardware on a real unload; a bfcache restore keeps
   its page alive, so the context must survive that case. */
window.addEventListener("pagehide", (event) => {
    if (!event.persisted) sound.dispose();
});

/* =========================================================
   WIZARD (step 1 services -> step 2 details -> step 3 time)
   ========================================================= */

const wizardSteps = Array.from(document.querySelectorAll(".wizard-step"));
const wizardPane2 = document.getElementById("wizard-pane-2");
const wizardPane3 = document.getElementById("wizard-pane-3");

let wizardStep = 1;

function setWizardStep(step) {
    wizardStep = step;

    /* The service cards stay on screen at every step. Once a visitor has
       picked one they must be able to change it without walking back,
       so the list is never hidden - only the booking form comes and goes. */
    const bookingVisible = step >= 2;
    bookingPanel.classList.toggle("hidden", !bookingVisible);
    bookingPanel.setAttribute("aria-hidden", String(!bookingVisible));
    wizardPane2.classList.toggle("hidden", step !== 2);
    wizardPane2.setAttribute("aria-hidden", String(step !== 2));
    wizardPane3.classList.toggle("hidden", step !== 3);
    wizardPane3.setAttribute("aria-hidden", String(step !== 3));

    /* The compact rail takes over from the cards once the visitor has
       moved on, so the same four services are never listed twice. */
    if (quickRail) quickRail.classList.toggle("hidden", step === 1);

    /* A phone fits one pane at a time: while a booking is being filled in
       the stylesheet folds the pinned conversation and the stage away, so
       the fields get the height instead. */
    document.documentElement.toggleAttribute("data-booking", step >= 2);

    wizardSteps.forEach((chip) => {
        const number = Number(chip.dataset.step);
        const isActive = number === step;
        chip.classList.toggle("active", isActive);
        chip.classList.toggle("done", number < step);
        if (isActive) {
            chip.setAttribute("aria-current", "step");
        } else {
            chip.removeAttribute("aria-current");
        }
    });

    /* The free-time list is only needed once step 3 is on screen. */
    if (step === 3) updateTimes();

    /* The pane that just opened is the point of the click, so it is brought
       into view on purpose: the form fields and the time picker would
       otherwise stay below the fold on short screens. */
    const openedPane = step === 2 ? wizardPane2 : (step === 3 ? wizardPane3 : null);
    scrollFeed({ force: true, align: step === 1 ? "top" : "bottom", anchor: openedPane });

    /* Keep desktop keyboard users where they are working. On touch devices
       do not open the on-screen keyboard just because a service was tapped. */
    const isTouchLayout = window.matchMedia("(pointer: coarse)").matches;
    if (step === 2 && !isTouchLayout) customerName.focus({ preventScroll: true });
}

/* =========================================================
   STAGE + ROBOT
   ========================================================= */

const canvas = document.createElement("canvas");
canvas.style.cssText = "width:100%;height:100%;display:block;touch-action:none;";
canvas.setAttribute("role", "img");
canvas.setAttribute("aria-label", "Kotivan 3D-näkymä");
container.appendChild(canvas);

const stage = createStage(canvas, container);
const robot = createPuhtoRobot();
stage.scene.add(robot.root);

applyTheme(currentTheme(), { persist: false });

if (themeToggle) {
    themeToggle.addEventListener("click", () => {
        if (mobileThemeQuery.matches) return;
        applyTheme(currentTheme() === "dark" ? "light" : "dark");
        sound.cues.click();
    });
}

/* =========================================================
   GAZE - Puhto's head follows the pointer

   Pointermove can fire far more often than the screen refreshes,
   so the work is coalesced into one raycast per animation frame.
   ========================================================= */

const gazeEnabled = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
if (gazeEnabled) {
    const gazeAnchor = new THREE.Vector3(0, 1.9, 0.5);
    let gazeFrame = 0;
    let gazeX = 0;
    let gazeY = 0;

    container.addEventListener("pointermove", (event) => {
        gazeX = event.clientX;
        gazeY = event.clientY;
        if (gazeFrame) return;
        gazeFrame = requestAnimationFrame(() => {
            gazeFrame = 0;
            const point = stage.pointerGaze(gazeX, gazeY, gazeAnchor);
            if (point) robot.setGazePoint(point);
        });
    }, { passive: true });

    container.addEventListener("pointerleave", () => {
        robot.setGazePoint(null);
    }, { passive: true });
}

/* =========================================================
   RENDER LOOP
   ========================================================= */

let lastFrame = performance.now();
let elapsed = 0;

let frameId = null;
let stageVisible = true;
function frame(now) {
    frameId = requestAnimationFrame(frame);
    const rawDt = (now - lastFrame) / 1000;
    lastFrame = now;
    const dt = Math.min(0.1, rawDt);
    elapsed += dt;
    robot.update(dt);
    stage.render(dt, elapsed, rawDt);
}
function syncRendering() {
    if (document.hidden || !stageVisible) {
        if (frameId !== null) cancelAnimationFrame(frameId);
        frameId = null;
        return;
    }
    if (frameId === null) {
        lastFrame = performance.now();
        frameId = requestAnimationFrame(frame);
    }
}
new IntersectionObserver(([entry]) => {
    stageVisible = entry.isIntersecting;
    syncRendering();
}, { threshold: 0 }).observe(container);
document.addEventListener("visibilitychange", syncRendering);
syncRendering();


/* =========================================================
   SPEECH (TTS) - drives the talking state + lip sync
   ========================================================= */

let voiceTimer = null;

/* getVoices() walks the whole voice list, so it is asked once and
   refreshed only when the browser finishes installing voices. */
let finnishVoices = [];
function refreshVoices() {
    if (!("speechSynthesis" in window)) return;
    finnishVoices = speechSynthesis.getVoices().filter(
        (voice) => voice.lang && voice.lang.toLowerCase().startsWith("fi")
    );
}
refreshVoices();
if ("speechSynthesis" in window) {
    speechSynthesis.addEventListener("voiceschanged", refreshVoices);
}

function stopTalking() {
    if (voiceTimer) {
        clearInterval(voiceTimer);
        voiceTimer = null;
    }
    if (robot.getState() === ROBOT_STATE.TALKING) {
        robot.setState(ROBOT_STATE.IDLE);
    }
}

function speak(text) {
    assistantMessage.textContent = text;
    assistantMessage.classList.remove("is-streaming");
    resetConversation();

    robot.setState(ROBOT_STATE.TALKING);

    /* Keep the mouth moving even where onboundary never fires. */
    if (voiceTimer) clearInterval(voiceTimer);
    voiceTimer = setInterval(() => robot.pulseVoice(0.55 + Math.random() * 0.45), 180);
    robot.pulseVoice(1);

    if (!("speechSynthesis" in window)) {
        /* No TTS at all - just let the text display, then idle. */
        setTimeout(stopTalking, Math.min(6000, 1200 + text.length * 55));
        return;
    }

    try {
        speechSynthesis.cancel();

        const speech = new SpeechSynthesisUtterance(text);
        speech.rate = 0.95;
        speech.pitch = 1.05;
        speech.volume = 1;
        speech.lang = "fi-FI";

        /* Use an installed Finnish voice when the browser has one. */
        if (finnishVoices.length) speech.voice = finnishVoices[0];

        /* Word boundaries give real lip sync where supported. */
        speech.onboundary = () => robot.pulseVoice(0.8 + Math.random() * 0.2);
        speech.onend = stopTalking;
        speech.onerror = stopTalking;

        speechSynthesis.speak(speech);
    } catch (error) {
        console.warn("Speech synthesis failed:", error);
        stopTalking();
    }
}

/* =========================================================
   GREETING / MOVEMENT
   ========================================================= */

function greet() {
    robot.playWave();
    sound.cues.boot();
    /* HEI is intentionally visual and tactile only: no greeting sentence
       is added to the conversation or spoken aloud. */
}

let movementTarget = 0;

function moveRobot() {
    movementTarget = Math.abs(movementTarget) < 0.1 ? 1.2 : -movementTarget;
    robot.walkTo(movementTarget);
}

/* =========================================================
   SPEECH RECOGNITION (Finnish)
   ========================================================= */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

/* The label span is looked up once instead of on every state change. */
const micLabel = microphoneButton ? microphoneButton.querySelector("span:last-child") : null;

function setMicLabel(text) {
    if (micLabel) micLabel.textContent = text;
}

if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "fi-FI";

    recognition.onstart = () => {
        microphoneButton.classList.add("listening");
        setMicLabel("KUUNTELEN...");
        microphoneStatus.textContent = "Kuuntelen. Kerro, mitä haluat kuljettaa.";
        microphoneStatus.classList.remove("is-ai");
        robot.setState(ROBOT_STATE.LISTENING);
        sound.cues.listen();
    };

    recognition.onresult = (event) => {
        const text = event.results[0][0].transcript;
        userMessage.textContent = "Sinä: " + text;
        resetConversation();

        /* Puhto ponders for half a second before replying. */
        robot.setState(ROBOT_STATE.THINKING);
        setTimeout(() => handleCustomerMessage(text), 550);
    };

    recognition.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        microphoneStatus.textContent = "En saanut selvää. Yritä uudelleen.";
        microphoneStatus.classList.remove("is-ai");
        robot.setState(ROBOT_STATE.IDLE);
    };

    recognition.onend = () => {
        microphoneButton.classList.remove("listening");
        setMicLabel("KYSY KOTIVAA");
        if (robot.getState() === ROBOT_STATE.LISTENING) {
            robot.setState(ROBOT_STATE.IDLE);
        }
        sound.cues.listenEnd();
    };
}


/* =========================================================
   AI GATEWAY (server-side, multi-provider with failover)

   /api/chat streams plain-text-friendly SSE frames:
     {"type":"meta","provider":"..."}   once
     {"type":"delta","text":"..."}     per token
     {"type":"done","reply":"..."}     at the end
     {"type":"error","error":"..."}    when every provider failed
   The provider key itself never reaches the browser.
   ========================================================= */

let selectedService = null;
let aiEnabled = false;
let requestVersion = 0;
let aiController = null;
const conversation = [];

const AI_DEADLINE = 30000;

function routeKey(service = selectedService, pickup = customerAddress?.value, dropoff = customerDropoff?.value) {
    return [service || "", (pickup || "").trim(), (dropoff || "").trim()].join("|");
}

function formatRouteDuration(seconds) {
    const minutes = Math.max(1, Math.round(Number(seconds || 0) / 60));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

function invalidateRouteQuote(message = "Syötä molemmat osoitteet ja laske reitti.") {
    routeQuote = null;
    routeSummary?.classList.add("hidden");
    if (routeStatus) routeStatus.textContent = message;
    if (pricePreviewValue) pricePreviewValue.textContent = getService(selectedService)?.price || "—";
    if (routeMapLayer && routeMap) {
        routeMap.removeLayer(routeMapLayer);
        routeMapLayer = null;
    }
    routeMapShell?.classList.add("hidden");
}

function ensureRouteMap() {
    if (!routeMapElement || !window.L) return null;
    if (routeMap) return routeMap;

    routeMap = window.L.map(routeMapElement, {
        zoomControl: false,
        attributionControl: true,
        scrollWheelZoom: false
    });
    window.L.control.zoom({ position: "topright" }).addTo(routeMap);
    window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap contributors"
    }).addTo(routeMap);
    return routeMap;
}

function renderRouteQuote(quote) {
    routeQuote = quote;
    routeMapShell?.classList.remove("hidden");
    routeSummary?.classList.remove("hidden");

    const distanceText = `${Number(quote.distanceKm).toFixed(1).replace(".", ",")} km`;
    const durationText = formatRouteDuration(quote.durationSeconds);
    if (routeDistance) routeDistance.textContent = distanceText;
    if (routeDuration) routeDuration.textContent = durationText;
    if (routePrice) routePrice.textContent = quote.price;
    if (pricePreviewValue) pricePreviewValue.textContent = quote.price;
    if (routeStatus) {
        routeStatus.textContent = quote.source === "estimate"
            ? "Reitti arvioitu varalla — hinta perustuu etäisyyteen."
            : "Reitti löytyi — hinta ja aika päivitetty.";
    }

    const map = ensureRouteMap();
    if (!map || !Array.isArray(quote.geometry)) return;

    if (routeMapLayer) map.removeLayer(routeMapLayer);
    const routePoints = quote.geometry.map(([lon, lat]) => [lat, lon]);
    const pickupPoint = [quote.pickup.lat, quote.pickup.lon];
    const dropoffPoint = [quote.dropoff.lat, quote.dropoff.lon];
    const layers = [
        window.L.polyline(routePoints, { color: "#1b6b59", weight: 5, opacity: .88 }),
        window.L.circleMarker(pickupPoint, { radius: 8, color: "#1b6b59", fillColor: "#70c5a4", fillOpacity: 1, weight: 3 }).bindTooltip("Nouto"),
        window.L.circleMarker(dropoffPoint, { radius: 8, color: "#b87836", fillColor: "#f3c47e", fillOpacity: 1, weight: 3 }).bindTooltip("Toimitus")
    ];
    routeMapLayer = window.L.layerGroup(layers).addTo(map);
    map.fitBounds(window.L.latLngBounds(routePoints), { padding: [18, 18], maxZoom: 13 });
    window.setTimeout(() => map.invalidateSize(), 80);
}

async function calculateRoute() {
    const pickupAddress = customerAddress?.value.trim() || "";
    const dropoffAddress = customerDropoff?.value.trim() || "";
    if (!selectedService) {
        if (routeStatus) routeStatus.textContent = "Valitse ensin kuljetuspalvelu.";
        return false;
    }
    if (pickupAddress.length < 4 || dropoffAddress.length < 4) {
        if (routeStatus) routeStatus.textContent = "Täytä nouto- ja toimitusosoite ensin.";
        return false;
    }

    const version = ++routeRequestVersion;
    if (calculateRouteButton) {
        calculateRouteButton.disabled = true;
        calculateRouteButton.classList.add("is-loading");
    }
    if (routeStatus) routeStatus.textContent = "Lasketaan reittiä ja hintaa...";
    routeQuote = null;

    try {
        const response = await fetch("/api/route", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ service: selectedService, pickupAddress, dropoffAddress })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.error || `HTTP ${response.status}`);
        if (version !== routeRequestVersion) return false;
        renderRouteQuote(data);
        return true;
    } catch (error) {
        if (version === routeRequestVersion && routeStatus) {
            routeStatus.textContent = error.message || "Reittiä ei voitu laskea.";
        }
        return false;
    } finally {
        if (version === routeRequestVersion && calculateRouteButton) {
            calculateRouteButton.disabled = false;
            calculateRouteButton.classList.remove("is-loading");
        }
    }
}

function routeQuoteMatchesCurrentInputs() {
    return Boolean(routeQuote
        && routeQuote.service === selectedService
        && routeQuote.pickupAddress === customerAddress.value.trim()
        && routeQuote.dropoffAddress === customerDropoff.value.trim()
        && Number(routeQuote.expiresAt) > Date.now());
}

function setAiBadge(text, state = "") {
    if (!aiBadge || !aiBadgeText) return;
    aiBadgeText.textContent = text;
    aiBadge.classList.toggle("is-offline", state === "offline");
    aiBadge.classList.toggle("is-busy", state === "busy");
}

fetch("/api/config").then(r => r.ok ? r.json() : null).then(config => {
    if (!config) throw new Error("no config");
    aiEnabled = config.aiEnabled !== false;
    const ready = (config.providers ?? []).filter(p => p.ready).length;
    setAiBadge(
        ready > 1 ? `${ready} AI-PALVELUA` : "AI KÄYTÖSSÄ",
        aiEnabled ? "" : "offline"
    );
    if (aiEnabled) {
        microphoneStatus.textContent = "AI käytössä. Voit kysyä myös palveluistamme.";
        microphoneStatus.classList.add("is-ai");
    }
}).catch(() => {
    aiEnabled = false;
    setAiBadge("PAIKALLINEN AVUSTAJA", "offline");
});

function abortAI() {
    if (aiController) {
        aiController.abort();
        aiController = null;
    }
}

/* Splits the SSE byte stream into complete `data:` payloads. */
function framePayload(buffer) {
    const frames = buffer.split("\n\n");
    const rest = frames.pop() ?? "";
    const messages = [];
    for (const frame of frames) {
        for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
                messages.push(JSON.parse(payload));
            } catch (error) {
                /* A malformed frame must not kill the whole reply. */
            }
        }
    }
    return { messages, rest };
}

async function askAI(text) {
    const version = ++requestVersion;
    abortAI();

    /* The gateway walks up to ten providers before giving up, so the
       browser needs its own ceiling. Whatever already streamed is
       still spoken, which beats an endless "thinking" spinner. The
       controller is captured locally: a later message replaces the
       shared handle, and this deadline must never touch that one. */
    const controller = new AbortController();
    aiController = controller;
    const deadline = setTimeout(() => controller.abort(), AI_DEADLINE);

    stopTalking();
    robot.setState(ROBOT_STATE.THINKING);
    microphoneStatus.textContent = "Kotivan avustaja miettii vastausta...";
    setAiBadge("MIETITÄÄN", "busy");
    resetConversation();

    assistantMessage.classList.add("is-streaming");

    const history = [...conversation.slice(-6), { role: "user", content: text }];
    let full = "";

    const finish = (reply, fallback) => {
        if (version !== requestVersion) return;
        assistantMessage.classList.remove("is-streaming");
        setAiBadge("AI KÄYTÖSSÄ");
        if (reply && reply.trim()) {
            conversation.push({ role: "user", content: text }, { role: "assistant", content: reply });
            microphoneStatus.textContent = "AI-vastaus valmis.";
            speak(reply);
        } else {
            microphoneStatus.textContent = "AI ei vastaa. Paikallinen avustaja on käytössä.";
            localFallback();
        }
        if (fallback) console.warn("AI reply empty:", fallback);
    };

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: history, stream: true }),
            signal: controller.signal
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || `HTTP ${response.status}`);
        }

        const type = response.headers.get("Content-Type") || "";
        if (!type.includes("text/event-stream") || !response.body) {
            const data = await response.json();
            assistantMessage.classList.remove("is-streaming");
            setAiBadge("AI KÄYTÖSSÄ");
            if (version !== requestVersion) return;
            if (typeof data.reply !== "string" || !data.reply.trim()) throw new Error("Tyhjä vastaus");
            finish(data.reply);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let failed = null;

        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const parsed = framePayload(buffer);
            buffer = parsed.rest;

            for (const message of parsed.messages) {
                if (version !== requestVersion) return;
                if (message.type === "delta" && typeof message.text === "string") {
                    full += message.text;
                    if (full.length > 1200) full = full.slice(0, 1200);
                    assistantMessage.textContent = full;
                    /* The mouth and core react as the words arrive. */
                    robot.pulseVoice(0.35 + Math.random() * 0.35);
                } else if (message.type === "error") {
                    failed = message.error || "Tuntematon virhe";
                }
            }
        }

        if (version !== requestVersion) return;
        finish(full, failed);
    } catch (error) {
        if (version !== requestVersion) return;
        if (error && error.name === "AbortError" && !full) {
            microphoneStatus.textContent = "AI vastasi liian hitaasti.";
            console.warn("AI request aborted by the client deadline.");
        } else {
            console.warn("AI request failed:", error);
        }
        assistantMessage.classList.remove("is-streaming");
        setAiBadge("AI KÄYTÖSSÄ");
        finish(full || "");
    } finally {
        clearTimeout(deadline);
        if (version === requestVersion) aiController = null;
    }
}

/* Varied replies keep the assistant from sounding like a loop. */
function pick(...lines) {
    return lines[Math.floor(Math.random() * lines.length)];
}

/* Splits a message into words, so short words such as "hei" or
   "haku" never match inside a longer word like "heinäkuu". */
function words(text) {
    return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/* True when the message contains one of the given words.
   Longer words also match their inflected forms ("sivusto",
   "sivuston" for "sivu" style stems). */
function says(text, ...list) {
    const tokens = words(text);

    return list.some(
        (word) => tokens.some(
            (token) => token === word || (word.length > 3 && token.startsWith(word))
        )
    );
}

function handleCustomerMessage(text) {
    ++requestVersion; // Ignore an older AI response when a newer message arrives.
    const lower = text.toLowerCase();

    if (says(lower, "hei", "moi", "terve", "päivää", "huomenta", "iltaa", "hello", "hi")) {
        greet();
        speak("Hei! Autan sinua tilaamaan noudon nopeasti.");
        return;
    }

    if (says(lower, "palvelut", "tarjonta", "hinnat", "hinta", "hinnasto", "price", "pricing")
        || lower.includes("mitä teette") || lower.includes("palveluista") || lower.includes("maksaako")) {
        speak(pick(
            "Kotivan palvelut: pikatoimitus alkaen 9 euroa, pakettikuljetus alkaen 12 euroa ja kauppakyyti alkaen 15 euroa. Yrityskuljetukset hinnoitellaan tarpeen mukaan.",
            "Näet alustavan hinnan ennen vahvistusta. Pikatoimitus alkaa 9 eurosta, pakettikuljetus 12 eurosta ja kauppakyyti 15 eurosta."
        ));
        return;
    }

    if (says(lower, "pikatoimitus", "pika", "heti", "kiireellinen", "urgent", "express")) {
        selectService("Pikatoimitus");
        speak("Selvä. Pikatoimitus vie lähetyksen ovelta ovelle mahdollisimman nopeasti. Lisää nouto- ja toimitusosoite.");
        return;
    }

    if (says(lower, "paketti", "pakettikuljetus", "lähetys", "lähetä", "posti", "parcel")) {
        selectService("Pakettikuljetus");
        speak("Hyvä. Pakettikuljetus sopii turvalliseen ovelta ovelle -lähetykseen. Tarvitsen nouto- ja toimitusosoitteen.");
        return;
    }

    if (says(lower, "kauppa", "ostokset", "ruoka", "kauppakyyti", "grocery", "shop")) {
        selectService("Kauppakyyti");
        speak("Selvä. Kauppakyyti tuo ostokset kaupasta kotiovelle. Lisää osoitteet, niin jatketaan.");
        return;
    }

    if (says(lower, "yritys", "yrityksille", "toimisto", "liiketila", "toistuva", "business")) {
        selectService("Yrityskuljetus");
        speak("Yrityskuljetus sopii toistuviin ajoihin ja toimitusketjuihin. Kerro yhteystietosi ja reitti, niin olemme yhteydessä.");
        return;
    }

    if (says(lower, "seuranta", "seuraa", "kuljettaja", "missä", "tracking")) {
        speak("Kun kuljetus on vahvistettu, saat tilausvahvistuksen ja seurantalinkin yhteystietoihisi.");
        return;
    }

    if (says(lower, "varaus", "varata", "varaa", "tilaa", "tilaus", "aika", "vapaana", "book", "booking")) {
        if (selectedService) {
            showBooking();
            speak("Hyvä. Täytä nouto- ja toimitusosoitteet, ja valitse sitten aikaikkuna.");
        } else {
            speak("Totta kai. Valitse ensin palvelu: pikatoimitus, pakettikuljetus, kauppakyyti tai yrityskuljetus.");
        }
        return;
    }

    if (says(lower, "liiku", "siirry", "move")) {
        moveRobot();
        speak("Selvä, katso miten liikun.");
        return;
    }

    if (says(lower, "tanssi", "tanssia", "dance")) {
        robot.playHappy();
        speak("Pieni juhlatanssi kuljetuksen kunniaksi!");
        return;
    }

    if (says(lower, "pyörähdä", "pyöri", "kierrä", "spin", "circle")) {
        robot.playHappy();
        speak(pick("Katso tätä pyörähdystä!", "Pyörähdys tulossa - hop!"));
        return;
    }

    if (says(lower, "heippa", "moikka", "näkemiin", "hyvästi", "goodbye", "bye")) {
        robot.playWave();
        speak("Hei hei! Kotiva on täällä, kun tarvitset seuraavan kuljetuksen.");
        return;
    }

    if (says(lower, "apua", "auta", "ohje", "help")
        || lower.includes("mitä osaat") || lower.includes("mitä voit tehdä")) {
        speak("Voit tilata meiltä pikatoimituksen, pakettikuljetuksen, kauppakyydin tai yrityskuljetuksen. Valitse palvelu, lisää osoitteet ja nappaa sopiva aikaikkuna.");
        return;
    }

    if (lower.includes("nimesi") || lower.includes("kuka olet")) {
        speak("Olen kotivan digitaalinen avustaja. Autan järjestämään noudot ja toimitukset helposti.");
        return;
    }

    if (says(lower, "kiitos", "kiitti", "thank")) {
        speak(pick("Ole hyvä. Laitetaan kuljetus liikkeelle.", "Kiitos sinulle. Olen täällä, kun tarvitset kyytiä."));
        return;
    }

    if (aiEnabled) askAI(text);
    else localFallback();
}

function localFallback() {
    speak(pick(
        "Autan tilaamaan noudon ja toimituksen. Valitse pikatoimitus, pakettikuljetus, kauppakyyti tai yrityskuljetus.",
        "Kerro, mitä haluat kuljettaa ja mistä minne, niin järjestetään sopiva kyyti.",
        "Voit kysyä hinnoista, saatavuudesta tai tilata kuljetuksen suoraan valitsemalla palvelun."
    ));
}


/* =========================================================
   SELECT SERVICE / SHOW BOOKING

   Every service stays visible in the same window; the chosen
   one is only highlighted, so switching is one click away.
   ========================================================= */

function highlightService(service) {
    serviceButtons.forEach((button) => {
        const selected = button.dataset.service === service;
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
    });

    /* The docked rail mirrors the cards, so both stay in sync. */
    quickButtons.forEach((button) => {
        const selected = button.dataset.quick === service;
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
    });
}

function selectService(service) {
    /* Only the keys in SERVICES (booking.js) can be booked, so a stale
       voice command can never leave the form pointing at nothing. */
    if (!getService(service)) return false;

    const isFirstChoice = !selectedService;
    const isOnServiceStep = wizardStep === 1;

    selectedService = service;
    bookingService.value = service;
    invalidateRouteQuote("Palvelu vaihtui — laske reitti ja hinta uudelleen.");

    confirmation.classList.add("hidden");

    highlightService(service);

    /* Selecting a service is always the entry into the details form when
       the wizard is on step 1. This also covers returning to the service
       list and choosing again: selectedService intentionally stays set so
       typed details are preserved, but the form must reopen. */
    if (isFirstChoice || isOnServiceStep) {
        requestAnimationFrame(() => {
            setWizardStep(2);                   /* wizard moves on to the details step */
            moveRobot();                        /* Puhto strolls over smoothly */
        });
    } else if (wizardStep === 3) {
        updateTimes();                         /* a new service may free up slots */
    }

    return true;
}

function showBooking() {
    confirmation.classList.add("hidden");
    setWizardStep(selectedService ? 2 : 1);
}

/* =========================================================
   DEFAULT DATE + AVAILABLE TIMES
   ========================================================= */

const today = new Date();
const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

bookingDate.min = todayString;
bookingDate.value = todayString;

function updateTimes() {
    bookingTime.innerHTML = `<option value="">Valitse aika</option>`;

    const date = bookingDate.value;
    if (!date) return;

    getAvailableSlots(date).forEach((time) => {
        const option = document.createElement("option");
        option.value = time;
        option.textContent = time;
        bookingTime.appendChild(option);
    });
}

bookingDate.addEventListener("change", updateTimes);

/* =========================================================
   SERVICE BUTTONS
   ========================================================= */

/* One picker, two handles: the cards in the workspace and the pills in the
   docked rail run the same path, so the highlight can never disagree. */

function pickService(button) {
    const service = button.dataset.service || button.dataset.quick;
    const label = button.dataset.label || service;
    const changed = selectedService !== service;

    if (!selectService(service)) return;
    sound.cues.confirm();

    /* Re-picking the service already on screen does not need an extra
       spoken confirmation; the selected card and wizard step provide the
       visual feedback. */
}

serviceButtons.forEach((button) => {
    button.addEventListener("click", () => pickService(button));
});

quickButtons.forEach((button) => {
    button.addEventListener("click", () => pickService(button));
});


/* =========================================================
   WIZARD NAVIGATION (back / next between the three steps)
   ========================================================= */

document.getElementById("wizard-back-2").addEventListener("click", () => {
    setWizardStep(1);
});

document.getElementById("wizard-back-3").addEventListener("click", () => {
    setWizardStep(2);
});

calculateRouteButton?.addEventListener("click", calculateRoute);

/* Any route edit invalidates the previous quote. This prevents a displayed
   price from surviving after the customer changes an address. */
[customerAddress, customerDropoff].forEach((field) => field.addEventListener("input", () => {
    if (routeQuote) invalidateRouteQuote("Osoite muuttui — laske reitti ja hinta uudelleen.");
}));

/* Enter on either route field behaves like the route calculator. */
[customerAddress, customerDropoff].forEach((field) => field.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && wizardStep === 2) {
        event.preventDefault();
        calculateRoute();
    }
}));

document.getElementById("wizard-next-2").addEventListener("click", () => {
    const name = customerName.value.trim();
    const phone = customerPhone.value.trim();
    const phoneDigits = phone.replace(/\D/g, "");
    const address = customerAddress.value.trim();
    const dropoffAddress = customerDropoff.value.trim();

    if (name.length < 2) {
        speak("Syötä koko nimesi.");
        customerName.focus();
        return;
    }

    if (phoneDigits.length < 6) {
        speak("Syötä kelvollinen puhelinnumero.");
        customerPhone.focus();
        return;
    }

    if (address.length < 4) {
        speak("Syötä nouto-osoite.");
        customerAddress.focus();
        return;
    }

    if (dropoffAddress.length < 4) {
        speak("Syötä toimitusosoite, jotta kuljettaja tietää minne mennä.");
        customerDropoff.focus();
        return;
    }

    if (!routeQuoteMatchesCurrentInputs()) {
        routeStatus.textContent = "Laske ensin reitti ja hinta ajantasaisilla osoitteilla.";
        calculateRouteButton?.focus();
        speak("Laske ensin reitti ja hinta.");
        return;
    }

    setWizardStep(3);
    speak("Hyvä. Valitse nyt päivämäärä ja vapaa aikaikkuna.");
});

/* =========================================================
   MICROPHONE
   ========================================================= */

microphoneButton.addEventListener("click", () => {
    if (!recognition) {
        microphoneStatus.textContent =
            "Puheentunnistus ei ole käytettävissä tässä selaimessa - kirjoita viesti tekstikenttään.";
        speak("Puheentunnistus ei ole käytettävissä tässä selaimessa. Käytä Chromea tai kirjoita viesti alle.");
        return;
    }

    try {
        recognition.start();
    } catch (error) {
        console.log("Recognition already running.");
    }
});

/* =========================================================
   TEXT CHAT FALLBACK (works in every browser)
   ========================================================= */

const textInput = document.getElementById("text-input");
const sendButton = document.getElementById("send-button");

function sendTextMessage() {
    if (!textInput) return;
    const text = textInput.value.trim();
    if (!text) return;

    textInput.value = "";
    userMessage.textContent = "Sinä: " + text;
    resetConversation();

    robot.setState(ROBOT_STATE.THINKING);
    setTimeout(() => handleCustomerMessage(text), 450);
}

if (sendButton) sendButton.addEventListener("click", sendTextMessage);
if (textInput) {
    textInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") sendTextMessage();
    });
}

/* =========================================================
   HELLO BUTTON
   ========================================================= */

document.getElementById("greeting-button").addEventListener("click", greet);

function openRequestFlow() {
    document.body.dataset.appState = "request";
    assistantPanel.classList.remove("hidden");
    assistantPanel.setAttribute("aria-hidden", "false");
    startBookingButton.setAttribute("aria-expanded", "true");
    startOverlay.setAttribute("aria-hidden", "true");
    setWizardStep(1);

    requestAnimationFrame(() => {
        const firstService = serviceButtons[0];
        if (firstService) firstService.focus({ preventScroll: true });
        scrollFeed({ force: true, align: "top" });
    });
}

startBookingButton.addEventListener("click", openRequestFlow);

/* =========================================================
   CONFIRM BOOKING

   The booking is written to the local ledger first, then the
   request goes to the server, which forwards it to the company
   inbox. The ledger entry is rolled back when the send fails, so
   a retry never trips over its own earlier attempt.
   ========================================================= */

const REQUEST_DEADLINE = 15000;

async function sendRequest(booking) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), REQUEST_DEADLINE);

    try {
        const response = await fetch("/api/request", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                company: bookingWebsite ? bookingWebsite.value : "",
                service: booking.service,
                name: booking.name,
                phone: booking.phone,
                email: booking.email,
                address: booking.address,
                pickupAddress: booking.pickupAddress,
                dropoffAddress: booking.dropoffAddress,
                quoteId: booking.quoteId,
                quotedPrice: booking.quotedPrice,
                distanceKm: booking.distanceKm,
                durationSeconds: booking.durationSeconds,
                size: booking.size,
                date: booking.date,
                time: booking.time,
                notes: booking.notes
            }),
            signal: controller.signal
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || data.ok !== true) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }

        return true;
    } catch (error) {
        if (error && error.name === "AbortError") {
            console.warn("Request send hit the client deadline.");
        } else {
            console.warn("Request send failed:", error);
        }
        return false;
    } finally {
        clearTimeout(deadline);
    }
}

document.getElementById("confirm-booking").addEventListener("click", async () => {
    let booking;

    try {
        booking = createBooking({
            service: selectedService,
            name: customerName.value.trim(),
            phone: customerPhone.value.trim(),
            pickupAddress: customerAddress.value.trim(),
            dropoffAddress: customerDropoff.value.trim(),
            email: customerEmail.value.trim(),
            size: customerSize.value,
            notes: bookingNotes.value.trim(),
            date: bookingDate.value,
            time: bookingTime.value,
            quoteId: routeQuote?.quoteId,
            quotedPrice: routeQuote?.price,
            distanceKm: routeQuote?.distanceKm,
            durationSeconds: routeQuote?.durationSeconds
        });
    } catch (error) {
        sound.cues.error();
        speak(error.message);
        return;
    }

    /* One job at a time: a double click would send the same request twice. */
    const confirmButton = document.getElementById("confirm-booking");
    if (confirmButton.disabled) return;
    confirmButton.disabled = true;
    confirmButton.textContent = "LÄHETETÄÄN...";
    microphoneStatus.textContent = "Lähetetään pyyntöä...";
    microphoneStatus.classList.remove("is-ai");
    robot.setState(ROBOT_STATE.THINKING);

    const sent = await sendRequest(booking);

    confirmButton.disabled = false;
    confirmButton.textContent = "VAHVISTA VARAUS";

    if (!sent) {
        /* Nothing reached the company, so nothing may stay held: drop the
           local record, free the slot again and let the visitor retry. */
        cancelBooking(booking.id);
        bookingTime.value = "";
        updateTimes();

        sound.cues.error();
        microphoneStatus.textContent = "Pyyntö ei lähtenyyt. Yritä uudelleen tai soita meille.";
        speak("Pyyntö ei lähtenyyt. Tarkista yhteys ja yritä uudelleen, tai soita meille suoraan.");
        return;
    }

    const dateText = new Date(booking.date + "T00:00:00").toLocaleDateString("fi-FI");

    confirmationText.textContent =
        `${booking.service} lähtee osoitteesta ${booking.pickupAddress} ja saapuu osoitteeseen ${booking.dropoffAddress}. `
        + `Reitti ${booking.distanceKm ? `${String(booking.distanceKm).replace(".", ",")} km` : ""} · ${booking.quotedPrice}. `
        + `Nouto ${dateText} kello ${booking.time}. Otamme yhteyttä numeroon ${booking.phone} vahvistaaksemme kuljetuksen.`;

    confirmation.classList.remove("hidden");

    /* The card sits at the top of the workspace, above the form that was
       just submitted, so the feed jumps back to it. */
    scrollFeed({ force: true, align: "top" });

    /* The slot just taken must disappear from the list, otherwise it
       stays selectable until the date field is touched again. */
    bookingTime.value = "";
    updateTimes();

    microphoneStatus.textContent = "Pyyntö lähetetty yritykselle.";
    microphoneStatus.classList.add("is-ai");
    robot.playHappy();
    sound.cues.success();
    speak(`Kuljetuspyyntö on lähetetty: ${booking.service}, ${dateText} kello ${booking.time}. Vahvistamme reitin ja hinnan puhelimitse!`);
});

/* =========================================================
   CLOSE CONFIRMATION (back to the visible service list)
   ========================================================= */

document.getElementById("close-confirmation").addEventListener("click", () => {
    confirmation.classList.add("hidden");
    setWizardStep(1);

    selectedService = null;
    bookingService.value = "";
    customerName.value = "";
    customerPhone.value = "";
    customerAddress.value = "";
    customerDropoff.value = "";
    customerEmail.value = "";
    bookingNotes.value = "";
    if (bookingWebsite) bookingWebsite.value = "";
    bookingTime.value = "";
    invalidateRouteQuote();

    highlightService(null);
});

/* =========================================================
   STARTUP
   ========================================================= */

updateTimes();
