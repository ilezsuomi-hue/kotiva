/* =========================================================
   KOTIVA ORDER RULES

   A small local order ledger keeps time windows from being double-booked
   during the prototype phase. The server remains the source of truth for
   submitted requests.
   ========================================================= */

export const SERVICES = {
    "Pikatoimitus": { price: "Alkaen 9 €", duration: 60 },
    "Pakettikuljetus": { price: "Alkaen 12 €", duration: 90 },
    "Kauppakyyti": { price: "Alkaen 15 €", duration: 90 },
    "Yrityskuljetus": { price: "Sopimushinta", duration: 120 }
};

/* Dynamic delivery pricing: the base covers the first 2 km, then the
   route adds a service-specific whole-euro amount per started kilometre. */
export const DELIVERY_PRICING = {
    "Pikatoimitus": { base: 9, includedKm: 2, perKm: 2.2 },
    "Pakettikuljetus": { base: 12, includedKm: 2, perKm: 1.6 },
    "Kauppakyyti": { base: 15, includedKm: 2, perKm: 1.8 },
    "Yrityskuljetus": { base: 20, includedKm: 2, perKm: 1.4 }
};

export function calculateDeliveryPrice(service, distanceMeters) {
    const rule = DELIVERY_PRICING[service];
    const meters = Number(distanceMeters);
    if (!rule || !Number.isFinite(meters) || meters <= 0) return null;

    const distanceKm = meters / 1000;
    const extraKm = Math.max(0, distanceKm - rule.includedKm);
    const euros = Math.max(rule.base, Math.ceil(rule.base + extraKm * rule.perKm));
    return {
        euros,
        label: `${euros} €`,
        distanceKm: Math.round(distanceKm * 10) / 10
    };
}

export const BUSINESS_HOURS = [
    "08:00", "09:00", "10:00", "11:00", "12:00",
    "13:00", "14:00", "15:00", "16:00", "17:00"
];

const STORAGE_KEY = "kotiva_bookings";
const LEGACY_STORAGE_KEY = "puhtola_bookings";

function readStorage(key) {
    try {
        const stored = localStorage.getItem(key);
        if (!stored) return [];
        const parsed = JSON.parse(stored);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error("Could not read order ledger:", error);
        return [];
    }
}

export function getBookings() {
    const current = readStorage(STORAGE_KEY);
    if (current.length) return current;
    /* Keep existing prototype time holds from blocking a fresh migration. */
    return readStorage(LEGACY_STORAGE_KEY);
}

export function saveBooking(booking) {
    const bookings = [...readStorage(STORAGE_KEY), booking];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bookings));
}

export function cancelBooking(id) {
    const bookings = readStorage(STORAGE_KEY).filter((booking) => booking.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bookings));
    return bookings;
}

export function isSlotAvailable(date, time) {
    return !getBookings().some((booking) => booking.date === date && booking.time === time);
}

export function getAvailableSlots(date) {
    return BUSINESS_HOURS.filter((time) => isSlotAvailable(date, time));
}

export function getService(service) {
    return Object.prototype.hasOwnProperty.call(SERVICES, service) ? SERVICES[service] : null;
}

export function createBooking({
    service,
    name,
    phone,
    pickupAddress,
    dropoffAddress,
    email,
    size,
    notes,
    date,
    time,
    quoteId,
    quotedPrice,
    distanceKm,
    durationSeconds
}) {
    if (!getService(service)) throw new Error("Valitse ensin kuljetuspalvelu.");
    if (!name || name.trim().length < 2) throw new Error("Syötä koko nimesi.");

    const phoneDigits = String(phone || "").replace(/[^\d]/g, "");
    if (!phone) throw new Error("Syötä puhelinnumerosi.");
    if (phoneDigits.length < 6) throw new Error("Syötä kelvollinen puhelinnumero.");
    if (!pickupAddress || pickupAddress.trim().length < 4) throw new Error("Syötä nouto-osoite.");
    if (!dropoffAddress || dropoffAddress.trim().length < 4) throw new Error("Syötä toimitusosoite.");

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
        throw new Error("Syötä kelvollinen sähköpostiosoite tai jätä kenttä tyhjäksi.");
    }
    if (!date) throw new Error("Valitse päivämäärä.");
    if (!time) throw new Error("Valitse aikaikkuna.");

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (new Date(`${date}T00:00:00`) < today) throw new Error("Valitse tämä päivä tai tuleva päivämäärä.");
    if (!BUSINESS_HOURS.includes(time)) throw new Error("Valittu aika ei ole käytettävissä.");
    if (!isSlotAvailable(date, time)) throw new Error("Tämä aikaikkuna on jo varattu.");

    const id = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Date.now().toString();
    const booking = {
        id,
        service,
        name: name.trim(),
        phone: phone.trim(),
        pickupAddress: pickupAddress.trim(),
        dropoffAddress: dropoffAddress.trim(),
        /* address stays as a compatibility alias for older inbox tooling. */
        address: pickupAddress.trim(),
        email: (email || "").trim(),
        size: size || "Ei ilmoitettu",
        notes: (notes || "").trim(),
        date,
        time,
        quoteId: quoteId || "",
        quotedPrice: quotedPrice || getService(service).price,
        distanceKm: Number(distanceKm) || null,
        durationSeconds: Number(durationSeconds) || null,
        price: quotedPrice || getService(service).price,
        createdAt: new Date().toISOString()
    };

    saveBooking(booking);
    return booking;
}
