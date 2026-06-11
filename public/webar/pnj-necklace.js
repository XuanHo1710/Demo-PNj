// @ts-nocheck
/*
 * PNJ × WebAR.rocks.face — custom necklace virtual try-on.
 *
 * NOTE: this is a CLASSIC browser script served statically from /public (it is
 * NOT part of the Vite/ESM build). It depends on globals defined by the
 * WebAR.rocks scripts and Three.js r136 (`THREE`, `WebARRocksFaceThreeHelper`,
 * `WEBARROCKSFACE`, `WebARRocksLMStabilizer`), so editor type-checking is off.
 *
 * WebAR.rocks gives us the hard part: a real-time, metric 3D pose of the neck
 * (its NN_NECKLACE neural net + solvePnP). Everything about how the necklace
 * looks — the draping curve of the chain, how it scales to the neck, and where
 * the PNJ pendant hangs — is written here by hand, in the neck's own coordinate
 * space, so it tracks in full 3D (turn / tilt / lean) and is hidden behind the
 * neck by the occluder.
 *
 * Coordinate space (the faceFollower local frame): it is the torso.blend space
 * the neural net was trained in (≈ millimetres). After WebAR.rocks centres the
 * solvePnP points, the origin sits at the centroid of the tracked neck ring.
 *   +X = the person's LEFT  ·  +Y = up  ·  +Z = front (toward the camera/chin)
 * Because we author in that metric space, the necklace is automatically the
 * right real-world size on every neck — no per-frame scaling hacks needed.
 */
(function () {
    'use strict';

    // Absolute base URL of THIS script's folder (e.g. https://host/webar/). We load every
    // asset (neural net, envmap, occluder, catalog) through this ABSOLUTE base instead of a
    // relative path. Reason: on Vercel `cleanUrls` serves necklace.html as /webar/necklace
    // (or with a trailing slash), which shifts the base a RELATIVE XHR resolves against →
    // the NN request 404s → the SPA fallback returns index.html → "JSON.parse(<!doctype".
    // An absolute path is immune to that.
    const ASSET_BASE = (function () {
        const s = document.querySelector('script[src*="pnj-necklace.js"]');
        try { if (s) return new URL('.', s.src).href; } catch (e) { /* ignore */ }
        return new URL('webar/', location.origin + '/').href;
    })();

    // ---------------------------------------------------------------------------
    // Tunables — tweak these to restyle the chain/pendant. All in torso mm space.
    // ---------------------------------------------------------------------------
    const PARAMS = {
        CHAIN_GAP: 1.03,        // chain radius vs measured neck radius (>1 = rides just outside the skin)
        CHAIN_THICK: 1.15,      // chain tube radius (mm). Keep thin for a delicate look.
        CHAIN_SEGMENTS: 320,    // tube length segments (smoothness of the drape)
        CHAIN_RADIAL: 10,       // tube radial segments (roundness)
        FRONT_DRAPE: 44,        // extra downward sag at the front centre from the chain's weight (mm)
        LOOP_SAMPLES: 170,      // points sampled around the neck for the curve
        // The raw neck-side points sit HIGH (near the jaw). These pull the sides + nape DOWN
        // toward the front level so the chain rests on the neck/collar and its two ends tuck
        // in low, instead of shooting up beside the jaw and floating ("giả chân").
        SIDE_RAISE: 0.66,       // 0 = sides as low as the front (flat), 1 = up at the raw neck-top points
        BACK_RAISE: 0.74,       // how high the nape rides (it's hidden by the occluder anyway)
        // Lift the WHOLE necklace up the neck (+mm = higher). The tracked neck points sit a bit
        // low for a worn look, so this raises the entire loop so it grips higher on the neck.
        NECK_LIFT: 26,

        PENDANT_SIZE: 46,       // pendant width (mm); height follows the image aspect ratio
        PENDANT_GAP: 4,         // gap between the chain front point and the top of the pendant (mm)
        PENDANT_FWD: 6,         // push the pendant slightly forward of the chain so it never z-fights (mm)
        PENDANT_TILT: -0.12,    // small forward lean (rad) so the charm faces the camera a touch

        // --- Pendant PHYSICS (the "lắc qua lắc lại" secondary motion) -------------
        // The pendant hangs from the chain (its bail) and behaves like a real PENDULUM:
        // a spring-damper that chases a gravity-vertical target but LAGS behind your
        // motion, so it overshoots and swings, then settles. Driven by the actual neck
        // pose (nod / lean) + a head-shake impulse — no noisy derivatives.
        PHYS_ENABLED: true,
        PHYS_STIFFNESS: 120,    // spring constant → swing frequency (higher = snappier, faster return)
        PHYS_DAMPING: 6.0,      // damping (higher = settles faster / fewer wobbles; lower = swings more)
        GRAVITY_ROLL: 0.85,     // lean (roll) → how strongly the charm stays vertical (0..1). The pendulum.
        GRAVITY_PITCH: 0.55,    // nod (pitch) → forward/back hang response when you look up/down (0..1)
        YAW_SHAKE_KICK: 0.6,    // head-shake (yaw) → sideways swing impulse (the "lắc trái phải")
        SWING_MAX: 0.55,        // hard clamp on swing angle (rad, ~31°) so fast motion never looks broken

        TAA_LEVEL: 3,           // engine temporal anti-aliasing samples (0 = off). Demo uses 3.

        METAL_WHITE: 0xececed,  // white-gold / silver chain colour
        METAL_YELLOW: 0xf2cf7a, // yellow-gold chain colour
        CHAIN_ROUGHNESS: 0.26,
        CHAIN_METALNESS: 1.0,
        CHAIN_ENVINTENSITY: 1.15,

        // --- Soft-body chain — moves only WHEN YOU MOVE, then settles ------------
        // The chain holds its rest shape when you're still (no silly idle wobble) and only
        // ripples/swings from real motion: the world-space inertia term below fires ONLY when
        // the neck pose actually changes (move side-to-side, nod, lean), then the firm spring
        // + strong damping bring it back to rest fast. Gravity is small (just a little weight
        // feel + gentle lean-hang), so it never drifts on its own.
        SOFT_ENABLED: true,
        SOFT_NODES: 34,         // simulation nodes around the loop (more = smoother wave, heavier)
        SOFT_TUBE_SEGMENTS: 150,// tube length segments rebuilt each frame from the nodes
        SOFT_GRAVITY: 130,      // gentle weight + lean-hang only — LOW so it doesn't move on its own
        SOFT_STIFFNESS: 78,     // firm pull back to the rest shape → holds still / settles fast
        SOFT_NEIGHBOR: 50,      // wave coupling between neighbours → ripples travel along the chain
        SOFT_DAMPING: 0.7,      // velocity retention 0..1 (LOW → motion dies fast, no constant wobble)
        SOFT_PIN_STRENGTH: 12,  // how hard the back/sides are held to the neck (front stays free to ripple)
        SOFT_MAX_DEV: 7,        // max a node may stray from rest (mm) → keeps the ripple TINY, never wild
        SOFT_MOTION_DEADZONE: 3.6, // only a BIG move (mm/frame) ripples the chain; phone jitter = dead still
        // Only the FRONT arc swings; the sides + nape stay PINNED to the neck so the chain
        // grips both sides and the back like a real necklace (cos(theta) above this = free).
        // 1=only the very front free, 0=half the loop free. ~0.3 → front ~±72° drapes, rest hugs.
        SOFT_FRONT_PIN: 0.3,

        // --- End fade — dissolve the two side ends into the neck ------------------
        // A depth-based alpha fade: chain vertices toward the BACK (lower local z) fade to
        // invisible, so where the chain curves behind the neck it vanishes smoothly instead
        // of ending in a hard floating tip ("giả chân"). Works with the depth occluder.
        FADE_ENABLED: true,
        FADE_START_FRAC: 0.74, // begin fading this far back (0 = front, 1 = back) — only the nape fades
        FADE_END_FRAC: 0.95,    // fully invisible this far back → the very ends disappear into the neck

        // --- Yaw side-hide — DISABLED ---------------------------------------------
        // This faded the far strand on a head turn, but it kept making the necklace look
        // ASYMMETRIC facing straight (any tiny yaw bias fades one side) and ate the neck
        // wrap. The depth occluder already hides the back symmetrically + correctly in 3D,
        // which is the realistic look. Left here (off) so it can be re-enabled if ever fixed.
        YAW_HIDE_ENABLED: false,
        YAW_HIDE_START: 0.34,   // start hiding the far strand at this turn from neutral (rad, ~19°)
        YAW_HIDE_END: 0.78,     // far strand fully faded by this turn (rad, ~45°)
        YAW_HIDE_MAX: 0.92,     // max alpha removed (0..1) — <1 so a faded strand is a faint ghost, never a screen-wide blank
        YAW_FRONT_PROTECT: 0.4, // front fraction of the loop that NEVER yaw-fades (keeps the pendant + front drape)
        YAW_REST_ADAPT: 0.03,   // how fast the neutral-yaw baseline self-calibrates (0..1, small = slow)
        YAW_HIDE_SIGN: 1,       // flip to -1 if the WRONG side hides on turn

        // Neck occluder — an invisible depth-only cylinder shaped to the neck. It HIDES the
        // chain where it wraps BEHIND the neck, so the two ends tuck behind it instead of
        // floating ("giả chân"). The front + sides stick out past it and stay visible.
        OCCLUDER_ENABLED: true,
        OCCLUDER_SCALE: 0.9,    // occluder radius vs chain radius (smaller → shows more sides, larger → hides more)
        OCCLUDER_PUSH: 18,      // push the occluder BACK (mm) so it never eats the front chain / pendant
        OCCLUDER_HEIGHT: 260,   // occluder cylinder height (mm) — tall enough to cover the whole neck

        // 3D pose FOLLOW — how much the necklace rotates with you on each axis. The
        // WebAR.rocks demo damped these (yaw 0.3 / roll 0.5) for a rigid pendant model,
        // but our necklace is a full 360° loop hidden behind a neck occluder, so we let it
        // follow you closely for a real feel: lean → it leans, turn → the loop turns with you.
        ROT_PITCH: 1.0,  // nod up/down   (X) — full
        ROT_YAW: 0.7,    // turn L/R      (Y) — turns the 360° loop with the head/neck
        ROT_ROLL: 1.0    // lean sideways (Z) — necklace leans with you (the main "nghiêng theo" fix)
    };

    // Neck reference points in the RAW torso.blend space (identical to the values
    // WebAR.rocks ships for NN_NECKLACE_9). We derive the chain shape from these so
    // it follows the real tracked neckline instead of arbitrary magic numbers.
    const NECK_RAW = {
        centerUp: [0.000006, -78.167770, 33.542694],
        centerDown: [0.000004, -112.370636, 44.173981],
        leftUp: [77.729225, -1.220459, -42.653336],
        leftDown: [130.661072, -11.937241, -44.706360],
        rightUp: [-77.898209, -1.191437, -42.648613],
        rightDown: [-130.661041, -11.937241, -44.706360],
        backUp: [-0.040026, -11.528961, -99.635696],
        backDown: [0.000007, -47.934677, -127.748184]
    };
    // Every neck point WebAR.rocks can predict, in the torso.blend frame.
    const SOLVEPNP_OBJPOINTS = {
        torsoNeckCenterUp: NECK_RAW.centerUp,
        torsoNeckCenterDown: NECK_RAW.centerDown,
        torsoNeckLeftUp: NECK_RAW.leftUp,
        torsoNeckLeftDown: NECK_RAW.leftDown,
        torsoNeckRightUp: NECK_RAW.rightUp,
        torsoNeckRightDown: NECK_RAW.rightDown,
        torsoNeckBackUp: NECK_RAW.backUp,
        torsoNeckBackDown: NECK_RAW.backDown
    };

    // ---------------------------------------------------------------------------
    // Multi-neural-net accuracy system — use ALL the vendored NN_NECKLACE nets.
    //
    // The nets fall into two families:
    //   • NN_NECKLACE_1..4 predict 8 neck points (they ADD the lower left/right
    //     neck points). More solvePnP correspondences = a more constrained, stable
    //     pose — the lower points pin the vertical drop & scale, which is exactly
    //     what a necklace needs.
    //   • NN_NECKLACE_6..9 predict 6 points. NN_9 is the newest / best-balanced
    //     (the official demo default); 7 & 8 are the heaviest (7 MB) = most detail.
    //
    // We feed solvePnP EXACTLY the points the active net provides, and we centre the
    // necklace geometry by the SAME label set (WebAR.rocks centres objPoints by the
    // mean of the used labels), so the overlay stays pixel-aligned for either family.
    // ---------------------------------------------------------------------------
    const IMGPOINTS_8 = [
        'torsoNeckCenterUp', 'torsoNeckLeftUp', 'torsoNeckRightUp', 'torsoNeckBackUp',
        'torsoNeckCenterDown', 'torsoNeckLeftDown', 'torsoNeckRightDown', 'torsoNeckBackDown'
    ];
    const IMGPOINTS_6 = [
        'torsoNeckCenterUp', 'torsoNeckLeftUp', 'torsoNeckRightUp',
        'torsoNeckBackUp', 'torsoNeckCenterDown', 'torsoNeckBackDown'
    ];

    // `points` → which solvePnP set; `filter` → stabilizer forceFilterNNInputPxRange
    // tuned per net; `label` → precision-button text.
    // NOTE: only NN_NECKLACE_9.json ships in this build (the most accurate neck-grip net,
    // the official demo default). The other necklace nets were removed, so the registry +
    // ladder are locked to '9'. A stale ?nn=N for a missing net falls back to '9' (no 404).
    const NN_REGISTRY = {
        '9': { path: 'neuralNets/NN_NECKLACE_9.json', points: 6, filter: [8, 16], threshold: 0.7, label: 'Cân bằng' }
    };
    // Single net → the ladder has one entry and the precision button is hidden.
    const NN_LADDER = ['9'];
    const NN_DEFAULT = '9';

    function resolveNNKey() {
        // NN_NECKLACE_9 is the most accurate neck-grip net, so it is the authoritative boot
        // net. Only an explicit ?nn=N url param overrides it (for power testing); we do NOT
        // restore a stale saved choice, so a normal load always grips with NN_9.
        try {
            const u = new URLSearchParams(location.search).get('nn');
            if (u && NN_REGISTRY[u]) return u;
            localStorage.removeItem('pnjNeckNN'); // clear any old override so 9 stays default
        } catch (e) { /* storage blocked */ }
        return NN_DEFAULT;
    }

    let ACTIVE_NN_KEY = resolveNNKey();
    // The solvePnP label set for the active net (drives both PnP and geometry centring).
    let ACTIVE_IMGPOINTS = NN_REGISTRY[ACTIVE_NN_KEY].points === 8 ? IMGPOINTS_8 : IMGPOINTS_6;

    // ---------------------------------------------------------------------------
    // Derive the neck ellipse + draping Y profile from the (centred) reference pts.
    // WebAR.rocks centres objPoints by the mean of the USED labels, so we do the
    // same here and author the necklace in that centred frame → perfect alignment.
    // ---------------------------------------------------------------------------
    function buildNeckModel() {
        // Centre by the SAME labels we feed to solvePnP so our origin matches the
        // engine's centred objPoints exactly (6-point and 8-point nets centre differently).
        const usedLabels = ACTIVE_IMGPOINTS;
        const mean = [0, 0, 0];
        usedLabels.forEach(function (label) {
            const p = SOLVEPNP_OBJPOINTS[label];
            mean[0] += p[0]; mean[1] += p[1]; mean[2] += p[2];
        });
        mean[0] /= usedLabels.length; mean[1] /= usedLabels.length; mean[2] /= usedLabels.length;

        const center = function (raw) {
            return { x: raw[0] - mean[0], y: raw[1] - mean[1], z: raw[2] - mean[2] };
        };
        const L = center(NECK_RAW.leftUp);
        const R = center(NECK_RAW.rightUp);
        const F = center(NECK_RAW.centerUp);
        const Fd = center(NECK_RAW.centerDown);
        const B = center(NECK_RAW.backUp);

        const radiusX = Math.abs(L.x - R.x) / 2 * PARAMS.CHAIN_GAP;
        const centerX = (L.x + R.x) / 2;
        const radiusZ = Math.abs(F.z - B.z) / 2 * PARAMS.CHAIN_GAP;
        const centerZ = (F.z + B.z) / 2;

        // Y around the loop as a quadratic in c = cos(theta):
        //   theta = 0   -> front (c= 1) -> yFront : the drape, low on the chest
        //   theta = ±90 -> sides (c= 0) -> ySide  : where the chain rests on the neck sides
        //   theta = 180 -> back  (c=-1) -> yBack  : the nape, hidden by the occluder
        // The raw neck-side points sit high (near the jaw), so SIDE_RAISE / BACK_RAISE pull
        // the sides and nape DOWN toward the front level — the chain then rests on the neck
        // instead of shooting up beside the jaw (which looked fake + floating).
        const yFront = (F.y + Fd.y) / 2 - PARAMS.FRONT_DRAPE + PARAMS.NECK_LIFT;
        const ySideRaw = (L.y + R.y) / 2;
        const ySide = yFront + (ySideRaw + PARAMS.NECK_LIFT - yFront) * PARAMS.SIDE_RAISE;
        const yBack = yFront + (B.y + PARAMS.NECK_LIFT - yFront) * PARAMS.BACK_RAISE;
        const yb = (yFront - yBack) / 2;
        const yd = (yFront + yBack) / 2 - ySide;
        const yOf = function (cosT) { return ySide + yb * cosT + yd * cosT * cosT; };
        const centerY = (yFront + Math.max(ySide, yBack)) / 2; // occluder vertical centre

        return {
            centerX: centerX, centerY: centerY, centerZ: centerZ,
            radiusX: radiusX, radiusZ: radiusZ, yOf: yOf,
            yFront: yFront, ySide: ySide, yBack: yBack
        };
    }

    // ---------------------------------------------------------------------------
    // Three.js objects we keep handles to so we can restyle on product change.
    // ---------------------------------------------------------------------------
    const REFS = {
        helper: null,
        scene: null,
        renderer: null,
        loadingManager: null,
        follower: null,       // faceFollower[0] — driven by the neck pose each frame
        necklaceGroup: null,
        neckOccluder: null,   // invisible depth cylinder that hides the wrap-behind ends
        chainMesh: null,
        chainMat: null,
        chainShader: null,    // captured onBeforeCompile shader → lets us update uYaw each frame
        // soft-body chain (verlet rope) state — preallocated, simulated each frame:
        softRest: null, softCur: null, softPrev: null, softFreedom: null, softCurve: null,
        softDown: null, softInvQuat: null,
        // world matrices so the rope inertia is measured in WORLD space (→ it lags head motion):
        softMatCur: null, softMatInv: null, softMatPrev: null, softMatT: null, softProbe: null, softInit: false,
        pendantPivot: null,   // Object3D at the bail point; physics rotates THIS (pendulum)
        pendantMesh: null,    // the product image plane, hung below the pivot
        pendantMat: null,
        neck: null,           // result of buildNeckModel()
        envMap: null,
        // preallocated for the per-frame physics (no GC churn):
        physMat: null, physQuat: null, physEuler: null, physPos: null, physScale: null
    };
    const STATE = { product: null, catalog: [], booted: false };
    // Pendant pendulum physics state (swing angle + angular velocity per axis).
    const PHYS = { init: false, t: 0, yaw: 0, pitch: 0, roll: 0, sx: 0, vx: 0, sz: 0, vz: 0, yawRest: 0, yawRestInit: false };
    const texLoader = new THREE.TextureLoader();

    function smoothstep01(t) {
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        return t * t * (3 - 2 * t);
    }

    // Depth-based alpha fade injected into the chain's MeshStandardMaterial: chain
    // vertices toward the BACK (lower local z) fade to invisible, so the two side ends
    // dissolve into the neck instead of ending in a hard floating tip. Same proven
    // onBeforeCompile pattern WebAR.rocks uses to fade glasses temples.
    function applyChainFade(mat, zStart, zEnd, zProtect0, zProtect1) {
        mat.transparent = true;
        mat.depthWrite = true; // thin metal still reads solid; faded ends sit behind the occluder
        mat.onBeforeCompile = function (sh) {
            sh.uniforms.uFadeZ = { value: new THREE.Vector2(zStart, zEnd) };
            // uYaw = live signed turn-from-neutral (rad); uYawFade = (start,end,maxAlphaRemoved).
            // uYawProtect = the z range of the FRONT that never yaw-fades (keeps the pendant).
            sh.uniforms.uYaw = { value: 0 };
            sh.uniforms.uYawFade = { value: new THREE.Vector3(PARAMS.YAW_HIDE_START, PARAMS.YAW_HIDE_END, PARAMS.YAW_HIDE_MAX) };
            sh.uniforms.uYawProtect = { value: new THREE.Vector2(zProtect0, zProtect1) };
            REFS.chainShader = sh; // keep a handle so onTrack can update uYaw every frame
            sh.vertexShader = 'varying float vChainZ;\nvarying float vChainX;\n' + sh.vertexShader.replace(
                '#include <begin_vertex>',
                '#include <begin_vertex>\n  vChainZ = position.z;\n  vChainX = position.x;'
            );
            sh.fragmentShader =
                'uniform vec2 uFadeZ;\nuniform float uYaw;\nuniform vec3 uYawFade;\nuniform vec2 uYawProtect;\nvarying float vChainZ;\nvarying float vChainX;\n' +
                sh.fragmentShader.replace(
                    '#include <dithering_fragment>',
                    '#include <dithering_fragment>\n' +
                    // 1) back-of-neck fade (the nape ends always dissolve)
                    '  gl_FragColor.a *= smoothstep(uFadeZ.y, uFadeZ.x, vChainZ);\n' +
                    // 2) yaw side-hide: only the side whose sign matches the turn (recede>0),
                    //    only BEHIND the front-protect zone, and capped so it never fully blanks.
                    '  float recede = uYaw * sign(vChainX);\n' +
                    '  float byYaw = smoothstep(uYawFade.x, uYawFade.y, recede);\n' +
                    '  float notFront = 1.0 - smoothstep(uYawProtect.x, uYawProtect.y, vChainZ);\n' +
                    '  gl_FragColor.a *= 1.0 - uYawFade.z * byYaw * notFront;'
                );
        };
    }

    // Per-frame soft-body chain step (verlet rope) — runs in WORLD space so the rope has
    // real inertia: each node remembers where it was in the WORLD last frame, so when your
    // head/neck moves the nodes LAG behind and ripple (the "liquid / 3D model" motion). It
    // also sags under true world-gravity, springs toward its rest shape (soft at the free
    // front, stiff at the pinned back) and passes waves to its neighbours. A deviation clamp
    // guarantees it can never explode/detach.
    function simulateChain(dt) {
        const cur = REFS.softCur, prev = REFS.softPrev, rest = REFS.softRest, free = REFS.softFreedom;
        if (!cur || !REFS.necklaceGroup) return;
        const n = cur.length;

        // local(node) → world matrix for the chain (necklaceGroup space). onTrack runs after
        // the engine's render so matrices are current; refresh once more to be safe.
        REFS.necklaceGroup.updateWorldMatrix(true, false);
        REFS.softMatCur.copy(REFS.necklaceGroup.matrixWorld);
        REFS.softMatInv.copy(REFS.softMatCur).invert();

        if (!REFS.softInit) { // first frame: seed prev = cur, no motion yet
            REFS.softInit = true;
            REFS.softMatPrev.copy(REFS.softMatCur);
            for (let i = 0; i < n; i++) prev[i].copy(cur[i]);
            return;
        }

        // T re-expresses last frame's LOCAL positions into THIS frame's local space *through
        // world space*. If the head moved, a rigid point's old world spot now maps to a
        // different local spot → (cur − prev) becomes the world velocity → inertia + lag.
        const T = REFS.softMatT.multiplyMatrices(REFS.softMatInv, REFS.softMatPrev);

        // MOTION DEADZONE — the chain should move only when YOU move, not jitter on its own.
        // Probe how far this frame's pose actually moved a front-radius point; if it's below
        // the deadzone (= tracking jitter while you hold still), treat the pose as UNCHANGED
        // (skip the inertia re-projection) so a still head leaves the chain still.
        const poseMove = REFS.softProbe.copy(rest[0]).applyMatrix4(T).distanceTo(rest[0]);
        const poseMoved = poseMove >= PARAMS.SOFT_MOTION_DEADZONE;

        // true world-down expressed in chain-local space (so lean/tilt makes it sag sideways):
        const down = REFS.softDown.set(0, -1, 0).transformDirection(REFS.softMatInv);

        const g = PARAMS.SOFT_GRAVITY, ks = PARAMS.SOFT_STIFFNESS, kn = PARAMS.SOFT_NEIGHBOR;
        const damp = PARAMS.SOFT_DAMPING, pin = PARAMS.SOFT_PIN_STRENGTH, dev = PARAMS.SOFT_MAX_DEV;
        const h2 = dt * dt;

        for (let i = 0; i < n; i++) {
            const f = free[i];
            const ci = cur[i], pi = prev[i], ri = rest[i];
            if (f <= 0.02) { ci.copy(ri); pi.copy(ri); continue; } // hard-pinned to the neck
            if (poseMoved) pi.applyMatrix4(T); // re-express last position in the current frame (inertia)
            const L = cur[(i - 1 + n) % n], R = cur[(i + 1) % n];
            const kRest = ks * (1 + (1 - f) * pin);
            const ax = (ri.x - ci.x) * kRest + down.x * g * f + kn * ((L.x + R.x) * 0.5 - ci.x);
            const ay = (ri.y - ci.y) * kRest + down.y * g * f + kn * ((L.y + R.y) * 0.5 - ci.y);
            const az = (ri.z - ci.z) * kRest + down.z * g * f + kn * ((L.z + R.z) * 0.5 - ci.z);
            const vx = (ci.x - pi.x) * damp + ax * h2;
            const vy = (ci.y - pi.y) * damp + ay * h2;
            const vz = (ci.z - pi.z) * damp + az * h2;
            pi.copy(ci); // store current as prev (in current local space) for next frame
            ci.x += vx; ci.y += vy; ci.z += vz;
            // clamp deviation from rest so a violent motion can never detach/explode the rope
            const dx = ci.x - ri.x, dy = ci.y - ri.y, dz = ci.z - ri.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > dev * dev) {
                const k = dev / Math.sqrt(d2);
                ci.x = ri.x + dx * k; ci.y = ri.y + dy * k; ci.z = ri.z + dz * k;
            }
        }
        REFS.softMatPrev.copy(REFS.softMatCur);

        // Keep the pendant bail glued to the LIVE front node (node 0 = front-centre), so the
        // charm always hangs from where the chain ACTUALLY is after it sags/ripples — not the
        // static rest point (that mismatch was why the centre looked disconnected).
        if (REFS.pendantPivot) {
            const f0 = cur[0];
            REFS.pendantPivot.position.set(f0.x, f0.y - PARAMS.PENDANT_GAP, f0.z + PARAMS.PENDANT_FWD);
        }

        // rebuild the tube from the simulated nodes (the curve shares the softCur array)
        REFS.chainMesh.geometry.dispose();
        REFS.chainMesh.geometry = new THREE.TubeGeometry(
            REFS.softCurve, PARAMS.SOFT_TUBE_SEGMENTS, PARAMS.CHAIN_THICK, PARAMS.CHAIN_RADIAL, true
        );
    }

    // ---------------------------------------------------------------------------
    // Build the necklace: a draping chain tube + a textured pendant plane.
    // ---------------------------------------------------------------------------
    function buildNecklace() {
        const neck = REFS.neck;
        const group = new THREE.Object3D();

        // --- Chain: a SOFT-BODY rope around the neck. We sample the rest loop, then (if
        //     SOFT_ENABLED) simulate it as a verlet rope each frame so it ripples / sways
        //     like a real flexible necklace. A depth-based alpha fade dissolves the two side
        //     ends into the neck so they never end in a hard floating tip ("giả chân").
        const nodeCount = PARAMS.SOFT_ENABLED ? PARAMS.SOFT_NODES : PARAMS.LOOP_SAMPLES;
        const rest = [], cur = [], prev = [], freedom = [];
        let zMin = Infinity, zMax = -Infinity;
        for (let i = 0; i < nodeCount; i++) {
            const t = (i / nodeCount) * Math.PI * 2;
            const c = Math.cos(t), s = Math.sin(t);
            const x = neck.centerX + s * neck.radiusX;
            const z = neck.centerZ + c * neck.radiusZ;
            const y = neck.yOf(c);
            rest.push(new THREE.Vector3(x, y, z));
            cur.push(new THREE.Vector3(x, y, z));
            prev.push(new THREE.Vector3(x, y, z));
            // Only the FRONT arc (cosθ above SOFT_FRONT_PIN) is free to drape/ripple; the
            // sides + nape stay pinned to the neck so the chain grips both sides and the back.
            freedom.push(smoothstep01((c - PARAMS.SOFT_FRONT_PIN) / (1 - PARAMS.SOFT_FRONT_PIN)));
            if (z < zMin) zMin = z;
            if (z > zMax) zMax = z;
        }
        REFS.softRest = rest; REFS.softCur = cur; REFS.softPrev = prev; REFS.softFreedom = freedom;
        REFS.softCurve = new THREE.CatmullRomCurve3(cur, true, 'catmullrom', 0.5);

        REFS.chainMat = new THREE.MeshStandardMaterial({
            color: PARAMS.METAL_WHITE,
            metalness: PARAMS.CHAIN_METALNESS,
            roughness: PARAMS.CHAIN_ROUGHNESS,
            envMapIntensity: PARAMS.CHAIN_ENVINTENSITY
        });
        if (PARAMS.FADE_ENABLED) {
            const span = (zMax - zMin) || 1;
            // front-protect zone for the yaw-hide: the front YAW_FRONT_PROTECT of the z span
            // never fades (keeps the pendant + front drape visible on a head turn).
            const zp0 = zMax - span * (PARAMS.YAW_FRONT_PROTECT + 0.12);
            const zp1 = zMax - span * PARAMS.YAW_FRONT_PROTECT;
            applyChainFade(
                REFS.chainMat,
                zMax - span * PARAMS.FADE_START_FRAC, zMax - span * PARAMS.FADE_END_FRAC,
                zp0, zp1
            );
        }
        REFS.chainMesh = new THREE.Mesh(
            new THREE.TubeGeometry(REFS.softCurve, PARAMS.SOFT_TUBE_SEGMENTS, PARAMS.CHAIN_THICK, PARAMS.CHAIN_RADIAL, true),
            REFS.chainMat
        );
        REFS.chainMesh.renderOrder = 10;
        REFS.chainMesh.frustumCulled = false; // geometry is rebuilt each frame
        group.add(REFS.chainMesh);

        // --- Pendant: the PNJ product image, hung from a PIVOT so it swings like a
        //     pendulum (the pivot sits at the bail / chain-front; the plane hangs below
        //     it, so rotating the pivot swings the charm from its top, not its centre).
        REFS.pendantMat = new THREE.MeshStandardMaterial({
            transparent: true,
            alphaTest: 0.45,
            side: THREE.DoubleSide,
            metalness: 0.0,
            roughness: 0.85,
            envMapIntensity: 0.25
        });
        REFS.pendantPivot = new THREE.Object3D();
        REFS.pendantMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), REFS.pendantMat);
        REFS.pendantMesh.renderOrder = 11;
        REFS.pendantPivot.add(REFS.pendantMesh);
        REFS.pendantPivot.visible = false; // shown once a texture is loaded
        group.add(REFS.pendantPivot);

        REFS.necklaceGroup = group;
        REFS.follower.add(group);
        buildNeckOccluder();
    }

    // An invisible neck occluder: a depth-only elliptic cylinder shaped to the neck. The
    // chain that wraps BEHIND the neck fails the depth test against it and is hidden, so the
    // two ends tuck behind the neck instead of floating in front ("giả chân"). The front +
    // sides stick out past it and stay visible → it reads as truly worn around the neck.
    // It's a child of the necklace group, so it tilts/turns with the head pose.
    function buildNeckOccluder() {
        if (!PARAMS.OCCLUDER_ENABLED || !REFS.neck || !REFS.necklaceGroup) return;
        const neck = REFS.neck;
        const geo = new THREE.CylinderGeometry(1, 1, 1, 40, 1, true); // unit, open-ended
        const mat = new THREE.MeshBasicMaterial({ colorWrite: false }); // writes DEPTH only, no colour
        const occ = new THREE.Mesh(geo, mat);
        occ.renderOrder = -10000; // lay down depth before the chain (renderOrder 10) draws
        occ.scale.set(
            neck.radiusX * PARAMS.OCCLUDER_SCALE,
            PARAMS.OCCLUDER_HEIGHT,
            neck.radiusZ * PARAMS.OCCLUDER_SCALE
        );
        // push it BACK in Z so it hides the nape/back but never the front chain or pendant
        occ.position.set(neck.centerX, neck.centerY, neck.centerZ - PARAMS.OCCLUDER_PUSH);
        REFS.necklaceGroup.add(occ);
        REFS.neckOccluder = occ;
    }

    // Position the pivot at the bail (chain front) and hang the sized plane below it.
    function layoutPendant(aspect) {
        const neck = REFS.neck;
        const w = PARAMS.PENDANT_SIZE;
        const h = w / (aspect || 1);
        REFS.pendantMesh.geometry.dispose();
        REFS.pendantMesh.geometry = new THREE.PlaneGeometry(w, h);

        const frontX = neck.centerX;
        const frontZ = neck.centerZ + neck.radiusZ;
        const topY = neck.yFront - PARAMS.PENDANT_GAP; // chain front, minus a small gap to the bail
        // pivot at the bail; plane hangs h/2 below it so it swings from the top
        REFS.pendantPivot.position.set(frontX, topY, frontZ + PARAMS.PENDANT_FWD);
        REFS.pendantPivot.rotation.set(PARAMS.PENDANT_TILT, 0, 0);
        REFS.pendantMesh.position.set(0, -h / 2, 0);
        REFS.pendantMesh.rotation.set(0, 0, 0);
    }

    function setMetal(metal) {
        if (!REFS.chainMat) return;
        REFS.chainMat.color.setHex(metal === 'yellow' ? PARAMS.METAL_YELLOW : PARAMS.METAL_WHITE);
        REFS.chainMat.needsUpdate = true;
    }

    function setProduct(item) {
        STATE.product = item;
        setMetal(item.metal);
        updateInfo(item);
        highlightThumb(item.id);

        texLoader.load(item.image, function (tex) {
            tex.encoding = THREE.sRGBEncoding;
            tex.anisotropy = 4;
            const img = tex.image;
            const aspect = (img && img.width && img.height) ? (img.width / img.height) : 1;
            if (REFS.pendantMat.map) REFS.pendantMat.map.dispose();
            REFS.pendantMat.map = tex;
            REFS.pendantMat.needsUpdate = true;
            layoutPendant(aspect);
            REFS.pendantPivot.visible = true;
        });
    }

    // ---------------------------------------------------------------------------
    // Scene dressing (lighting + envmap + occluder), then build the necklace.
    // ---------------------------------------------------------------------------
    function onReady(err, sceneObjects) {
        if (err) {
            // A heavy net (7 MB) can fail to load / OOM on a weak phone. Fall back to the
            // proven default net (NN_9) ONCE (guarded so we never loop), then surface the error.
            if (ACTIVE_NN_KEY !== NN_DEFAULT && !sessionStorage.getItem('pnjNNFellBack')) {
                try { sessionStorage.setItem('pnjNNFellBack', '1'); } catch (e) { /* ignore */ }
                const url = new URL(location.href);
                url.searchParams.delete('nn'); // drop the override → boots back on NN_9
                location.assign(url.toString());
                return;
            }
            showError('Tracking engine failed to start: ' + err);
            return;
        }
        sessionStorage.removeItem('pnjNNFellBack'); // success → clear the one-shot guard
        REFS.scene = sceneObjects.threeScene;
        REFS.renderer = sceneObjects.threeRenderer;
        REFS.follower = sceneObjects.threeFaceFollowers[0];
        // preallocate the per-frame physics temporaries (reused each frame, no GC):
        REFS.physMat = new THREE.Matrix4();
        REFS.physQuat = new THREE.Quaternion();
        REFS.physEuler = new THREE.Euler();
        REFS.physPos = new THREE.Vector3();
        REFS.physScale = new THREE.Vector3();
        REFS.softDown = new THREE.Vector3();      // world-down transformed into chain-local space
        REFS.softInvQuat = new THREE.Quaternion(); // inverse neck rotation (for soft-body gravity)
        REFS.softMatCur = new THREE.Matrix4();
        REFS.softMatInv = new THREE.Matrix4();
        REFS.softMatPrev = new THREE.Matrix4();
        REFS.softMatT = new THREE.Matrix4();
        REFS.softProbe = new THREE.Vector3();

        // nicer tone mapping (matches the WebAR.rocks mirror helper):
        REFS.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        REFS.renderer.outputEncoding = THREE.sRGBEncoding;

        // soft lights so metal reads well even before the envmap loads:
        REFS.scene.add(new THREE.HemisphereLight(0xffffff, 0x202028, 0.55));
        const key = new THREE.PointLight(0xffffff, 0.85);
        key.position.set(0, 220, 260);
        REFS.scene.add(key);

        // environment map → realistic gold/diamond reflections:
        const pmrem = new THREE.PMREMGenerator(REFS.renderer);
        pmrem.compileEquirectangularShader();
        new THREE.RGBELoader().setDataType(THREE.HalfFloatType).load(ASSET_BASE + 'assets/envmaps/venice_sunset_1k.hdr', function (hdr) {
            REFS.envMap = pmrem.fromEquirectangular(hdr).texture;
            REFS.scene.environment = REFS.envMap;
            pmrem.dispose();
        });

        // occluder = invisible head/neck that hides the part of the chain behind the neck.
        // IMPORTANT: pass a real LoadingManager — the helper does `new GLTFLoader(manager)` and
        // GLTFLoader.load() calls `manager.itemStart()`, so a null manager throws.
        REFS.loadingManager = new THREE.LoadingManager();
        REFS.helper.add_occluderFromFile(ASSET_BASE + 'assets/models3D/occluder.glb', null, REFS.loadingManager, false);

        // build the necklace geometry and attach it to the neck follower:
        REFS.neck = buildNeckModel();
        buildNecklace();

        // Now that the camera is live we know its REAL frame aspect — relayout the
        // canvases to "contain" that exact aspect (kills any residual zoom from the
        // 16:9 default guess) and tell the engine to re-fit the GL viewport + camera.
        const vw = REFS.helper.get_sourceWidth ? REFS.helper.get_sourceWidth() : 0;
        const vh = REFS.helper.get_sourceHeight ? REFS.helper.get_sourceHeight() : 0;
        if (vw && vh) {
            _videoAspect = vw / vh;
            const b = layoutCanvases(_videoAspect);
            REFS.helper.resize(b.w, b.h);
        }

        STATE.booted = true;
        hideBoot();
        if (STATE.product) setProduct(STATE.product);
    }

    // ---------------------------------------------------------------------------
    // Canvas sizing — "contain" the camera frame (NO zoom crop).
    //
    // We drive the engine via the Three helper directly (not the Mirror wrapper),
    // so WE own the canvas sizing. The engine draws the video to FILL ("cover") the
    // canvas, which zooms/crops hard when the canvas aspect ≠ video aspect (that was
    // the "phóng to" bug on portrait phones). Fix: size the canvas to the VIDEO's
    // aspect and letterbox it into the screen (centered via CSS) — then cover == no
    // crop, so the full wide camera frame shows, sharp and un-zoomed. This matches
    // the main app's `#camera { object-fit: contain }`.
    // ---------------------------------------------------------------------------
    const DEFAULT_VIDEO_ASPECT = 16 / 9; // landscape capture; corrected once the camera is live
    let _videoAspect = DEFAULT_VIDEO_ASPECT;

    function layoutCanvases(aspect) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap dpr → keep mobile FPS up
        const sw = window.innerWidth;
        const sh = window.innerHeight;
        let cssW, cssH;
        if (aspect > sw / sh) {
            cssW = sw;                       // video wider than screen → fit width, letterbox top/bottom
            cssH = Math.round(sw / aspect);
        } else {
            cssH = sh;                       // fit height, letterbox left/right
            cssW = Math.round(sh * aspect);
        }
        const buf = { w: Math.max(2, Math.round(cssW * dpr)), h: Math.max(2, Math.round(cssH * dpr)) };
        ['WebARRocksFaceCanvas', 'threeCanvas'].forEach(function (id) {
            const cv = document.getElementById(id);
            if (!cv) return;
            cv.style.width = cssW + 'px';
            cv.style.height = cssH + 'px';
            cv.width = buf.w;   // engine reads these as the render resolution
            cv.height = buf.h;
        });
        return buf;
    }

    // Always request a LANDSCAPE frame: phone front sensors are landscape-native, so a
    // landscape request returns the FULL sensor FoV (wide). Requesting portrait makes
    // the browser center-crop the sensor → zoomed in. 1280×720 is sharp but light.
    function videoSettings() {
        return { facingMode: 'user', idealWidth: 1280, idealHeight: 720 };
    }

    function startTracking() {
        REFS.helper = WebARRocksFaceThreeHelper;
        layoutCanvases(_videoAspect); // MUST run before init() so the engine adopts the resolution
        const nn = NN_REGISTRY[ACTIVE_NN_KEY];
        console.log('[PNJ necklace] using', nn.path, '(' + nn.points + ' points, ' + nn.label + ')');
        REFS.helper.init({
            spec: {
                NNCPath: ASSET_BASE + nn.path,
                scanSettings: { threshold: nn.threshold },
                videoSettings: videoSettings()
            },
            canvas: document.getElementById('WebARRocksFaceCanvas'),
            canvasThree: document.getElementById('threeCanvas'),
            solvePnPObjPointsPositions: SOLVEPNP_OBJPOINTS,
            // feed solvePnP every point the active net predicts → max pose constraints
            solvePnPImgPointsLabels: ACTIVE_IMGPOINTS,
            // per-net tuned landmark stabilizer (smoothness vs lag)
            landmarksStabilizerSpec: { beta: 5, forceFilterNNInputPxRange: nn.filter },
            // let the necklace follow your full 3D head/neck rotation (lean / turn / nod)
            rotationContraints: {
                order: 'YXZ',
                rotXFactor: PARAMS.ROT_PITCH,
                rotYFactor: PARAMS.ROT_YAW,
                rotZFactor: PARAMS.ROT_ROLL
            },
            // engine-side temporal anti-aliasing → crisp chain/diamond edges (same as the
            // WebAR.rocks VTONecklace demo). Needs the postprocessing scripts in the HTML.
            taaLevel: PARAMS.TAA_LEVEL,
            callbackReady: onReady,
            // per-frame hook → drive the pendant pendulum physics
            callbackTrack: onTrack
        });
    }

    // Per-frame PHYSICS — soft-body chain ripple + pendant pendulum swing. Both are driven
    // by the live neck pose so the necklace moves like a real 3D model: nod → it sways
    // forward/back, lean & head-shake → it ripples and swings side to side, then settles.
    function onTrack() {
        if (!REFS.follower) return;
        const parent = REFS.follower.parent; // faceFollowerParent: a direct child of the scene,
        if (!parent || !parent.visible) return; //   so parent.matrix IS its world matrix.

        // Decompose the live neck pose → yaw / pitch / roll (radians) + quaternion.
        REFS.physMat.copy(parent.matrix);
        REFS.physMat.decompose(REFS.physPos, REFS.physQuat, REFS.physScale);
        REFS.physEuler.setFromQuaternion(REFS.physQuat, 'YXZ');
        const yaw = REFS.physEuler.y, pitch = REFS.physEuler.x, roll = REFS.physEuler.z;

        const now = performance.now() / 1000;
        if (!PHYS.init) {
            PHYS.init = true; PHYS.t = now;
            PHYS.yaw = yaw; PHYS.pitch = pitch; PHYS.roll = roll;
            PHYS.yawRest = yaw; PHYS.yawRestInit = true; // seed the neutral-yaw baseline
            return;
        }
        let dt = now - PHYS.t; PHYS.t = now;
        if (dt <= 0) return;
        if (dt > 0.04) dt = 0.04; // clamp → integrators stay stable after a stall / tab switch

        // Yaw side-hide: feed the live turn-FROM-NEUTRAL to the chain shader. The neutral-yaw
        // baseline self-calibrates (slow EMA) only while the head is fairly steady, so the
        // resting pose reads as 0 turn → nothing hides when you just face the camera (that
        // off-rest bias was why it "hid everything"). Only a real turn fades the far strand.
        if (PARAMS.YAW_HIDE_ENABLED && REFS.chainShader) {
            const wYawNow = Math.abs(yaw - PHYS.yaw) / dt; // rad/s
            if (wYawNow < 0.6) { // steady-ish → adapt the neutral baseline toward the current yaw
                PHYS.yawRest += (yaw - PHYS.yawRest) * PARAMS.YAW_REST_ADAPT;
            }
            REFS.chainShader.uniforms.uYaw.value = (yaw - PHYS.yawRest) * PARAMS.YAW_HIDE_SIGN;
        }

        // --- 1) Soft-body chain ripple (the flexible "liquid" chain) -------------
        if (PARAMS.SOFT_ENABLED && REFS.softCur) {
            simulateChain(dt); // runs in world space → real inertia / lag / ripple
        }

        // --- 2) Pendant pendulum swing -------------------------------------------
        if (PARAMS.PHYS_ENABLED && REFS.pendantPivot) {
            const wYaw = (yaw - PHYS.yaw) / dt; // head-shake angular velocity → sideways impulse
            // Rest targets (pendant local frame): cancel the neck rotation so the charm hangs
            // toward vertical. The spring LAGS this target → that lag is the visible swing.
            const restX = -PARAMS.GRAVITY_PITCH * pitch; // nod → forward/back hang
            const restZ = -PARAMS.GRAVITY_ROLL * roll;   // lean → stays vertical

            const k = PARAMS.PHYS_STIFFNESS, c = PARAMS.PHYS_DAMPING;
            const ax = -k * (PHYS.sx - restX) - c * PHYS.vx;
            const az = -k * (PHYS.sz - restZ) - c * PHYS.vz - PARAMS.YAW_SHAKE_KICK * wYaw;
            PHYS.vx += ax * dt; PHYS.sx += PHYS.vx * dt;
            PHYS.vz += az * dt; PHYS.sz += PHYS.vz * dt;

            const m = PARAMS.SWING_MAX;
            if (PHYS.sx > m) { PHYS.sx = m; PHYS.vx = 0; } else if (PHYS.sx < -m) { PHYS.sx = -m; PHYS.vx = 0; }
            if (PHYS.sz > m) { PHYS.sz = m; PHYS.vz = 0; } else if (PHYS.sz < -m) { PHYS.sz = -m; PHYS.vz = 0; }

            REFS.pendantPivot.rotation.x = PARAMS.PENDANT_TILT + PHYS.sx;
            REFS.pendantPivot.rotation.z = PHYS.sz;
        }

        PHYS.yaw = yaw; PHYS.pitch = pitch; PHYS.roll = roll;
    }

    // ---------------------------------------------------------------------------
    // UI: catalog strip, product info, capture, metal toggle, resize.
    // ---------------------------------------------------------------------------
    function formatVND(n) {
        try { return new Intl.NumberFormat('vi-VN').format(n) + ' ₫'; }
        catch (e) { return n + ' đ'; }
    }

    function updateInfo(item) {
        const name = document.getElementById('pnjName');
        const price = document.getElementById('pnjPrice');
        if (name) name.textContent = item.name;
        if (price) price.textContent = formatVND(item.price);
    }

    function highlightThumb(id) {
        const strip = document.getElementById('pnjCatalog');
        if (!strip) return;
        Array.prototype.forEach.call(strip.children, function (el) {
            el.classList.toggle('is-active', el.dataset.id === id);
        });
    }

    function renderCatalog(items) {
        const strip = document.getElementById('pnjCatalog');
        if (!strip) return;
        strip.innerHTML = '';
        items.forEach(function (item) {
            const btn = document.createElement('button');
            btn.className = 'pnj-thumb';
            btn.dataset.id = item.id;
            btn.title = item.name;
            const img = document.createElement('img');
            img.src = item.image;
            img.alt = item.name;
            btn.appendChild(img);
            btn.addEventListener('click', function () { setProduct(item); });
            strip.appendChild(btn);
        });
    }

    function captureImage() {
        if (!REFS.renderer || typeof WEBARROCKSFACE === 'undefined') return;
        const cvBg = WEBARROCKSFACE.capture_image(true);
        const cvFg = REFS.renderer.domElement;
        const w = cvBg.width, h = cvBg.height;
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.translate(w, 0); ctx.scale(-1, 1); // mirror to match the on-screen selfie
        ctx.drawImage(cvBg, 0, 0);
        ctx.drawImage(cvFg, 0, 0);
        const win = window.open('');
        if (win) win.document.write('<img src="' + cv.toDataURL('image/png') + '">');
    }

    function hideBoot() { const b = document.getElementById('pnjBoot'); if (b) b.classList.add('is-hidden'); }
    function showError(msg) {
        const b = document.getElementById('pnjBoot');
        if (b) { b.classList.remove('is-hidden'); b.querySelector('.pnj-boot__text').textContent = msg; }
        console.error('[PNJ necklace]', msg);
    }

    function wireControls() {
        const cap = document.getElementById('pnjCapture');
        if (cap) cap.addEventListener('click', captureImage);

        // Precision selector — only meaningful with multiple AI nets. This build ships a
        // single net (NN_9), so hide the button entirely (cycling would 404 on a missing net).
        const prec = document.getElementById('pnjPrecision');
        if (prec) {
            if (NN_LADDER.length > 1) {
                const lbl = prec.querySelector('.pnj-prec__label');
                if (lbl) lbl.textContent = NN_REGISTRY[ACTIVE_NN_KEY].label;
                prec.addEventListener('click', function () {
                    let i = NN_LADDER.indexOf(ACTIVE_NN_KEY);
                    if (i === -1) i = NN_LADDER.indexOf(NN_DEFAULT);
                    const nextKey = NN_LADDER[(i + 1) % NN_LADDER.length];
                    const boot = document.getElementById('pnjBoot');
                    if (boot) {
                        boot.classList.remove('is-hidden');
                        const t = boot.querySelector('.pnj-boot__text');
                        if (t) t.textContent = 'Đang đổi mô hình AI: ' + NN_REGISTRY[nextKey].label + '…';
                    }
                    const url = new URL(location.href);
                    url.searchParams.set('nn', nextKey);
                    setTimeout(function () { location.assign(url.toString()); }, 120);
                });
            } else {
                prec.style.display = 'none';
            }
        }

        const metal = document.getElementById('pnjMetal');
        if (metal) metal.addEventListener('click', function () {
            const next = metal.dataset.metal === 'yellow' ? 'white' : 'yellow';
            metal.dataset.metal = next;
            metal.textContent = next === 'yellow' ? '🟡 Vàng' : '⚪ Trắng';
            setMetal(next);
        });

        const resize = function () {
            if (!REFS.helper || !STATE.booted) return;
            // re-fit the (now known) camera aspect into the new screen size, then let the
            // helper recompute the GL viewport, camera FoV/aspect and composer size.
            const b = layoutCanvases(_videoAspect);
            REFS.helper.resize(b.w, b.h);
        };
        window.addEventListener('resize', resize);
        // innerHeight updates a beat AFTER orientationchange on some mobile browsers.
        window.addEventListener('orientationchange', function () { setTimeout(resize, 300); });
    }

    function loadCatalog() {
        return fetch(ASSET_BASE + 'necklace-catalog.json')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                STATE.catalog = data.items || [];
                renderCatalog(STATE.catalog);
                if (STATE.catalog.length) {
                    STATE.product = STATE.catalog[0];
                    updateInfo(STATE.product);
                    highlightThumb(STATE.product.id);
                }
            })
            .catch(function (e) { showError('Không tải được danh mục sản phẩm.'); console.error(e); });
    }

    function boot() {
        if (typeof THREE === 'undefined' || typeof WebARRocksFaceThreeHelper === 'undefined') {
            showError('Thiếu thư viện WebAR.rocks / Three.js.');
            return;
        }
        wireControls();
        loadCatalog();
        startTracking();
    }

    window.addEventListener('load', boot);
})();
