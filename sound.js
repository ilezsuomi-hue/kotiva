/* =========================================================
   PUHTOLA SOUND ENGINE
   Procedural sci-fi UI sounds generated with the Web Audio
   API, so the app ships with zero audio files.

   Everything is routed through one master chain:

       voices ──┬─► master ──► limiter ──► air ──► out
                └─► reverb send ──► reverb ──┘

   The reverb impulse is generated too (exponentially decaying,
   decorrelated noise), which is what stops the cues sounding
   like a dry test tone. The limiter and the gentle high shelf
   keep the whole mix soft instead of harsh.

   AudioContext may only start after a user gesture, so the
   app calls unlock() from the greeting tap / first touch.

   Export: createSound()
   ========================================================= */

export function createSound() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const MASTER_LEVEL = 0.55;
    const REVERBENT_LEVEL = 0.26;

    let ctx = null;
    let master = null;
    let limiter = null;
    let air = null;
    let reverb = null;
    let reverbSend = null;
    let muted = readMuted();
    let hum = null;

    /* localStorage throws in sandboxed frames / strict privacy modes. */
    function readMuted() {
        try {
            return localStorage.getItem("puhtola-muted") === "1";
        } catch (error) {
            return false;
        }
    }

    function writeMuted(value) {
        try {
            localStorage.setItem("puhtola-muted", value ? "1" : "0");
        } catch (error) {
            /* Not fatal - the preference simply will not persist. */
        }
    }

    /* =========================================================
       ROOM TONE

       A short pre-delay then decorrelated noise under an
       exponential decay, low-passed a little more with every
       pass so the tail darkens the way a real room does.
       ========================================================= */
    function makeImpulse(seconds, decay) {
        const rate = ctx.sampleRate;
        const length = Math.max(1, Math.floor(rate * seconds));
        const preDelay = Math.floor(rate * 0.012);
        const impulse = ctx.createBuffer(2, length, rate);

        for (let channel = 0; channel < 2; channel += 1) {
            const data = impulse.getChannelData(channel);
            let lowpass = 0;

            for (let i = 0; i < length; i += 1) {
                if (i < preDelay) {
                    data[i] = 0;
                    continue;
                }
                const progress = (i - preDelay) / (length - preDelay);
                const noise = Math.random() * 2 - 1;
                /* One-pole average = the tail loses its top end. */
                lowpass += (noise - lowpass) * (0.35 - progress * 0.22);
                data[i] = lowpass * Math.pow(1 - progress, decay);
            }
        }
        return impulse;
    }

    function ensureContext() {
        if (!Ctx) return false;

        if (!ctx) {
            ctx = new Ctx();

            /* Gentle glue: nothing ever clips, nothing pumps. */
            limiter = ctx.createDynamicsCompressor();
            limiter.threshold.value = -18;
            limiter.knee.value = 12;
            limiter.ratio.value = 6;
            limiter.attack.value = 0.006;
            limiter.release.value = 0.28;

            /* Takes the digital edge off without dulling the cues. */
            air = ctx.createBiquadFilter();
            air.type = "lowpass";
            air.frequency.value = 11000;
            air.Q.value = 0.6;

            master = ctx.createGain();
            master.gain.value = muted ? 0 : MASTER_LEVEL;

            reverb = ctx.createConvolver();
            reverb.buffer = makeImpulse(1.5, 2.4);

            reverbSend = ctx.createGain();
            reverbSend.gain.value = REVERBENT_LEVEL;

            master.connect(limiter);
            reverb.connect(reverbSend);
            reverbSend.connect(limiter);
            limiter.connect(air);
            air.connect(ctx.destination);
        }

        /* Browsers can hand back a suspended context even after a gesture. */
        if (ctx.state === "suspended" && ctx.resume) {
            ctx.resume().catch(() => {});
        }

        return true;
    }

    /* Every voice feeds the dry bus and a little of the room. */
    function route(env, wet = 0.5) {
        env.connect(master);
        if (wet > 0) {
            const send = ctx.createGain();
            send.gain.value = wet;
            env.connect(send);
            send.connect(reverb);
        }
    }

    /* Safe one-shot tone with an optional pitch slide. */
    function tone({
        freq = 440,
        endFreq = null,
        dur = 0.12,
        type = "sine",
        gain = 0.2,
        delay = 0,
        attack = 0.02,
        wet = 0.5
    }) {
        if (!ensureContext() || muted) return;

        const t0 = ctx.currentTime + delay;

        const osc = ctx.createOscillator();
        osc.type = type;
        /* Frequency must stay positive for exponential ramps. */
        osc.frequency.setValueAtTime(Math.max(20, freq), t0);

        if (endFreq) {
            osc.frequency.exponentialRampToValueAtTime(
                Math.max(20, endFreq), t0 + dur
            );
        }

        /*
         * Exponential ramps cannot start from or land on 0, so the peak is
         * clamped to the smallest usable value and the attack is kept inside
         * the note so the two ramps never overlap. The slow default attack is
         * what stops a cue sounding like a click.
         */
        const peak = Math.max(0.0001, gain);
        const rise = Math.min(Math.max(attack, 0.001), dur * 0.5);

        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.exponentialRampToValueAtTime(peak, t0 + rise);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

        osc.connect(env);
        route(env, wet);

        /* Release the graph once the tail has run out. */
        osc.onended = () => {
            osc.disconnect();
            env.disconnect();
        };

        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
    }

    /* Filtered noise burst - servo motors, whooshes, clicks. */
    function noise({
        dur = 0.18,
        gain = 0.12,
        freq = 900,
        q = 1.2,
        type = "bandpass",
        delay = 0,
        attack = 0.02,
        wet = 0.6
    }) {
        if (!ensureContext() || muted) return;

        const t0 = ctx.currentTime + delay;
        const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
        const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < frames; i += 1) {
            /* Smooth the burst in and out so it never ticks. */
            const fade = Math.sin(Math.PI * (i / frames));
            data[i] = (Math.random() * 2 - 1) * fade * fade;
        }

        const src = ctx.createBufferSource();
        src.buffer = buffer;

        const filter = ctx.createBiquadFilter();
        filter.type = type;
        filter.frequency.value = freq;
        filter.Q.value = q;

        const env = ctx.createGain();
        /* A gain of 0 would break the exponential decay below. */
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + Math.min(attack, dur * 0.5));
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

        src.connect(filter);
        filter.connect(env);
        route(env, wet);

        /*
         * The buffer is only `dur` long, so the source ends on its own a beat
         * before the scheduled stop(); either way the whole chain is dropped
         * here so repeated clicks do not pile up nodes on the master bus.
         */
        src.onended = () => {
            src.disconnect();
            filter.disconnect();
            env.disconnect();
        };

        src.start(t0);
        src.stop(t0 + dur + 0.02);
    }

/* =========================================================
       AMBIENT DRONE
       A detuned low oscillator pair behind a lowpass with a very slow LFO on
       its level, so Puhto always sounds "powered up". It runs through master,
       which means the mute button silences it without tearing the graph down.
       It skips the reverb on purpose: a sustained bed in a small room turns
       to mud, and the point is that you feel it, not hear it.
       ========================================================== */

    function startHum() {
        if (!ensureContext() || hum) return;

        const drone = ctx.createGain();
        drone.gain.value = 0.028;

        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 150;
        lp.Q.value = 0.7;

        /* A second lowpass rolls off the saw's edge so the bed stays soft. */
        const soften = ctx.createBiquadFilter();
        soften.type = "lowpass";
        soften.frequency.value = 420;

        const oscA = ctx.createOscillator();
        oscA.type = "sawtooth";
        oscA.frequency.value = 55;

        const oscB = ctx.createOscillator();
        oscB.type = "sine";
        oscB.frequency.value = 82.5;

        /* Breathing LFO - modulation depth, not an audible voice. */
        const lfo = ctx.createOscillator();
        lfo.type = "sine";
        lfo.frequency.value = 0.12;

        const lfoDepth = ctx.createGain();
        lfoDepth.gain.value = 0.012;

        lfo.connect(lfoDepth);
        lfoDepth.connect(drone.gain);

        oscA.connect(soften);
        oscB.connect(soften);
        soften.connect(lp);
        lp.connect(drone);
        drone.connect(master);

        oscA.start();
        oscB.start();
        lfo.start();

        hum = { drone, lfoDepth, nodes: [oscA, oscB, lfo] };
    }

    function stopHum() {
        if (!hum) return;

        const drone = hum.drone;
        const lfoDepth = hum.lfoDepth;
        const nodes = hum.nodes;
        hum = null;

        const t0 = ctx.currentTime;
        const fade = 0.3;

        /* Park the LFO first so nothing is left offset when the drone dies. */
        lfoDepth.gain.cancelScheduledValues(t0);
        lfoDepth.gain.setValueAtTime(Math.max(0.0001, lfoDepth.gain.value), t0);
        lfoDepth.gain.exponentialRampToValueAtTime(0.0001, t0 + fade * 0.5);

        drone.gain.cancelScheduledValues(t0);
        drone.gain.setValueAtTime(Math.max(0.0001, drone.gain.value), t0);
        drone.gain.exponentialRampToValueAtTime(0.0001, t0 + fade);

        nodes.forEach((node) => node.stop(t0 + fade + 0.05));

        window.setTimeout(() => {
            nodes.forEach((node) => node.disconnect());
            lfoDepth.disconnect();
            drone.disconnect();
        }, (fade + 0.3) * 1000);
    }


    /* =========================================================
       MUTE + UNLOCK
       unlock() has to be called from inside a real user gesture
       (the greeting tap / first touch) before any cue will play.
    ========================================================== */

    function setMuted(next) {
        muted = Boolean(next);
        writeMuted(muted);

        if (ctx && master) {
            const t0 = ctx.currentTime;

            /* A short ramp avoids the click of jumping the gain instantly. */
            master.gain.cancelScheduledValues(t0);
            master.gain.setValueAtTime(master.gain.value, t0);
            master.gain.linearRampToValueAtTime(muted ? 0 : MASTER_LEVEL, t0 + 0.08);
        }

        return muted;
    }

    function unlock() {
        if (!ensureContext()) return false;
        return ctx.state !== "suspended";
    }

/* =========================================================
       UI CUES

       Soft by design: no square waves, quiet passes, long-enough
       attacks, and a light hand on the reverb send so nothing turns
       into a clatter.
       ========================================================== */

    const cues = {
        /* UI tick for buttons, chips and toggles. */
        click() {
            tone({ freq: 1180, endFreq: 880, dur: 0.07, type: "sine", gain: 0.17, attack: 0.008, wet: 0.3 });
            noise({ dur: 0.05, gain: 0.035, freq: 2600, q: 0.7, type: "highpass", attack: 0.01, wet: 0.3 });
        },

        /* Barely-there blip on hover / focus. */
        hover() {
            tone({ freq: 900, dur: 0.05, type: "sine", gain: 0.05, attack: 0.015, wet: 0.35 });
        },

        /* Servo sweep for panels sliding open or shut. */
        servo() {
            noise({ dur: 0.28, gain: 0.085, freq: 1200, q: 1.1, attack: 0.06, wet: 0.6 });
            tone({ freq: 240, endFreq: 460, dur: 0.26, type: "triangle", gain: 0.06, attack: 0.05, wet: 0.5 });
        },

        /* Rising two-note affirmation for an accepted action. */
        confirm() {
            tone({ freq: 660, dur: 0.12, type: "sine", gain: 0.19, attack: 0.03, wet: 0.55 });
            tone({ freq: 990, dur: 0.22, type: "sine", gain: 0.15, delay: 0.1, attack: 0.04, wet: 0.65 });
        },

        /* Bright arpeggio for a completed booking. */
        success() {
            [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
                tone({ freq, dur: 0.4, type: "sine", gain: 0.15, delay: i * 0.09, attack: 0.04, wet: 0.7 });
            });
        },

        /* Low descending sigh for a validation failure. */
        error() {
            tone({ freq: 300, endFreq: 190, dur: 0.34, type: "triangle", gain: 0.1, attack: 0.03, wet: 0.4 });
            noise({ dur: 0.18, gain: 0.035, freq: 380, q: 0.7, type: "lowpass", delay: 0.02, attack: 0.04, wet: 0.4 });
        },

        /* Power-up whoosh for boot / wake. */
        boot() {
            noise({ dur: 0.75, gain: 0.07, freq: 1400, q: 0.5, attack: 0.18, wet: 0.8 });
            tone({ freq: 110, endFreq: 520, dur: 0.75, type: "sine", gain: 0.1, attack: 0.12, wet: 0.6 });
            tone({ freq: 880, dur: 0.26, type: "sine", gain: 0.09, delay: 0.7, attack: 0.06, wet: 0.75 });
        },

        /* Rising breath when the microphone opens. */
        listen() {
            tone({ freq: 520, endFreq: 1040, dur: 0.18, type: "sine", gain: 0.13, attack: 0.04, wet: 0.45 });
        },

        /* Falling breath when the microphone closes. */
        listenEnd() {
            tone({ freq: 1040, endFreq: 480, dur: 0.18, type: "sine", gain: 0.11, attack: 0.04, wet: 0.45 });
        }
    };

    /* Tear everything down - used on page unload / hot reload. */
    function dispose() {
        stopHum();

        if (ctx && ctx.close) ctx.close().catch(() => {});
        ctx = null;
        master = null;
        limiter = null;
        air = null;
        reverb = null;
        reverbSend = null;
    }

    return {
        unlock,
        dispose,
        startHum,
        stopHum,
        isMuted: () => muted,
        setMuted,
        toggleMute: () => setMuted(!muted),
        cues,
        /* Low-level builders, exposed for one-off sounds. */
        tone,
        noise
    };
}

