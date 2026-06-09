import * as THREE from 'three';
import { CAMERA, POSE } from './config.js';
import { createStage } from './render/scene.js';
import { createRing } from './render/jewelry/ring.js';
import { createEarring } from './render/jewelry/earring.js';
import { createPendant } from './render/jewelry/pendant.js';
import { makeMapper, ringFromHand, earsFromFace, pendantFromFace } from './render/anchors.js';
import { createHandTracker } from './tracking/handTracker.js';
import { createFaceTracker } from './tracking/faceTracker.js';
import { createPoseTracker } from './tracking/poseTracker.js';
import { setupUI } from './ui/overlay.js';
import ringData from './catalog/ring.json';
import earringData from './catalog/earring.json';
import necklaceData from './catalog/necklace.json';

// Real PNJ catalogs (crawled via scripts/fetch-pnj.mjs).
const CATALOG = { ring: ringData.items, earring: earringData.items, necklace: necklaceData.items };

const video = document.getElementById('camera');
const canvas = document.getElementById('overlay');

const HINTS = {
  ring: ['✋', 'Show your hand — palm toward you, fingers up'],
  earring: ['😊', 'Face the camera so both ears are visible'],
  necklace: ['📿', 'Face the camera — the pendant sits on your neckline']
};

const state = {
  mode: 'ring',
  quality: 'premium',
  design: { ring: CATALOG.ring[0], earring: CATALOG.earring[0], necklace: CATALOG.necklace[0] }
};

const ui = setupUI({
  onMode: (mode) => {
    state.mode = mode;
    ui.renderCatalog(CATALOG[mode], state.design[mode].id);
    ui.setHint(...HINTS[mode]);
  },
  onQuality: (q) => {
    state.quality = q;
    [ring, earringL, earringR, pendant].forEach((p) => p.setQuality(q));
  },
  onSelect: (item) => {
    state.design[state.mode] = item;
    applyTexture(state.mode);
  }
});

// --- Three.js stage + jewelry (all real-photo overlays) ---
const stage = createStage(canvas);
const ring = createRing();
const earringL = createEarring();
const earringR = createEarring();
const pendant = createPendant();
const pieces = [ring, earringL, earringR, pendant];
pieces.forEach((p) => {
  stage.add(p.group);
  p.group.visible = false;
  p.setQuality(state.quality);
});

function hideAll() {
  pieces.forEach((p) => (p.group.visible = false));
}

// --- Product textures (real PNJ cutouts) ---
const texLoader = new THREE.TextureLoader();
const texCache = new Map();
function getTexture(url) {
  if (!texCache.has(url)) {
    const t = texLoader.load(url);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    texCache.set(url, t);
  }
  return texCache.get(url);
}
function applyTexture(mode) {
  const item = state.design[mode];
  const img = item.image;
  if (mode === 'ring') ring.setTexture(getTexture(img));
  else if (mode === 'earring') {
    earringL.setTexture(getTexture(img));
    earringR.setTexture(getTexture(img));
  } else {
    pendant.setTexture(getTexture(img));
    // Determine metal type: check if name contains "Vàng trắng" or if SKU contains white gold indicators
    const isWhiteGold = /trắng/i.test(item.name) || /W\d{2,}/i.test(item.sku);
    pendant.setMetalColor(isWhiteGold ? 'white' : 'yellow');
  }
}

['ring', 'earring', 'necklace'].forEach(applyTexture);
Object.values(CATALOG).flat().forEach((p) => getTexture(p.image)); // warm cache for instant swaps
ui.renderCatalog(CATALOG.ring, state.design.ring.id);

// --- Camera ---
async function startCamera() {
  const open = (video) => navigator.mediaDevices.getUserMedia({ audio: false, video });
  let stream;
  try {
    stream = await open({
      facingMode: CAMERA.facingMode,
      width: { ideal: CAMERA.width },
      height: { ideal: CAMERA.height }
    });
  } catch {
    // Some phones reject resolution hints (OverconstrainedError) — retry with just the front camera.
    stream = await open({ facingMode: CAMERA.facingMode });
  }
  video.srcObject = stream;
  await video.play();
  await new Promise((res) => {
    if (video.videoWidth) return res();
    video.onloadedmetadata = () => res();
  });
}

const mapper = makeMapper(() => ({
  vw: video.videoWidth || 1,
  vh: video.videoHeight || 1,
  dw: stage.size.w,
  dh: stage.size.h
}));

const v = Array.from({ length: 4 }, () => new THREE.Vector3());
let hand = null;
let face = null;
let pose = null;

function frame() {
  const ts = performance.now();
  const ready = video.readyState >= 2 && video.videoWidth > 0;
  let detected = false;

  if (ready && state.mode === 'ring' && hand) {
    const lm = hand.detect(video, ts);
    if (lm) {
      const r = ringFromHand(lm, mapper);
      ring.update(stage.toWorld(r.mcp, v[0]), stage.toWorld(r.pip, v[1]), r.width);
      hideAll();
      ring.group.visible = true;
      detected = true;
    }
  } else if (ready && state.mode === 'earring' && face) {
    const lm = face.detect(video, ts);
    if (lm) {
      const e = earsFromFace(lm, mapper);
      earringL.update(stage.toWorld(e.left, v[0]), e.size);
      earringR.update(stage.toWorld(e.right, v[1]), e.size);
      hideAll();
      earringL.group.visible = e.leftVisible;
      earringR.group.visible = e.rightVisible;
      detected = e.leftVisible || e.rightVisible;
    }
  } else if (ready && state.mode === 'necklace' && face) {
    const lm = face.detect(video, ts);
    if (lm) {
      // Shoulders (best-effort) anchor the chain to the body so it stays around the neck.
      // With several people in frame we pick the pose whose shoulders sit under THIS face, so a
      // bystander's body can't drag the necklace away.
      let shoulders = null;
      if (pose) {
        const poses = pose.detect(video, ts);
        if (poses && poses.length) {
          const noseN = lm[4]; // face nose in the same normalized image space as the pose
          let best = poses[0];
          if (poses.length > 1) {
            let bestD = Infinity;
            for (const pl of poses) {
              const mx = (pl[POSE.L_SHOULDER].x + pl[POSE.R_SHOULDER].x) / 2;
              const my = (pl[POSE.L_SHOULDER].y + pl[POSE.R_SHOULDER].y) / 2;
              const d = Math.hypot(mx - noseN.x, my - noseN.y);
              if (d < bestD) {
                bestD = d;
                best = pl;
              }
            }
          }
          const L = best[POSE.L_SHOULDER];
          const R = best[POSE.R_SHOULDER];
          shoulders = {
            left: mapper(L),
            right: mapper(R),
            visL: L.visibility ?? 1,
            visR: R.visibility ?? 1
          };
        }
      }
      const p = pendantFromFace(lm, mapper, shoulders);
      pendant.update(stage.toWorld(p.center, v[0]), p.size, p.radius, p.yaw, p.roll, p.faceH);
      hideAll();
      pendant.group.visible = true;
      detected = true;
    }
  }

  if (!detected) hideAll();
  ui.showHint(!detected);

  stage.render();
  requestAnimationFrame(frame);
}

async function boot() {
  try {
    ui.setHint(...HINTS.ring);
    ui.setBootHint('Allow camera access when prompted.');
    await startCamera();
    ui.setBootHint('Loading AI models (first load downloads ~10 MB)…');
    [hand, face] = await Promise.all([createHandTracker(), createFaceTracker()]);
    // Pose is best-effort: if it fails to load, the necklace falls back to face-only tracking.
    try {
      pose = await createPoseTracker();
    } catch (err) {
      console.warn('Pose model unavailable; necklace will use face landmarks only.', err);
    }
    ui.bootDone();
    requestAnimationFrame(frame);
  } catch (err) {
    console.error(err);
    ui.setBootHint(
      'Camera or model failed to start. Needs camera permission + a secure context ' +
      '(localhost or https). Details in the console.'
    );
  }
}

boot();
