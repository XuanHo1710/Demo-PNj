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

        TAA_LEVEL: 3,           // engine temporal anti-aliasing samples (0 = off). Demo uses 3.

        METAL_WHITE: 0xececed,  // white-gold / silver chain colour
        METAL_YELLOW: 0xf2cf7a, // yellow-gold chain colour
        CHAIN_ROUGHNESS: 0.26,
        CHAIN_METALNESS: 1.0,
        CHAIN_ENVINTENSITY: 1.15,

        // pose smoothing / constraints (proven values from the WebAR.rocks demo):
        ROTATION_CONSTRAINTS: { order: 'YXZ', rotXFactor: 1, rotYFactor: 0.3, rotZFactor: 0.5 },
        STABILIZER: { beta: 5, forceFilterNNInputPxRange: [8, 16] } // tuned for NN_NECKLACE_9
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
    // The subset WebAR.rocks actually feeds to solvePnP (must match main.js below).
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
    const SOLVEPNP_IMGPOINTS = [
        'torsoNeckCenterUp', 'torsoNeckLeftUp', 'torsoNeckRightUp',
        'torsoNeckBackUp', 'torsoNeckCenterDown', 'torsoNeckBackDown'
    ];

    // ---------------------------------------------------------------------------
    // Derive the neck ellipse + draping Y profile from the (centred) reference pts.
    // WebAR.rocks centres objPoints by the mean of the USED labels, so we do the
    // same here and author the necklace in that centred frame → perfect alignment.
    // ---------------------------------------------------------------------------
    function buildNeckModel() {
        const usedLabels = SOLVEPNP_IMGPOINTS;
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
        envMap: null
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
            showError('Tracking engine failed to start: ' + err);
            return;
        }
        REFS.scene = sceneObjects.threeScene;
        REFS.renderer = sceneObjects.threeRenderer;
        REFS.follower = sceneObjects.threeFaceFollowers[0];

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

        STATE.booted = true;
        hideBoot();
        if (STATE.product) setProduct(STATE.product);
    }

    function startTracking() {
        REFS.helper = WebARRocksFaceThreeHelper;
        REFS.helper.init({
            spec: {
                NNCPath: 'neuralNets/NN_NECKLACE_9.json',
                scanSettings: { threshold: 0.7 }
            },
            canvas: document.getElementById('WebARRocksFaceCanvas'),
            canvasThree: document.getElementById('threeCanvas'),
            solvePnPObjPointsPositions: SOLVEPNP_OBJPOINTS,
            solvePnPImgPointsLabels: SOLVEPNP_IMGPOINTS,
            landmarksStabilizerSpec: PARAMS.STABILIZER,
            rotationContraints: PARAMS.ROTATION_CONSTRAINTS,
            // engine-side temporal anti-aliasing → crisp chain/diamond edges (same as the
            // WebAR.rocks VTONecklace demo). Needs the postprocessing scripts in the HTML.
            taaLevel: PARAMS.TAA_LEVEL,
            callbackReady: onReady
        });
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

        const metal = document.getElementById('pnjMetal');
        if (metal) metal.addEventListener('click', function () {
            const next = metal.dataset.metal === 'yellow' ? 'white' : 'yellow';
            metal.dataset.metal = next;
            metal.textContent = next === 'yellow' ? '🟡 Vàng' : '⚪ Trắng';
            setMetal(next);
        });

        const resize = function () {
            const dpr = window.devicePixelRatio || 1;
            const w = Math.min(window.innerWidth, window.innerHeight);
            if (REFS.helper && STATE.booted) REFS.helper.resize(w * dpr, window.innerHeight * dpr);
        };
        window.addEventListener('resize', resize);
        window.addEventListener('orientationchange', resize);
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
