/* =========================================================
   PUHTO - ARTICULATED ASSISTANT DROID
   =========================================================

   A fully jointed robot built procedurally from primitives so
   the app needs no external model files.

   Joint hierarchy (this is what makes the animation real):

   root
     bob           hover float
       body        lean / sway
         pelvis
         waist     torso twist
           chest + core + gimbal rings + panel equaliser
           backpack + thrusters
           shoulderL/R -> elbowL/R -> wristL/R -> hand
         neck
           headPitch -> headYaw -> visor, eyes, mouth, ears, antenna
         hipL/R -> kneeL/R -> ankleL/R -> foot

   Puhto's feet sit at y = 0, the head top is ~2.5 and the
   antenna tip ~2.9 world units.
   ========================================================= */

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;
const lerp = THREE.MathUtils.lerp;

/* =========================================================
   STATES + MOOD COLOURS
========================================================= */

export const ROBOT_STATE = {
    IDLE: "idle",
    LISTENING: "listening",
    THINKING: "thinking",
    TALKING: "talking",
    WAVING: "waving",
    HAPPY: "happy",
    WALKING: "walking"
};

const GLOW_COLOR = {
    idle: 0x5ca88c,
    listening: 0x8bcdb5,
    thinking: 0xd4aa69,
    talking: 0x6fb8a3,
    waving: 0x6da6b4,
    happy: 0xa6d29e,
    walking: 0x6fa493
};

/* =========================================================
   PER-FRAME TABLES

   The animation loop runs 60 times a second, so its lookup tables
   and pose scratch objects live at module level: building them
   per frame would hand the garbage collector ~6 short-lived objects
   every 16ms for the whole life of the page.
   ========================================================= */

const EMISSIVE_BY_STATE = {
    idle: 0.85,
    listening: 1.1,
    thinking: 0.75,
    talking: 1.0,
    waving: 0.95,
    happy: 1.15,
    walking: 0.9
};

const EAR_SPEED_BY_STATE = {
    idle: 0.4,
    listening: 3.5,
    thinking: 7,
    talking: 1.6,
    waving: 1.6,
    happy: 4,
    walking: 1
};

/* Pose scratch: reset every frame, filled by the state flavour, then
   damped onto the real joints. Reused for the life of the robot. */
const POSE = {
    arm: [
        { x: 0, y: 0, z: 0, e: 0, f: 0 },
        { x: 0, y: 0, z: 0, e: 0, f: 0 }
    ],
    leg: [
        { h: 0, k: 0, a: 0 },
        { h: 0, k: 0, a: 0 }
    ],
    side: [-1, 1]
};

/* =========================================================
   HELPERS
========================================================= */

/* Soft round box - the workhorse shell shape. */
function shell(w, h, d, r = 0.06, seg = 4) {
    const max = Math.min(w, h, d) / 2 - 0.001;
    return new RoundedBoxGeometry(w, h, d, seg, Math.min(r, max));
}

function part(geometry, material, x = 0, y = 0, z = 0) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    return mesh;
}

function group(x = 0, y = 0, z = 0) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    return g;
}

/* Radial falloff sprite used for every light bloom. */
function glowTexture() {
    if (glowTexture.cached) return glowTexture.cached;

    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;

    const ctx = canvas.getContext("2d");
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.25, "rgba(255,255,255,.5)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    glowTexture.cached = texture;
    return texture;
}

function halo(size, opacity = 0.3) {
    const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
            map: glowTexture(),
            color: 0xffffff,
            transparent: true,
            opacity,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: true
        })
    );
    sprite.scale.setScalar(size);
    return sprite;
}

/* =========================================================
   MATERIALS
========================================================= */

function createMaterials() {
    const accent = new THREE.Color(GLOW_COLOR.idle);

    const emissive = (intensity) => ({
        color: 0x0b2026,
        emissive: accent.clone(),
        emissiveIntensity: intensity,
        metalness: 0,
        roughness: 0.35
    });

    return {
        /* Matte porcelain shell: clean, calm and easy to trust. */
        shell: new THREE.MeshPhysicalMaterial({
            color: 0xf4f7f3,
            metalness: 0.04,
            roughness: 0.58,
            clearcoat: 0.12,
            clearcoatRoughness: 0.48,
            envMapIntensity: 0.55
        }),

        /* Forest composite used for seams, soles and practical structure. */
        composite: new THREE.MeshPhysicalMaterial({
            color: 0x21434a,
            metalness: 0.18,
            roughness: 0.62,
            clearcoat: 0.08,
            envMapIntensity: 0.55
        }),

        /* Soft brushed hardware, no futuristic chrome shine. */
        metal: new THREE.MeshStandardMaterial({
            color: 0xa7b8b7,
            metalness: 0.72,
            roughness: 0.46,
            envMapIntensity: 0.65
        }),

        brushed: new THREE.MeshStandardMaterial({
            color: 0x5f7d82,
            metalness: 0.34,
            roughness: 0.64,
            envMapIntensity: 0.55
        }),

        rubber: new THREE.MeshStandardMaterial({
            color: 0x17272c,
            metalness: 0.06,
            roughness: 0.9
        }),

        /* Muted forest visor glass. */
        glass: new THREE.MeshPhysicalMaterial({
            color: 0x183b43,
            metalness: 0.12,
            roughness: 0.18,
            clearcoat: 0.22,
            clearcoatRoughness: 0.22,
            transparent: true,
            opacity: 0.94,
            envMapIntensity: 0.8
        }),

        /* Cleaner uniform and service details. */
        apron: new THREE.MeshStandardMaterial({
            color: 0x82bda8,
            metalness: 0.02,
            roughness: 0.78,
            envMapIntensity: 0.4
        }),
        apronLight: new THREE.MeshStandardMaterial({
            color: 0xdcebe5,
            metalness: 0.02,
            roughness: 0.82,
            envMapIntensity: 0.42
        }),
        badge: new THREE.MeshStandardMaterial({
            color: 0x398573,
            metalness: 0.08,
            roughness: 0.52,
            envMapIntensity: 0.48
        }),

        /* Small, restrained service-status glow. */
        glow: new THREE.MeshStandardMaterial(emissive(0.56)),
        glowDim: new THREE.MeshStandardMaterial(emissive(0.26)),
        core: new THREE.MeshStandardMaterial({
            ...emissive(0.72),
            roughness: 0.34
        })
    };
}

/* =========================================================
   HALO REGISTRY
   All additive sprites live in one list so the mood colour
   and the pulse animation can drive them together.
========================================================= */

function registerHalo(parts, sprite, weight = 1) {
    if (!parts.halos) parts.halos = [];
    parts.halos.push({
        sprite,
        weight,
        baseSize: sprite.scale.x,
        baseOpacity: sprite.material.opacity
    });
    return sprite;
}

/* =========================================================
   TORSO (pelvis, waist, chest, reactor core, backpack)
========================================================= */

function buildTorso(mat, parts) {
    const { body } = parts;

    /* --- Pelvis ------------------------------------------------ */
    const pelvis = part(shell(0.62, 0.30, 0.44, 0.11), mat.shell, 0, 1.02, 0);
    body.add(pelvis);
    body.add(part(shell(0.66, 0.10, 0.47, 0.05), mat.composite, 0, 1.13, 0));

    [-1, 1].forEach((s) => {
        const hipBall = part(new THREE.SphereGeometry(0.115, 20, 14), mat.metal, s * 0.22, 0.94, 0);
        body.add(hipBall);
    });

    /* --- Waist (torso twist pivot) ----------------------------- */
    const waist = group(0, 1.16, 0);
    body.add(waist);
    waist.add(part(new THREE.CylinderGeometry(0.19, 0.21, 0.18, 20), mat.brushed, 0, 0.03, 0));

    const chest = group(0, 0, 0);
    waist.add(chest);

    /* --- Chest armour ------------------------------------------ */
    chest.add(part(shell(0.88, 0.70, 0.56, 0.18), mat.shell, 0, 0.42, 0));
    chest.add(part(shell(0.98, 0.18, 0.52, 0.08), mat.shell, 0, 0.70, 0));
    chest.add(part(shell(0.90, 0.05, 0.58, 0.02), mat.composite, 0, 0.20, 0));
    chest.add(part(new THREE.CylinderGeometry(0.15, 0.17, 0.12, 20), mat.composite, 0, 0.78, 0));

    /* Side intake vents. */
    [-1, 1].forEach((s) => {
        for (let i = 0; i < 3; i += 1) {
            const slat = part(shell(0.02, 0.035, 0.24, 0.012), mat.composite, s * 0.40, 0.50 - i * 0.07, 0.06);
            slat.rotation.z = s * 0.18;
            chest.add(slat);
        }
    });

    /* --- Cleaner apron, service pocket + equaliser -------------- */
    const apronBib = part(shell(0.56, 0.34, 0.045, 0.06), mat.apron, 0, 0.28, 0.30);
    chest.add(apronBib);

    [-1, 1].forEach((s) => {
        const strap = part(shell(0.055, 0.34, 0.035, 0.018), mat.apronLight, s * 0.19, 0.46, 0.315);
        strap.rotation.z = s * 0.16;
        chest.add(strap);
    });

    const utilityPocket = part(shell(0.30, 0.13, 0.035, 0.025), mat.apronLight, 0, 0.16, 0.335);
    chest.add(utilityPocket);

    const serviceBadge = part(new THREE.CylinderGeometry(0.065, 0.065, 0.026, 24), mat.badge, 0, 0.36, 0.34);
    serviceBadge.rotation.x = Math.PI / 2;
    chest.add(serviceBadge);

    const badgeLeaf = part(new THREE.SphereGeometry(0.028, 12, 8), mat.apronLight, 0.015, 0.36, 0.36);
    badgeLeaf.scale.set(1.8, 0.55, 0.28);
    badgeLeaf.rotation.z = -0.45;
    chest.add(badgeLeaf);

    const eqBars = [];
    for (let i = 0; i < 7; i += 1) {
        const bar = part(shell(0.045, 0.20, 0.02, 0.018), mat.glow, (i - 3) * 0.062, 0.30, 0.305);
        bar.scale.y = 0.3;
        chest.add(bar);
        eqBars.push(bar);
    }
    parts.eqBars = eqBars;

    /* --- Reactor core with gimbal rings ------------------------ */
    const coreGroup = group(0, 0.58, 0.22);
    chest.add(coreGroup);

    coreGroup.add(part(new THREE.SphereGeometry(0.15, 28, 20), mat.glass, 0, 0, 0));

    const coreMesh = part(new THREE.SphereGeometry(0.075, 24, 18), mat.core, 0, 0, 0);
    coreGroup.add(coreMesh);
    parts.coreMesh = coreMesh;

    const ringA = part(new THREE.TorusGeometry(0.16, 0.012, 8, 40), mat.metal, 0, 0, 0);
    const ringB = part(new THREE.TorusGeometry(0.135, 0.010, 8, 40), mat.brushed, 0, 0, 0);
    ringB.rotation.x = Math.PI / 2.4;
    coreGroup.add(ringA, ringB);
    parts.coreRings = [ringA, ringB];

    const coreGlowSprite = halo(0.85, 0.25);
    coreGlowSprite.material.color.copy(mat.core.emissive);
    coreGroup.add(coreGlowSprite);
    registerHalo(parts, coreGlowSprite, 1);

    /* --- Backpack + thrusters ---------------------------------- */
    const backpack = group(0, 0.42, -0.34);
    chest.add(backpack);
    backpack.add(part(shell(0.60, 0.54, 0.26, 0.10), mat.composite, 0, 0, 0));
    backpack.add(part(shell(0.46, 0.30, 0.05, 0.04), mat.brushed, 0, 0.04, -0.14));

    const thrusters = [];
    [-1, 1].forEach((s) => {
        const nozzle = part(new THREE.CylinderGeometry(0.075, 0.055, 0.16, 18), mat.brushed, s * 0.19, 0.16, -0.19);
        nozzle.rotation.x = Math.PI / 2;
        backpack.add(nozzle);

        const plume = part(new THREE.CircleGeometry(0.05, 18), mat.glow, s * 0.19, 0.16, -0.28);
        backpack.add(plume);
        thrusters.push(plume);

        const glowSprite = halo(0.42, 0.16);
        glowSprite.material.color.copy(mat.core.emissive);
        glowSprite.position.set(s * 0.19, 0.16, -0.32);
        backpack.add(glowSprite);
        registerHalo(parts, glowSprite, 0.6);
        thrusters.push(glowSprite);
    });
    parts.thrusters = thrusters;

    /* --- Shoulders --------------------------------------------- */
    parts.waist = waist;
    parts.chest = chest;

    [-1, 1].forEach((s) => {
        const shoulder = group(s * 0.50, 0.66, 0);
        chest.add(shoulder);
        buildArm(mat, parts, shoulder, s);
    });
}

/* =========================================================
   ARM (shoulder -> elbow -> wrist -> hand)
   s = -1 for the left arm, +1 for the right arm
========================================================= */

function buildArm(mat, parts, shoulder, s) {
    /* Pauldron + shoulder servo. */
    shoulder.add(part(shell(0.28, 0.26, 0.34, 0.11), mat.shell, s * 0.045, 0.03, 0));
    shoulder.add(part(new THREE.SphereGeometry(0.115, 20, 14), mat.metal, 0, -0.05, 0));

    /* Glow ring around the upper arm. */
    const shoulderRing = part(new THREE.TorusGeometry(0.095, 0.014, 8, 28), mat.glowDim, 0, -0.155, 0);
    shoulderRing.rotation.x = Math.PI / 2;
    shoulder.add(shoulderRing);

    /* Upper arm. */
    shoulder.add(part(new THREE.CapsuleGeometry(0.085, 0.19, 6, 16), mat.composite, 0, -0.24, 0));

    /* --- Elbow ------------------------------------------------- */
    const elbow = group(0, -0.40, 0);
    shoulder.add(elbow);

    const hinge = part(new THREE.CylinderGeometry(0.09, 0.09, 0.19, 18), mat.metal, 0, 0, 0);
    hinge.rotation.z = Math.PI / 2;
    elbow.add(hinge);

    const elbowRing = part(new THREE.TorusGeometry(0.085, 0.012, 8, 26), mat.glowDim, 0, -0.075, 0);
    elbowRing.rotation.x = Math.PI / 2;
    elbow.add(elbowRing);

    /* Forearm. */
    elbow.add(part(new THREE.CapsuleGeometry(0.078, 0.16, 6, 16), mat.shell, 0, -0.17, 0));
    elbow.add(part(shell(0.10, 0.16, 0.03, 0.015), mat.composite, s * 0.07, -0.17, 0));

    /* Status light on the forearm. */
    const armLight = part(new THREE.CircleGeometry(0.028, 16), mat.glow, s * 0.085, -0.12, 0);
    armLight.rotation.y = s * Math.PI / 2;
    elbow.add(armLight);

    /* Wrist. */
    const wrist = group(0, -0.32, 0);
    elbow.add(wrist);
    wrist.add(part(new THREE.CylinderGeometry(0.07, 0.07, 0.07, 16), mat.metal, 0, 0.02, 0));

    /* --- Hand (palm + 3 fingers + thumb) ----------------------- */
    const hand = group(0, 0, 0);
    wrist.add(hand);
    hand.add(part(shell(0.145, 0.17, 0.09, 0.035), mat.shell, 0, -0.07, 0));
    hand.add(part(shell(0.15, 0.03, 0.095, 0.015), mat.composite, 0, -0.02, 0));

    const fingers = [];
    [-0.046, 0, 0.046].forEach((x) => {
        const finger = group(x, -0.15, 0);
        finger.add(part(shell(0.034, 0.10, 0.05, 0.015), mat.shell, 0, -0.05, 0));
        finger.add(part(shell(0.032, 0.04, 0.048, 0.014), mat.composite, 0, -0.115, 0));
        hand.add(finger);
        fingers.push(finger);
    });

    const thumb = group(-s * 0.075, -0.06, 0.02);
    thumb.rotation.z = s * 0.55;
    thumb.add(part(shell(0.036, 0.08, 0.05, 0.016), mat.shell, 0, -0.04, 0));
    hand.add(thumb);
    fingers.push(thumb);

    parts.arm ??= {};
    parts.arm[s] = { shoulder, elbow, wrist, hand, fingers };
}

/* =========================================================
   LEG (hip -> knee -> ankle -> foot)
========================================================= */

function buildLeg(mat, parts, hip, s) {
    hip.add(part(new THREE.CylinderGeometry(0.11, 0.11, 0.16, 18), mat.metal, 0, -0.04, 0));

    /* Thigh. */
    hip.add(part(new THREE.CapsuleGeometry(0.125, 0.19, 6, 16), mat.shell, 0, -0.22, 0));
    hip.add(part(shell(0.13, 0.14, 0.05, 0.02), mat.composite, 0, -0.24, 0.10));

    /* --- Knee -------------------------------------------------- */
    const knee = group(0, -0.40, 0);
    hip.add(knee);

    const kneeHinge = part(new THREE.CylinderGeometry(0.10, 0.10, 0.21, 18), mat.metal, 0, 0, 0);
    kneeHinge.rotation.z = Math.PI / 2;
    knee.add(kneeHinge);
    knee.add(part(shell(0.19, 0.16, 0.10, 0.05), mat.shell, 0, 0.01, 0.07));

    /* Shin + calf. */
    knee.add(part(new THREE.CapsuleGeometry(0.11, 0.17, 6, 16), mat.shell, 0, -0.21, 0));
    knee.add(part(shell(0.15, 0.22, 0.10, 0.05), mat.composite, 0, -0.20, -0.06));

    const shinLight = part(new THREE.CircleGeometry(0.03, 16), mat.glow, s * 0.085, -0.16, 0);
    shinLight.rotation.y = s * Math.PI / 2;
    knee.add(shinLight);

    /* --- Ankle + foot ------------------------------------------ */
    const ankle = group(0, -0.40, 0);
    knee.add(ankle);
    ankle.add(part(new THREE.CylinderGeometry(0.07, 0.08, 0.10, 16), mat.brushed, 0, 0.02, 0));

    ankle.add(part(shell(0.24, 0.13, 0.42, 0.05), mat.shell, 0, -0.065, 0.07));
    ankle.add(part(shell(0.20, 0.07, 0.12, 0.03), mat.shell, 0, -0.085, 0.26));
    ankle.add(part(shell(0.24, 0.05, 0.14, 0.025), mat.composite, 0, -0.09, -0.11));
    ankle.add(part(new THREE.BoxGeometry(0.22, 0.03, 0.40), mat.rubber, 0, -0.125, 0.07));

    /* Thruster pod in each foot (used while hovering). */
    const footThruster = part(new THREE.CircleGeometry(0.05, 16), mat.glow, 0, -0.14, 0.07);
    footThruster.rotation.x = Math.PI / 2;
    ankle.add(footThruster);

    parts.leg ??= {};
    parts.leg[s] = { hip, knee, ankle };
}

/* =========================================================
   HEAD (pitch -> yaw -> visor, eyes, mouth, ears, antenna)
========================================================= */

function buildHead(mat, parts, body) {
    /* Neck. */
    body.add(part(new THREE.CylinderGeometry(0.10, 0.13, 0.20, 18), mat.brushed, 0, 1.92, 0));
    body.add(part(new THREE.TorusGeometry(0.115, 0.018, 8, 30), mat.metal, 0, 1.99, 0));

    /* Two nested pivots = the head can look anywhere. */
    const headPitch = group(0, 2.03, 0);
    body.add(headPitch);

    const headYaw = group(0, 0, 0);
    headPitch.add(headYaw);

    /* Cranium. */
    headYaw.add(part(shell(0.74, 0.62, 0.64, 0.22), mat.shell, 0, 0.30, 0));

    const crown = part(new THREE.SphereGeometry(0.30, 28, 18), mat.shell, 0, 0.53, -0.01);
    crown.scale.set(1.0, 0.55, 0.95);
    headYaw.add(crown);

    /* Soft cleaner cap: friendly service silhouette instead of a sci-fi antenna crown. */
    headYaw.add(part(new THREE.CylinderGeometry(0.31, 0.36, 0.12, 24), mat.apronLight, 0, 0.68, -0.01));
    headYaw.add(part(new THREE.CylinderGeometry(0.34, 0.34, 0.035, 24), mat.badge, 0, 0.625, -0.01));
    headYaw.add(part(shell(0.52, 0.045, 0.18, 0.025), mat.apronLight, 0, 0.61, 0.20));

    headYaw.add(part(shell(0.62, 0.07, 0.52, 0.03), mat.composite, 0, 0.46, 0.14));
    headYaw.add(part(shell(0.42, 0.10, 0.36, 0.04), mat.composite, 0, 0.03, 0.07));

    /* --- Visor ------------------------------------------------- */
    headYaw.add(part(shell(0.64, 0.44, 0.12, 0.15), mat.composite, 0, 0.30, 0.27));
    headYaw.add(part(shell(0.56, 0.36, 0.06, 0.13), mat.glass, 0, 0.30, 0.325));
    headYaw.add(part(shell(0.40, 0.02, 0.03, 0.01), mat.glowDim, 0, 0.52, 0.24));

    /* --- Eyes (own group so the gaze can shift inside the visor) - */
    const eyeGroup = group(0, 0, 0);
    headYaw.add(eyeGroup);

    const eyes = [];
    [-1, 1].forEach((s) => {
        const eye = part(shell(0.115, 0.13, 0.03, 0.05), mat.glow, s * 0.135, 0.365, 0.345);
        eyeGroup.add(eye);
        eyes.push(eye);

        const eyeHalo = registerHalo(parts, halo(0.34, 0.22), 1);
        eyeHalo.position.set(s * 0.135, 0.365, 0.37);
        eyeGroup.add(eyeHalo);
    });
    parts.eyes = eyes;
    parts.eyeGroup = eyeGroup;

    /* --- Mouth equaliser --------------------------------------- */
    const mouthBars = [];
    for (let i = 0; i < 7; i += 1) {
        const bar = part(shell(0.03, 0.075, 0.02, 0.012), mat.glow, (i - 3) * 0.05, 0.17, 0.345);
        bar.scale.y = 0.35;
        headYaw.add(bar);
        mouthBars.push(bar);
    }
    parts.mouthBars = mouthBars;

    /* --- Ear pods (spin while Puhto is thinking) ----------------- */
    const ears = [];
    [-1, 1].forEach((s) => {
        const ear = group(s * 0.385, 0.31, 0);

        const cup = part(new THREE.CylinderGeometry(0.115, 0.115, 0.09, 24), mat.brushed, 0, 0, 0);
        cup.rotation.z = Math.PI / 2;
        ear.add(cup);
        ear.add(part(new THREE.TorusGeometry(0.115, 0.016, 8, 30), mat.composite, s * 0.05, 0, 0));

        /* Processing dial: a lit disc with tick marks that spin
           around the ear axis (local X) whenever Puhto thinks. */
        const spinner = group(s * 0.06, 0, 0);

        const dialFace = part(new THREE.CircleGeometry(0.05, 20), mat.glow, s * 0.008, 0, 0);
        dialFace.rotation.y = s * Math.PI / 2;
        spinner.add(dialFace);

        for (let i = 0; i < 3; i += 1) {
            const arm = group(0, 0, 0);
            arm.rotation.x = (i * Math.PI * 2) / 3;
            arm.add(part(new THREE.BoxGeometry(0.018, 0.055, 0.018), mat.glowDim, 0, 0.082, 0));
            spinner.add(arm);
        }

        ear.add(spinner);
        headYaw.add(ear);
        ears.push(spinner);
    });
    parts.ears = ears;

    /* --- Antenna ------------------------------------------------ */
    const antenna = group(-0.24, 0.52, -0.09);
    headYaw.add(antenna);

    antenna.add(part(new THREE.CylinderGeometry(0.04, 0.055, 0.07, 14), mat.composite, 0, 0.02, 0));
    antenna.add(part(new THREE.CylinderGeometry(0.014, 0.02, 0.30, 10), mat.metal, 0, 0.19, 0));

    const antennaRing = part(new THREE.TorusGeometry(0.038, 0.008, 8, 22), mat.brushed, 0, 0.10, 0);
    antennaRing.rotation.x = Math.PI / 2;
    antenna.add(antennaRing);

    const tip = part(new THREE.SphereGeometry(0.05, 20, 14), mat.core, 0, 0.35, 0);
    antenna.add(tip);
    parts.antennaTip = tip;

    const tipHalo = registerHalo(parts, halo(0.4, 0.22), 1);
    tipHalo.position.set(0, 0.35, 0);
    antenna.add(tipHalo);
    parts.antenna = antenna;

    parts.headPitch = headPitch;
    parts.headYaw = headYaw;
}

/* =========================================================
   BUILD THE ROBOT
========================================================= */

export function createPuhtoRobot() {
    const mat = createMaterials();

    const root = group();            /* world placement + facing */
    const bob = group(0, 0.02, 0);   /* hover float              */
    root.add(bob);

    const body = group();            /* lean and sway            */
    bob.add(body);

    const parts = { root, bob, body, mat };

    buildTorso(mat, parts);
    buildHead(mat, parts, body);

    [-1, 1].forEach((s) => {
        const hip = group(s * 0.22, 0.94, 0);
        body.add(hip);
        buildLeg(mat, parts, hip, s);
    });

    /* Ground glow - sells the hover. */
    const groundGlow = registerHalo(parts, halo(1.9, 0.12), 0.7);
    groundGlow.position.y = 0.05;
    root.add(groundGlow);

    /* Shadows on every solid mesh (additive sprites never cast). */
    root.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        if (o.material.transparent || o.material.blending === THREE.AdditiveBlending) return;
        o.castShadow = true;
        o.receiveShadow = true;
    });

    /* Animation scratch objects + helpers (must sit BEFORE the
       factory returns - closures only capture initialized bindings). */
    const tmpPos = new THREE.Vector3();
    const tmpDir = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();

    const smooth = (current, target, lambda, dt) => damp(current, target, lambda, dt);

    const fade = (p, inFrac, outFrac) => {
        const raw = Math.min(1, p / inFrac) * Math.min(1, (1 - p) / outFrac);
        return raw * raw * (3 - 2 * raw);   /* ease the envelope */
    };

    const st = createState();

    return {
        root,
        bob,
        body,
        parts,
        mat,
        height: 2.7,
        update,
        setState,
        getState,
        setGazePoint,
        pulseVoice,
        playWave,
        playHappy,
        walkTo,
        stopWalking,
        getTelemetry
    };

    /* ---------------------------------------------------------
       State object keeps everything the animator touches.
    --------------------------------------------------------- */
    function createState() {
        return {
            state: ROBOT_STATE.IDLE,
            stateTime: 0,
            time: 0,
            voice: 0,
            waveTime: -1,
            happyTime: -1,
            walkTarget: 0,
            walking: false,
            gaze: new THREE.Vector3(0, 2.2, 3),
            gazeWeight: 0,
            gazeEnabled: false,
            blinkTimer: 2.5,
            blink: 0,
            mood: new THREE.Color(GLOW_COLOR.idle),
            moodTarget: new THREE.Color(GLOW_COLOR.idle),
            lambda: 12,
            telemetry: { servo: 0.18, core: 0.62, hover: 0.02, state: ROBOT_STATE.IDLE }
        };
    }

    /* =========================================================
       PUBLIC CONTROLS
    ========================================================= */

    function setState(name) {
        if (st.state === name) return;
        st.state = name;
        st.stateTime = 0;
        st.moodTarget.set(GLOW_COLOR[name] ?? GLOW_COLOR.idle);

        if (name !== ROBOT_STATE.WALKING) st.walking = false;
        if (name === ROBOT_STATE.TALKING) st.voice = Math.max(st.voice, 0.55);
    }

    function getState() {
        return st.state;
    }

    function setGazePoint(point) {
        if (!point) {
            st.gazeEnabled = false;
            return;
        }
        st.gaze.copy(point);
        st.gazeEnabled = true;
    }

    /* Called on speech word boundaries so the mouth follows the voice. */
    function pulseVoice(amount = 1) {
        st.voice = Math.min(1, Math.max(st.voice, amount));
    }

    function playWave(duration = 2.8) {
        st.waveTime = 0;
        st.waveDuration = duration;
        st.state = ROBOT_STATE.WAVING;
        st.stateTime = 0;
        st.moodTarget.set(GLOW_COLOR.waving);
    }

    function playHappy(duration = 2.2) {
        st.happyTime = 0;
        st.happyDuration = duration;
        st.spinStart = null;
        st.state = ROBOT_STATE.HAPPY;
        st.stateTime = 0;
        st.moodTarget.set(GLOW_COLOR.happy);
    }

    function walkTo(x, maxStep = 1.6) {
        st.walkTarget = clamp(x, -maxStep, maxStep);
        st.walking = true;
        st.state = ROBOT_STATE.WALKING;
        st.stateTime = 0;
        st.moodTarget.set(GLOW_COLOR.walking);
    }

    function stopWalking() {
        st.walking = false;
        st.facing = 0;
        st.targetFacing = 0;
        if (st.state === ROBOT_STATE.WALKING) {
            st.state = ROBOT_STATE.IDLE;
            st.stateTime = 0;
            st.moodTarget.set(GLOW_COLOR.idle);
        }
    }

    function getTelemetry() {
        st.telemetry.state = st.state;
        return st.telemetry;
    }

    /* =========================================================
       ANIMATION HELPERS
       Every frame we work out a *target* pose for the current
       state, then damp the real joints towards it. That is what
       makes state changes feel mechanical instead of instant.
       (Declared before the factory returns so closures see
       initialized bindings - never put consts after a return.)
    ========================================================= */

    function aim(object, x, y, z, lambda, dt) {
        object.rotation.x = smooth(object.rotation.x, x, lambda, dt);
        object.rotation.y = smooth(object.rotation.y, y, lambda, dt);
        object.rotation.z = smooth(object.rotation.z, z, lambda, dt);
    }

    function update(dt) {
        dt = Math.min(dt, 1 / 30);          /* no jumps after a tab switch */
        st.time += dt;
        st.stateTime += dt;

        const t = st.time;
        const P = parts;
        const talking = st.state === ROBOT_STATE.TALKING;
        const walking = st.state === ROBOT_STATE.WALKING;

        /* --- voice envelope decays between words --------------- */
        st.voice = Math.max(0, st.voice - dt * (talking ? 1.4 : 3));

        /* --- blink --------------------------------------------- */
        st.blinkTimer -= dt;
        if (st.blinkTimer <= 0) {
            st.blink = 1;
            st.blinkTimer = 2 + Math.random() * 4;
        }
        if (st.blink > 0) st.blink = Math.max(0, st.blink - dt * 7);

        /* --- mood colour + emissive levels --------------------- */
        st.mood.lerp(st.moodTarget, 1 - Math.exp(-6 * dt));

        const intensity = EMISSIVE_BY_STATE[st.state] ?? EMISSIVE_BY_STATE.idle;

        const pulse = st.state === ROBOT_STATE.THINKING
            ? 0.7 + 0.3 * Math.sin(t * 9)
            : 1 + 0.06 * Math.sin(t * 3);

        mat.glow.emissive.copy(st.mood);
        mat.glowDim.emissive.copy(st.mood);
        mat.core.emissive.copy(st.mood);
        mat.glow.emissiveIntensity = intensity * pulse;
        mat.glowDim.emissiveIntensity = intensity * 0.45 * pulse;
        mat.core.emissiveIntensity = intensity * 1.2 * (1 + 0.06 * Math.sin(t * 4) + st.voice * 0.25);

        for (let i = 0; i < P.halos.length; i += 1) {
            const h = P.halos[i];
            h.sprite.material.color.copy(st.mood);
            h.sprite.material.opacity = h.baseOpacity * (0.9 + st.voice * 0.25 + 0.08 * Math.sin(t * 2.5));
            const s = h.baseSize * (1 + 0.05 * Math.sin(t * 3) + st.voice * 0.12);
            h.sprite.scale.setScalar(s);
        }

        /* --- base pose targets --------------------------------- */
        let bobY = 0.025 + Math.sin(t * 1.6) * 0.012;
        let bodyX = Math.sin(t * 1.6) * 0.012;
        let bodyZ = Math.sin(t * 0.7) * 0.018;
        let waistY = Math.sin(t * 0.5) * 0.05;
        let waistX = 0;
        let headYaw = Math.sin(t * 0.42) * 0.20;
        let headPitch = Math.sin(t * 0.85) * 0.05;
        let headRoll = 0;

        const arm = POSE.arm;
        const leg = POSE.leg;

        arm[0].x = Math.sin(t * 1.1) * 0.05;
        arm[0].y = 0;
        arm[0].z = -0.11 + Math.sin(t * 1.3) * 0.03;
        arm[0].e = -0.18;
        arm[0].f = -0.45;

        arm[1].x = -Math.sin(t * 1.1) * 0.05;
        arm[1].y = 0;
        arm[1].z = 0.11 - Math.sin(t * 1.3) * 0.03;
        arm[1].e = -0.18;
        arm[1].f = -0.45;

        leg[0].h = 0.03;
        leg[0].k = 0.04;
        leg[0].a = -0.03;
        leg[1].h = -0.03;
        leg[1].k = 0.04;
        leg[1].a = -0.03;

        const armL = arm[0];
        const armR = arm[1];
        const legL = leg[0];
        const legR = leg[1];

        /* --- gaze (head tracks a world-space point) ------------- */
        st.gazeWeight = smooth(st.gazeWeight, st.gazeEnabled ? 1 : 0, 4, dt);

        let gazeYaw = 0;
        let gazePitch = 0;
        const gazeAmt = st.gazeWeight * (st.state === ROBOT_STATE.THINKING ? 0.3 : 1);

        if (st.gazeEnabled && gazeAmt > 0.001) {
            P.headPitch.getWorldPosition(tmpPos);
            tmpDir.copy(st.gaze).sub(tmpPos);
            root.getWorldQuaternion(tmpQuat);
            tmpDir.applyQuaternion(tmpQuat.invert());

            const dist = Math.max(0.4, Math.hypot(tmpDir.x, tmpDir.z));
            gazeYaw = clamp(Math.atan2(tmpDir.x, tmpDir.z), -0.6, 0.6);
            gazePitch = -clamp(Math.atan2(tmpDir.y, dist), -0.35, 0.4);

            headYaw = headYaw * (1 - gazeAmt) + gazeYaw * gazeAmt;
            headPitch = headPitch * (1 - gazeAmt) + gazePitch * gazeAmt;
        }
        st.gazeYaw = gazeYaw * gazeAmt;
        st.gazePitch = gazePitch * gazeAmt;

        /* --- state flavour -------------------------------------- */
        if (st.state === ROBOT_STATE.LISTENING) {
            bodyX += 0.035;                                    /* lean in   */
            headRoll = 0.12 + Math.sin(t * 0.9) * 0.03;
            waistY += 0.05;
            armL.z -= 0.05;
            armR.z += 0.05;
        }

        if (st.state === ROBOT_STATE.THINKING) {
            headYaw = Math.sin(t * 0.65) * 0.38;              /* ponders   */
            headPitch = 0.07 + Math.sin(t * 1.15) * 0.05;
            headRoll = -0.09;
            armL.e = -0.45;                                   /* hand to chin */
            armL.x = -0.22;
            armL.z = -0.30;
        }

        if (talking) {
            bodyX += 0.012;
            headYaw *= 0.55;
            headPitch += Math.sin(t * 5.4) * 0.015 + st.voice * 0.02;
            armR.x = -0.30 + Math.sin(t * 3.1) * 0.10;        /* explaining gesture */
            armR.e = -0.75 + Math.sin(t * 2.3) * 0.18;
            armR.f = -0.15 - Math.abs(Math.sin(t * 2.7)) * 0.35;
            armL.e = -0.35 + Math.sin(t * 1.7) * 0.10;
        }

        /* --- walking --------------------------------------------- */
        if (walking) {
            const dx = st.walkTarget - root.position.x;

            if (Math.abs(dx) < 0.05) {
                st.walking = false;
                st.facing = 0;
                st.targetFacing = 0;
                st.state = ROBOT_STATE.IDLE;
                st.stateTime = 0;
                st.moodTarget.set(GLOW_COLOR.idle);
            } else {
                const dir = Math.sign(dx);
                const speed = 1.15;
                root.position.x += dir * speed * dt;
                st.targetFacing = dir * 0.32;
                st.facing = smooth(st.facing ?? 0, st.targetFacing, 6, dt);

                st.stepPhase = ((st.stepPhase ?? 0) + dt * 9.0) % (Math.PI * 2);
                const sp = st.stepPhase;

                legR.h = -Math.sin(sp) * 0.45;
                legL.h = Math.sin(sp) * 0.45;
                legR.k = 0.12 + 0.55 * Math.max(0, Math.cos(sp));
                legL.k = 0.12 + 0.55 * Math.max(0, Math.cos(sp + Math.PI));
                legR.a = -0.05 - 0.12 * Math.sin(sp + 1);
                legL.a = -0.05 - 0.12 * Math.sin(sp + Math.PI + 1);

                armR.x = Math.sin(sp) * 0.30;
                armL.x = -Math.sin(sp) * 0.30;
                armR.e = -0.32 - Math.abs(Math.sin(sp)) * 0.15;
                armL.e = armR.e;
                armR.f = -0.35;
                armL.f = -0.35;

                waistY = Math.sin(sp) * 0.07;
                bodyX = 0.05;
                bodyZ = Math.sin(sp) * 0.02;
                bobY = 0.03 + Math.abs(Math.sin(sp)) * 0.02;
                headYaw *= 0.4;
                headPitch = 0.02;
            }
        }
        st.facing = st.facing ?? 0;

        /* --- one-shot performances ------------------------------- */
        let spin = st.spin ?? 0;

        if (st.waveTime >= 0) {
            st.waveTime += dt;
            const p = Math.min(1, st.waveTime / (st.waveDuration ?? 2.8));

            if (p >= 1) {
                st.waveTime = -1;
                if (st.state === ROBOT_STATE.WAVING) {
                    st.state = ROBOT_STATE.IDLE;
                    st.stateTime = 0;
                    st.moodTarget.set(GLOW_COLOR.idle);
                }
            } else {
                const env = fade(p, 0.16, 0.22);
                armR.z = lerp(armR.z, 2.1, env);
                armR.x = lerp(armR.x, -0.25, env);
                armR.e = lerp(armR.e, -0.35 + Math.sin(t * 9) * 0.45, env);
                armR.f = lerp(armR.f, -0.05, env);
                headPitch = lerp(headPitch, -0.04 + Math.sin(t * 4) * 0.03, env);
            }
        }

        if (st.happyTime >= 0) {
            st.happyTime += dt;
            const p = Math.min(1, st.happyTime / (st.happyDuration ?? 2.2));

            if (p >= 1) {
                st.happyTime = -1;
                if (st.state === ROBOT_STATE.HAPPY) {
                    st.state = ROBOT_STATE.IDLE;
                    st.stateTime = 0;
                    st.moodTarget.set(GLOW_COLOR.idle);
                }
            } else {
                const env = fade(p, 0.15, 0.25);
                bobY += Math.abs(Math.sin(t * 7)) * 0.07 * env;    /* hops   */
                armL.z = lerp(armL.z, -1.75 + Math.sin(t * 6) * 0.25, env);
                armR.z = lerp(armR.z, 1.75 + Math.sin(t * 6 + 1.2) * 0.25, env);
                armL.e = armR.e = lerp(armR.e, -0.5, env);
                armL.f = armR.f = lerp(armR.f, -0.08, env);
                headPitch = lerp(headPitch, 0.10 * Math.sin(t * 6.5), env);
                st.spinStart ??= spin;
                spin = st.spinStart + Math.PI * 2 * Math.min(1, p / 0.8);  /* victory spin */
            }
        }
        st.spin = spin;

        /* --- apply the pose (damped = mechanical, not snappy) ---- */
        aim(P.body, bodyX, 0, bodyZ, 9, dt);
        aim(P.waist, waistX, waistY, 0, 9, dt);
        aim(P.headPitch, headPitch, 0, headRoll, 11, dt);
        aim(P.headYaw, 0, headYaw, 0, 11, dt);

        for (let i = 0; i < 2; i += 1) {
            const s = POSE.side[i];
            const a = arm[i];
            const A = P.arm[s];
            aim(A.shoulder, a.x, a.y, a.z, 10, dt);
            aim(A.elbow, a.e, 0, 0, 12, dt);
            aim(A.wrist, 0, 0, 0, 10, dt);
            const fingers = A.fingers;
            for (let f = 0; f < fingers.length; f += 1) {
                const curl = f === fingers.length - 1 ? a.f * 0.6 + (s * 0.05) : a.f;
                fingers[f].rotation.x = smooth(fingers[f].rotation.x, curl, 12, dt);
            }

            const l = leg[i];
            const L = P.leg[s];
            aim(L.hip, l.h, s * 0.04, 0, 10, dt);
            aim(L.knee, l.k, 0, 0, 12, dt);
            aim(L.ankle, l.a, 0, 0, 10, dt);
        }

        bob.position.y = smooth(bob.position.y, bobY, 10, dt);
        root.rotation.y = smooth(root.rotation.y, (st.facing ?? 0) + spin, 6, dt);

        /* --- eyes: blink + gaze shift inside the visor ------------ */
        const blinkScale = 1 - Math.sin(Math.PI * st.blink);
        for (let i = 0; i < P.eyes.length; i += 1) {
            const eye = P.eyes[i];
            eye.scale.y = smooth(eye.scale.y, blinkScale, 30, dt);
        }

        P.eyeGroup.position.x = smooth(P.eyeGroup.position.x, (st.gazeYaw ?? 0) * 0.05, 8, dt);
        P.eyeGroup.position.y = smooth(P.eyeGroup.position.y, -(st.gazePitch ?? 0) * 0.04, 8, dt);

        /* --- mouth lip-sync (voice envelope on 7 bars) ------------ */
        for (let i = 0; i < P.mouthBars.length; i += 1) {
            const bar = P.mouthBars[i];
            let target = 0.28;
            if (talking) {
                target = 0.25 + st.voice * (0.6 + 0.4 * Math.abs(Math.sin(t * 13 + i * 1.15)));
            } else if (st.state === ROBOT_STATE.LISTENING) {
                target = 0.30 + 0.18 * Math.abs(Math.sin(t * 4 - i * 0.8));
            } else if (st.state === ROBOT_STATE.THINKING) {
                target = 0.30 + 0.25 * (0.5 + 0.5 * Math.sin(t * 5 + i * 0.9));
            }
            bar.scale.y = smooth(bar.scale.y, target, 16, dt);
        }

        /* --- chest equaliser -------------------------------------- */
        for (let i = 0; i < P.eqBars.length; i += 1) {
            const bar = P.eqBars[i];
            let target = 0.35 + 0.1 * Math.sin(t * 2 + i * 0.7);
            if (talking) target = 0.30 + st.voice * (0.9 + 0.5 * Math.sin(t * 9 + i * 1.3));
            else if (walking) target = 0.40 + 0.35 * Math.abs(Math.sin(t * 6 - i * 0.5));
            else if (st.state === ROBOT_STATE.THINKING) target = 0.35 + 0.3 * Math.abs(Math.sin(t * 4 + i * 0.9));
            bar.scale.y = smooth(bar.scale.y, target, 14, dt);
        }

        /* --- reactor core + gimbal rings --------------------------- */
        P.coreRings[0].rotation.y += dt * 1.1;
        P.coreRings[1].rotation.x += dt * 0.85;
        P.coreMesh.scale.setScalar(1 + 0.05 * Math.sin(t * 4) + st.voice * 0.15);

        /* --- ear dials --------------------------------------------- */
        const earSpeed = EAR_SPEED_BY_STATE[st.state] ?? EAR_SPEED_BY_STATE.idle;
        for (let i = 0; i < P.ears.length; i += 1) {
            P.ears[i].rotation.x += dt * earSpeed * (i === 0 ? 1 : -1);
        }

        /* --- antenna wiggle ---------------------------------------- */
        P.antenna.rotation.z = Math.sin(t * 2.2) * 0.05 + st.voice * Math.sin(t * 22) * 0.03;
        P.antenna.rotation.x = Math.cos(t * 1.7) * 0.04;

        /* --- thrusters flare when Puhto moves or celebrates --------- */
        const thrust = walking ? 1 : (st.happyTime >= 0 ? 0.7 : 0.1 + st.voice * 0.4);
        for (let i = 0; i < P.thrusters.length; i += 1) {
            const th = P.thrusters[i];
            if (th.userData.base === undefined) th.userData.base = th.scale.x;
            th.scale.setScalar(th.userData.base * (0.7 + thrust));
        }

        /* --- HUD telemetry ------------------------------------------ */
        const servoLoad = clamp(
            0.15
            + (walking ? 0.55 : 0)
            + (st.waveTime >= 0 || st.happyTime >= 0 ? 0.35 : 0)
            + st.voice * 0.2
            + Math.abs(Math.sin(t * 2.1)) * 0.05,
            0, 1
        );
        const coreTemp = clamp(
            0.5 + 0.18 * Math.sin(t * 0.9) + st.voice * 0.3
            + (st.state === ROBOT_STATE.THINKING ? 0.15 : 0),
            0, 1
        );

        st.telemetry.servo = smooth(st.telemetry.servo, servoLoad, 3, dt);
        st.telemetry.core = smooth(st.telemetry.core, coreTemp, 3, dt);
        st.telemetry.hover = bob.position.y;
    }
}








