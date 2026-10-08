/* =========================================================
   STAGE - renderer, camera, lighting, floor, post FX
   =========================================================
   createStage(canvas, container) returns everything app.js needs to
   put Puhto in a lit, reflective, bloom-graded environment.

   Two looks share one scene: the default light "studio" and the
   dark aurora look behind the theme toggle. setTheme() crossfades
   sky, fog, lights, floor, dust and bloom so the 3D stage always
   matches the CSS theme.
   ========================================================= */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";

/* =========================================================
   LOOKS

   Sky colours stay below the bloom threshold on purpose: only the
   robot's emissives and the stage rings are meant to glow, not the
   background.
   ========================================================= */

const LOOKS = {
    light: {
        sky: { top: 0xe8f1ef, horizon: 0xfbfcf8, bottom: 0xd5e5e2 },
        fog: { color: 0xe3efec, density: 0.022 },
        exposure: 1.04,
        environmentIntensity: 0.80,
        key: { color: 0xfffefa, intensity: 2.4 },
        rim: { color: 0x9bcbb9, intensity: 0.82 },
        hemi: { sky: 0xe8f5f2, ground: 0xb4c8c5, intensity: 1.0 },
        floorLight: { color: 0xb9dcd0, intensity: 1.25, wobble: 0.12 },
        floor: 0xd4e2e0,
        shadowOpacity: 0.22,
        ring: { color: 0x4d9c88, opacity: 0.25 },
        dust: { color: 0xb1cec9, opacity: 0.16, additive: false },
        bloom: { strength: 0.06, radius: 0.35, threshold: 1.0 }
    },
    dark: {
        sky: { top: 0x10212a, horizon: 0x1d3a43, bottom: 0x0b151b },
        fog: { color: 0x102228, density: 0.028 },
        exposure: 0.98,
        environmentIntensity: 0.64,
        key: { color: 0xe6f1ec, intensity: 2.4 },
        rim: { color: 0x78bea8, intensity: 0.86 },
        hemi: { sky: 0x416b70, ground: 0x122228, intensity: 0.64 },
        floorLight: { color: 0x5caa9d, intensity: 1.3, wobble: 0.22 },
        floor: 0x20343b,
        shadowOpacity: 0.42,
        ring: { color: 0x59aa9a, opacity: 0.24 },
        dust: { color: 0x89bcb0, opacity: 0.16, additive: false },
        bloom: { strength: 0.08, radius: 0.35, threshold: 1.0 }
    }
};

const clamp = THREE.MathUtils.clamp;

export function createStage(canvas, container) {
    /* --- renderer ------------------------------------------------ */
    const isMobileLayout = window.matchMedia("(max-width: 900px)").matches;
    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false,            /* FXAA handles edges post-hoc */
        alpha: false,
        powerPreference: "high-performance"
    });
    /* Phones cannot fill a high-DPR canvas plus bloom at 60 FPS,
       so small screens render at a lower device pixel ratio. */
    const maxPixelRatio = isMobileLayout ? 1.5 : 2;
    renderer.setPixelRatio(
        Math.min(window.devicePixelRatio || 1, maxPixelRatio)
    );
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = LOOKS.light.exposure;

    /* --- scene + camera ------------------------------------------ */
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(LOOKS.light.fog.color, LOOKS.light.fog.density);

    const camera = new THREE.PerspectiveCamera(
        38, container.clientWidth / container.clientHeight, 0.1, 120
    );
    camera.position.set(0, 1.9, 7.4);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.45, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.enablePan = false;
    controls.rotateSpeed = 0.75;
    controls.zoomSpeed = 0.8;
    controls.minDistance = 2.2;
    controls.maxDistance = 13;
    controls.minPolarAngle = 0.35;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.update();

    /* Image-based ambient from a neutral room probe. */
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new RoomEnvironment();
    scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    scene.environmentIntensity = LOOKS.light.environmentIntensity;
    pmrem.dispose();

    /* --- sky dome -------------------------------------------------- */
    const skyUniforms = {
        top: { value: new THREE.Color() },
        horizon: { value: new THREE.Color() },
        bottom: { value: new THREE.Color() }
    };

    const sky = new THREE.Mesh(
        new THREE.SphereGeometry(70, 32, 16),
        new THREE.ShaderMaterial({
            side: THREE.BackSide,
            depthWrite: false,
            uniforms: skyUniforms,
            vertexShader: `
                varying vec3 vPos;
                void main() {
                    vPos = position;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: `
                varying vec3 vPos;
                uniform vec3 top;
                uniform vec3 horizon;
                uniform vec3 bottom;
                void main() {
                    float h = normalize(vPos).y;
                    vec3 c = h > 0.0
                        ? mix(horizon, top, smoothstep(0.0, 0.55, h))
                        : mix(horizon, bottom, smoothstep(0.0, -0.35, h));
                    gl_FragColor = vec4(c, 1.0);
                }`
        })
    );
    scene.add(sky);

    /* --- lights: warm key, sage rim, soft fill ----------------------- */
    const key = new THREE.DirectionalLight(LOOKS.light.key.color, LOOKS.light.key.intensity);
    key.position.set(4, 7, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(isMobileLayout ? 512 : 1024, isMobileLayout ? 512 : 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 24;
    key.shadow.camera.left = -5;
    key.shadow.camera.right = 5;
    key.shadow.camera.top = 6;
    key.shadow.camera.bottom = -2;
    key.shadow.bias = -0.0008;
    scene.add(key);

    const rim = new THREE.DirectionalLight(LOOKS.light.rim.color, LOOKS.light.rim.intensity);
    rim.position.set(-5, 3.5, -4.5);
    scene.add(rim);

    const fill = new THREE.HemisphereLight(
        LOOKS.light.hemi.sky,
        LOOKS.light.hemi.ground,
        LOOKS.light.hemi.intensity
    );
    scene.add(fill);

    const floorGlowLight = new THREE.PointLight(
        LOOKS.light.floorLight.color,
        LOOKS.light.floorLight.intensity,
        9,
        2
    );
    floorGlowLight.position.set(0, 0.4, 1.6);
    scene.add(floorGlowLight);

    /* --- reflective floor + shadow catcher -------------------------- */
    const floorTarget = { width: 0, height: 0 };
    const floorResolution = isMobileLayout ? 256 : 512;
    const floorSegments = isMobileLayout ? 48 : 64;

    const floor = new Reflector(new THREE.CircleGeometry(10, floorSegments), {
        clipBias: 0.003,
        textureWidth: floorResolution,
        textureHeight: floorResolution,
        color: LOOKS.light.floor
    });
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    /* Reflector ignores shadow maps, so a transparent plane on top
       catches the robot's shadow without hiding the mirror. */
    const shadowCatcher = new THREE.Mesh(
        new THREE.CircleGeometry(10, floorSegments),
        new THREE.ShadowMaterial({ opacity: LOOKS.light.shadowOpacity })
    );
    shadowCatcher.rotation.x = -Math.PI / 2;
    shadowCatcher.position.y = 0.004;
    shadowCatcher.receiveShadow = true;
    scene.add(shadowCatcher);

    /* Glowing stage rings. */
    const ringMat = new THREE.MeshBasicMaterial({
        color: LOOKS.light.ring.color, toneMapped: true, transparent: true,
        opacity: LOOKS.light.ring.opacity
    });
    const ringSegments = isMobileLayout ? 72 : 120;
    [2.9, 4.2].forEach((r, i) => {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r, i ? 0.012 : 0.02, 8, ringSegments), ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.01;
        scene.add(ring);
    });

    /* --- drifting dust ---------------------------------------------- */
    const dustCount = isMobileLayout ? 80 : 160;
    const dustPos = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i += 1) {
        dustPos[i * 3] = (Math.random() - 0.5) * 14;
        dustPos[i * 3 + 1] = Math.random() * 5;
        dustPos[i * 3 + 2] = (Math.random() - 0.5) * 14;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
    const dustMat = new THREE.PointsMaterial({
        color: LOOKS.light.dust.color, size: 0.03, transparent: true,
        opacity: LOOKS.light.dust.opacity, blending: THREE.NormalBlending,
        depthWrite: false, sizeAttenuation: true
    });
    const dust = new THREE.Points(dustGeo, dustMat);
    scene.add(dust);

    /* --- post-processing -------------------------------------------- */
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    const bloom = new UnrealBloomPass(
        new THREE.Vector2(container.clientWidth, container.clientHeight),
        LOOKS.light.bloom.strength,
        LOOKS.light.bloom.radius,
        LOOKS.light.bloom.threshold
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const fxaa = new ShaderPass(FXAAShader);
    composer.addPass(fxaa);

    const setFxaaResolution = () => {
        const pr = renderer.getPixelRatio();
        fxaa.material.uniforms.resolution.value.set(
            1 / (container.clientWidth * pr), 1 / (container.clientHeight * pr)
        );
    };
    setFxaaResolution();

    /* =========================================================
       ADAPTIVE QUALITY

       Keeps the frame budget on weak GPUs: when the rolling average
       frame time exceeds ~24ms the pixel ratio (and with it bloom,
       FXAA and every shader) is scaled down; below ~14ms it scales
       back up. Recovery steps are smaller so it never oscillates.
       The mirror render target and bloom follow the same scale,
       because both are pure fill-rate.
       ========================================================= */

    const basePixelRatio = renderer.getPixelRatio();
    let quality = 1;
    let frameTimeSum = 0;
    let frameCount = 0;
    let bloomEnabled = true;
    let reflectScale = 1;
    let lastResize = { w: 0, h: 0, pixelRatio: 0, reflectScale: 0 };

    function resize() {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (!w || !h) return;

        const pr = renderer.getPixelRatio();
        if (lastResize.w === w && lastResize.h === h
            && lastResize.pixelRatio === pr && lastResize.reflectScale === reflectScale) {
            return;
        }
        lastResize = { w, h, pixelRatio: pr, reflectScale };

        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
        composer.setSize(w, h);
        setFxaaResolution();

        floorTarget.width = clamp(Math.round(w * pr * 0.5 * reflectScale), 256, 1024);
        floorTarget.height = clamp(Math.round(h * pr * 0.5 * reflectScale), 256, 1024);
        floor.getRenderTarget().setSize(floorTarget.width, floorTarget.height);
    }

    function applyQuality() {
        renderer.setPixelRatio(Math.max(0.7, basePixelRatio * quality));
        /* Bloom is the single most expensive pass: drop it before the
           pixel ratio gets so low that the whole stage turns soft. */
        const wantBloom = quality > 0.8;
        if (wantBloom !== bloomEnabled) {
            bloomEnabled = wantBloom;
            bloom.enabled = wantBloom;
        }
        reflectScale = quality;
        resize();
    }

    function adaptQuality(dtMs) {
        if (dtMs > 100) return; // A tab switch or long pause is not a slow GPU.
        frameTimeSum += dtMs;
        if (++frameCount < 90) return;
        const avg = frameTimeSum / frameCount;
        frameTimeSum = 0;
        frameCount = 0;

        if (avg > 24 && quality > 0.65) {
            quality = Math.max(0.65, quality - 0.15);
            applyQuality();
        } else if (avg < 14 && quality < 1) {
            quality = Math.min(1, quality + 0.05);
            applyQuality();
        }
    }

    /* --- theme ------------------------------------------------------ */
    let theme = "light";
    let floorGlowBase = LOOKS.light.floorLight.intensity;
    let floorGlowWobble = 0.14;

    function applyLook(name) {
        const look = LOOKS[name] ?? LOOKS.light;

        renderer.toneMappingExposure = look.exposure;

        skyUniforms.top.value.setHex(look.sky.top);
        skyUniforms.horizon.value.setHex(look.sky.horizon);
        skyUniforms.bottom.value.setHex(look.sky.bottom);

        scene.fog.color.setHex(look.fog.color);
        scene.fog.density = look.fog.density;
        scene.environmentIntensity = look.environmentIntensity;

        key.color.setHex(look.key.color);
        key.intensity = look.key.intensity;
        rim.color.setHex(look.rim.color);
        rim.intensity = look.rim.intensity;
        fill.color.setHex(look.hemi.sky);
        fill.groundColor.setHex(look.hemi.ground);
        fill.intensity = look.hemi.intensity;

        floorGlowLight.color.setHex(look.floorLight.color);
        floorGlowBase = look.floorLight.intensity;
        floorGlowWobble = look.floorLight.wobble;

        floor.material.uniforms.color.value.setHex(look.floor);
        shadowCatcher.material.opacity = look.shadowOpacity;

        ringMat.color.setHex(look.ring.color);
        ringMat.opacity = look.ring.opacity;

        /* Additive dust is invisible on a white background, so the
           light look swaps to normal blending. */
        dustMat.color.setHex(look.dust.color);
        dustMat.opacity = look.dust.opacity;
        dustMat.blending = look.dust.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
        dustMat.needsUpdate = true;

        bloom.strength = look.bloom.strength;
        bloom.radius = look.bloom.radius;
        bloom.threshold = look.bloom.threshold;

        /* Tone mapping lives inside every shader program, so the
           cached programs have to be dropped after a look change. */
        scene.traverse((object) => {
            if (!object.material) return;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) material.needsUpdate = true;
        });
    }

    applyLook("light");

    /* --- pointer helper (gaze target under the cursor) -----------------
       Runs on every pointermove, so it reuses its scratch objects and
       returns a shared vector: the caller copies it immediately. */
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const plane = new THREE.Plane();
    const hit = new THREE.Vector3();
    const camNormal = new THREE.Vector3();

    function pointerGaze(clientX, clientY, point) {
        const rect = container.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        ndc.set(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1
        );
        raycaster.setFromCamera(ndc, camera);
        camera.getWorldDirection(camNormal);
        plane.setFromNormalAndCoplanarPoint(camNormal, point);
        return raycaster.ray.intersectPlane(plane, hit) ? hit : null;
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    /* --- frame ----------------------------------------------------------- */
    function render(dt, elapsed, rawDt = dt) {
        if (rawDt > 0) adaptQuality(rawDt * 1000);
        controls.update();

        dust.rotation.y = elapsed * 0.012;
        dust.position.y = Math.sin(elapsed * 0.25) * 0.15;
        floorGlowLight.intensity = floorGlowBase + Math.sin(elapsed * 2.2) * floorGlowWobble;

        composer.render(dt);
    }

    return {
        renderer, scene, camera, controls, composer, bloom,
        pointerGaze, resize, render, adaptQuality,
        setTheme(name) {
            if (name === theme) return;
            theme = name;
            applyLook(name);
        },
        getTheme: () => theme,
        getQuality: () => ({ quality, bloom: bloomEnabled, pixelRatio: renderer.getPixelRatio() })
    };
}
