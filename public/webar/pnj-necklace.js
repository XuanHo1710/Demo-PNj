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

    // ---------------------------------------------------------------------------
    // Tunables — tweak these to restyle the chain/pendant. All in torso mm space.
    // ---------------------------------------------------------------------------
    const PARAMS = {
        CHAIN_GAP: 1.03,        // chain radius vs measured neck radius (>1 = rides just outside the skin)
        CHAIN_THICK: 1.15,      // chain tube radius (mm). Keep thin for a delicate look.
        CHAIN_SEGMENTS: 320,    // tube length segments (smoothness of the drape)
        CHAIN_RADIAL: 10,       // tube radial segments (roundness)
        FRONT_DRAPE: 26,        // extra downward sag at the front centre from the chain's weight (mm)
        LOOP_SAMPLES: 170,      // points sampled around the neck for the curve

        PENDANT_SIZE: 46,       // pendant width (mm); height follows the image aspect ratio
        PENDANT_GAP: 4,         // gap between the chain front point and the top of the pendant (mm)
        PENDANT_FWD: 6,         // push the pendant slightly forward of the chain so it never z-fights (mm)
        PENDANT_TILT: -0.12,    // small forward lean (rad) so the charm faces the camera a touch
        // Gravity: when you LEAN, the chain rolls with your neck but a real pendant swings
        // back toward vertical (it hangs). 0 = rigid (rolls fully with you), 1 = full
        // gravity (always points straight down). Flip the sign if it swings the wrong way.
        PENDANT_GRAVITY: 0.6,

        TAA_LEVEL: 3,           // engine temporal anti-aliasing samples (0 = off). Demo uses 3.

        METAL_WHITE: 0xececed,  // white-gold / silver chain colour
        METAL_YELLOW: 0xf2cf7a, // yellow-gold chain colour
        CHAIN_ROUGHNESS: 0.26,
        CHAIN_METALNESS: 1.0,
        CHAIN_ENVINTENSITY: 1.15,

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
    // tuned per net (demo: NN_9 → [8,16], NN_8 → [4,12]); `label` → precision-button text.
    const NN_REGISTRY = {
        '9': { path: 'neuralNets/NN_NECKLACE_9.json', points: 6, filter: [8, 16], threshold: 0.7, label: 'Cân bằng' },
        '8': { path: 'neuralNets/NN_NECKLACE_8.json', points: 6, filter: [4, 12], threshold: 0.7, label: 'Sắc nét' },
        '7': { path: 'neuralNets/NN_NECKLACE_7.json', points: 6, filter: [4, 12], threshold: 0.7, label: 'Sắc nét+' },
        '6': { path: 'neuralNets/NN_NECKLACE_6.json', points: 6, filter: [6, 14], threshold: 0.7, label: 'Nhẹ' },
        '4': { path: 'neuralNets/NN_NECKLACE_4.json', points: 8, filter: [6, 14], threshold: 0.7, label: '8 điểm' },
        '3': { path: 'neuralNets/NN_NECKLACE_3.json', points: 8, filter: [6, 14], threshold: 0.7, label: '8 điểm·3' },
        '2': { path: 'neuralNets/NN_NECKLACE_2.json', points: 8, filter: [6, 14], threshold: 0.7, label: '8 điểm·2' },
        '1': { path: 'neuralNets/NN_NECKLACE_1.json', points: 8, filter: [6, 14], threshold: 0.7, label: '8 điểm·1' }
    };
    // The precision button cycles this curated ladder: Fast → Balanced(default) → 8-point → Sharp.
    const NN_LADDER = ['6', '9', '4', '8'];
    const NN_DEFAULT = '9';

    function resolveNNKey() {
        // priority: ?nn=N url param (power testing) → saved choice → default
        try {
            const u = new URLSearchParams(location.search).get('nn');
            if (u && NN_REGISTRY[u]) return u;
            const s = localStorage.getItem('pnjNeckNN');
            if (s && NN_REGISTRY[s]) return s;
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
        //   theta = 0   -> front  (c =  1) -> yFront  (neckline base, dragged down by FRONT_DRAPE)
        //   theta = ±90 -> sides  (c =  0) -> ySide   (chain rests on the neck sides)
        //   theta = 180 -> back   (c = -1) -> yBack   (rises around the nape, hidden by occluder)
        const yFront = (F.y + Fd.y) / 2 - PARAMS.FRONT_DRAPE;
        const ySide = (L.y + R.y) / 2;
        const yBack = B.y;
        const yb = (yFront - yBack) / 2;
        const yd = (yFront + yBack) / 2 - ySide;
        const yOf = function (cosT) { return ySide + yb * cosT + yd * cosT * cosT; };

        return { centerX: centerX, centerZ: centerZ, radiusX: radiusX, radiusZ: radiusZ, yOf: yOf, yFront: yFront };
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
        chainMesh: null,
        chainMat: null,
        pendantMesh: null,
        pendantMat: null,
        neck: null,           // result of buildNeckModel()
        envMap: null,
        gravQuat: null,       // reused each frame for the pendant gravity hang
        gravEuler: null
    };
    const STATE = { product: null, catalog: [], booted: false };
    const texLoader = new THREE.TextureLoader();

    // ---------------------------------------------------------------------------
    // Build the necklace: a draping chain tube + a textured pendant plane.
    // ---------------------------------------------------------------------------
    function buildNecklace() {
        const neck = REFS.neck;
        const group = new THREE.Object3D();

        // --- Chain: a closed catenary-like loop around the neck ellipse ----------
        const pts = [];
        for (let i = 0; i < PARAMS.LOOP_SAMPLES; i++) {
            const t = (i / PARAMS.LOOP_SAMPLES) * Math.PI * 2;
            const c = Math.cos(t);
            const s = Math.sin(t);
            const x = neck.centerX + s * neck.radiusX;
            const z = neck.centerZ + c * neck.radiusZ;
            const y = neck.yOf(c);
            pts.push(new THREE.Vector3(x, y, z));
        }
        const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
        const tubeGeo = new THREE.TubeGeometry(curve, PARAMS.CHAIN_SEGMENTS, PARAMS.CHAIN_THICK, PARAMS.CHAIN_RADIAL, true);
        REFS.chainMat = new THREE.MeshStandardMaterial({
            color: PARAMS.METAL_WHITE,
            metalness: PARAMS.CHAIN_METALNESS,
            roughness: PARAMS.CHAIN_ROUGHNESS,
            envMapIntensity: PARAMS.CHAIN_ENVINTENSITY
        });
        REFS.chainMesh = new THREE.Mesh(tubeGeo, REFS.chainMat);
        REFS.chainMesh.renderOrder = 10;
        group.add(REFS.chainMesh);

        // --- Pendant: the PNJ product image hung at the front-centre -------------
        REFS.pendantMat = new THREE.MeshStandardMaterial({
            transparent: true,
            alphaTest: 0.45,
            side: THREE.DoubleSide,
            metalness: 0.0,
            roughness: 0.85,
            envMapIntensity: 0.25
        });
        REFS.pendantMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), REFS.pendantMat);
        REFS.pendantMesh.renderOrder = 11;
        REFS.pendantMesh.visible = false; // shown once a texture is loaded
        group.add(REFS.pendantMesh);

        REFS.necklaceGroup = group;
        REFS.follower.add(group);
    }

    // Position + size the pendant under the chain's front point for a given image.
    function layoutPendant(aspect) {
        const neck = REFS.neck;
        const w = PARAMS.PENDANT_SIZE;
        const h = w / (aspect || 1);
        REFS.pendantMesh.geometry.dispose();
        REFS.pendantMesh.geometry = new THREE.PlaneGeometry(w, h);

        const frontX = neck.centerX;
        const frontZ = neck.centerZ + neck.radiusZ;
        const topY = neck.yFront - PARAMS.PENDANT_GAP; // chain front, minus a small gap to the bail
        REFS.pendantMesh.position.set(frontX, topY - h / 2, frontZ + PARAMS.PENDANT_FWD);
        REFS.pendantMesh.rotation.set(PARAMS.PENDANT_TILT, 0, 0);
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
            REFS.pendantMesh.visible = true;
        });
    }

    // ---------------------------------------------------------------------------
    // Scene dressing (lighting + envmap + occluder), then build the necklace.
    // ---------------------------------------------------------------------------
    function onReady(err, sceneObjects) {
        if (err) {
            // A heavy net (7 MB) can fail to load / OOM on a weak phone. Fall back to the
            // proven default net ONCE (guarded so we never loop), then surface the error.
            if (ACTIVE_NN_KEY !== NN_DEFAULT && !sessionStorage.getItem('pnjNNFellBack')) {
                try {
                    sessionStorage.setItem('pnjNNFellBack', '1');
                    localStorage.setItem('pnjNeckNN', NN_DEFAULT);
                } catch (e) { /* ignore */ }
                location.reload();
                return;
            }
            showError('Tracking engine failed to start: ' + err);
            return;
        }
        sessionStorage.removeItem('pnjNNFellBack'); // success → clear the one-shot guard
        REFS.scene = sceneObjects.threeScene;
        REFS.renderer = sceneObjects.threeRenderer;
        REFS.follower = sceneObjects.threeFaceFollowers[0];
        REFS.gravQuat = new THREE.Quaternion(); // reused each frame by onTrack (pendant gravity)
        REFS.gravEuler = new THREE.Euler();

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
        new THREE.RGBELoader().setDataType(THREE.HalfFloatType).load('assets/envmaps/venice_sunset_1k.hdr', function (hdr) {
            REFS.envMap = pmrem.fromEquirectangular(hdr).texture;
            REFS.scene.environment = REFS.envMap;
            pmrem.dispose();
        });

        // occluder = invisible head/neck that hides the part of the chain behind the neck.
        // IMPORTANT: pass a real LoadingManager — the helper does `new GLTFLoader(manager)` and
        // GLTFLoader.load() calls `manager.itemStart()`, so a null manager throws.
        REFS.loadingManager = new THREE.LoadingManager();
        REFS.helper.add_occluderFromFile('assets/models3D/occluder.glb', null, REFS.loadingManager, false);

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
                NNCPath: nn.path,
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
            // per-frame hook → hang the pendant under gravity as you lean
            callbackTrack: onTrack
        });
    }

    // Per-frame: the chain is fixed to your neck (it rolls fully with you), but a real
    // pendant HANGS — so we counter a fraction of your lean on just the charm to keep it
    // pointing toward the ground. The engine calls this after each pose update, when the
    // follower's world matrix is current.
    function onTrack() {
        if (PARAMS.PENDANT_GRAVITY === 0 || !REFS.pendantMesh || !REFS.follower || !REFS.gravQuat) return;
        const parent = REFS.follower.parent; // faceFollowerParent carries the neck pose rotation
        if (!parent) return;
        parent.getWorldQuaternion(REFS.gravQuat);
        REFS.gravEuler.setFromQuaternion(REFS.gravQuat, 'ZYX'); // Z = roll (lean) extracted first
        REFS.pendantMesh.rotation.z = -PARAMS.PENDANT_GRAVITY * REFS.gravEuler.z;
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

        // Precision selector — cycles the AI-model quality ladder so the user can pick
        // the most accurate net for their device. Persists + reloads (changing the net
        // re-centres solvePnP, so a clean reload is the robust way to apply it).
        const prec = document.getElementById('pnjPrecision');
        if (prec) {
            const lbl = prec.querySelector('.pnj-prec__label');
            if (lbl) lbl.textContent = NN_REGISTRY[ACTIVE_NN_KEY].label;
            prec.addEventListener('click', function () {
                let i = NN_LADDER.indexOf(ACTIVE_NN_KEY);
                if (i === -1) i = NN_LADDER.indexOf(NN_DEFAULT);
                const nextKey = NN_LADDER[(i + 1) % NN_LADDER.length];
                try { localStorage.setItem('pnjNeckNN', nextKey); } catch (e) { /* ignore */ }
                const boot = document.getElementById('pnjBoot');
                if (boot) {
                    boot.classList.remove('is-hidden');
                    const t = boot.querySelector('.pnj-boot__text');
                    if (t) t.textContent = 'Đang đổi mô hình AI: ' + NN_REGISTRY[nextKey].label + '…';
                }
                setTimeout(function () { location.reload(); }, 120);
            });
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
        return fetch('necklace-catalog.json')
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
