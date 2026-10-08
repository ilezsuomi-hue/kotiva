/* =========================================================
   SMOKE TEST - node test-robot.mjs
   Builds the robot headlessly and runs every animation state
   for a few hundred frames, checking for throws and NaNs.
========================================================= */

/* Minimal DOM so glowTexture() can run outside a browser. */
globalThis.document = {
    createElement() {
        return {
            width: 0,
            height: 0,
            getContext() {
                return {
                    fillStyle: null,
                    createRadialGradient() {
                        return { addColorStop() { /* noop */ } };
                    },
                    fillRect() { /* noop */ }
                };
            }
        };
    }
};

const THREE = await import("three");
const { createPuhtoRobot, ROBOT_STATE } = await import("./robot.js");

let failures = 0;
const check = (label, ok) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failures += 1;
};

/* --- build ------------------------------------------------- */
const robot = createPuhtoRobot();
const P = robot.parts;

check("robot builds", Boolean(robot.root));
check("both arms present", Boolean(P.arm[-1] && P.arm[1]));
check("both legs present", Boolean(P.leg[-1] && P.leg[1]));
check("head pivots present", Boolean(P.headPitch && P.headYaw));
check("7 mouth bars", P.mouthBars.length === 7);
check("7 chest eq bars", P.eqBars.length === 7);
check("2 eyes", P.eyes.length === 2);
check("2 ear dials", P.ears.length === 2);
check("4 fingers per hand", P.arm[1].fingers.length === 4);
check("reactor rings", P.coreRings.length === 2);
check("halo registry populated", P.halos.length >= 5);

/* --- NaN scan ----------------------------------------------- */
const scanNaN = (label) => {
    let bad = null;
    robot.root.traverse((o) => {
        if (bad) return;
        const lists = [
            ["position", o.position], ["rotation", o.rotation], ["scale", o.scale]
        ];
        for (const [name, v] of lists) {
            if (Number.isNaN(v.x) || Number.isNaN(v.y) || Number.isNaN(v.z)) {
                bad = `${o.type}.${name}`;
            }
        }
    });
    check(`no NaN after ${label}`, !bad);
};

/* --- run every state ---------------------------------------- */
const frames = (n) => {
    for (let i = 0; i < n; i += 1) robot.update(1 / 60);
};

frames(60);
scanNaN("idle");

robot.setGazePoint(new THREE.Vector3(3, 3, 5));
robot.setState(ROBOT_STATE.LISTENING);
frames(60);
scanNaN("listening");

robot.setState(ROBOT_STATE.THINKING);
frames(60);
scanNaN("thinking");

robot.setState(ROBOT_STATE.TALKING);
for (let i = 0; i < 120; i += 1) {
    robot.pulseVoice(0.5 + Math.random() * 0.5);
    robot.update(1 / 60);
}
scanNaN("talking");

robot.playWave();
frames(Math.ceil(2.8 * 60) + 30);
check("wave finishes back to idle", robot.getState() === ROBOT_STATE.IDLE);

robot.playHappy();
frames(Math.ceil(2.2 * 60) + 30);
check("happy finishes back to idle", robot.getState() === ROBOT_STATE.IDLE);
scanNaN("happy");

/* walking: should travel to the target and stop */
robot.walkTo(1.4);
let guard = 0;
while (robot.getState() === ROBOT_STATE.WALKING && guard < 600) {
    robot.update(1 / 60);
    guard += 1;
}
check("walk reaches target", Math.abs(robot.root.position.x - 1.4) < 0.1);
check("walk terminates", robot.getState() === ROBOT_STATE.IDLE);
scanNaN("walking");

/* gaze helper with disabled value */
robot.setGazePoint(null);
frames(30);
scanNaN("gaze off");

/* telemetry sanity */
const tel = robot.getTelemetry();
check("telemetry servo in range", tel.servo >= 0 && tel.servo <= 1);
check("telemetry core in range", tel.core >= 0 && tel.core <= 1);
check("telemetry has state", typeof tel.state === "string");

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
