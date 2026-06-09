import { HAND, FACE, PENDANT } from '../config.js';

const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Maps a normalized MediaPipe landmark (0..1 in the *un-mirrored* camera image) to on-screen
// pixels. The video is shown `object-fit: contain` (full frame, letterboxed), so we use the
// matching contain transform plus the selfie mirror. Origin top-left, y down.
export function makeMapper(ctx) {
  return (lm) => {
    const { vw, vh, dw, dh } = ctx();
    const scale = Math.min(dw / vw, dh / vh);
    const offX = (dw - vw * scale) / 2;
    const offY = (dh - vh * scale) / 2;
    const x = lm.x * vw * scale + offX;
    const y = lm.y * vh * scale + offY;
    return { x: dw - x, y }; // mirror X to match the CSS-mirrored selfie video
  };
}

// Screen-space ring placement from a single hand's 21 landmarks.
export function ringFromHand(landmarks, map) {
  const mcp = map(landmarks[HAND.RING_MCP]);
  const pip = map(landmarks[HAND.RING_PIP]);
  const middle = map(landmarks[HAND.MIDDLE_MCP]);
  return { mcp, pip, width: dist(mcp, middle) }; // knuckle spacing ≈ one finger width
}

// Screen-space earlobe placement (both ears) from face-mesh landmarks. Each cheek-silhouette
// point is pushed out (toward its own side) and down to reach the lobe. We scale the outward
// push dynamically based on the head's rotation (using the nose-to-ear distance ratio) so
// that the earring on the turned-away side doesn't float in the air.
export function earsFromFace(landmarks, map) {
  const a = map(landmarks[FACE.EAR_RIGHT]); // user's right ear (screen-right, larger x)
  const b = map(landmarks[FACE.EAR_LEFT]);  // user's left ear (screen-left, smaller x)
  const top = map(landmarks[FACE.FOREHEAD]);
  const chin = map(landmarks[FACE.CHIN]);
  const nose = map(landmarks[4]); // nose tip landmark

  const faceWidth = dist(a, b);
  const faceHeight = dist(top, chin);

  // Measure screen-space distances from ears to nose to detect head rotation
  const distL = dist(b, nose); // screen-left ear to nose
  const distR = dist(a, nose); // screen-right ear to nose

  // If the head is turned, the ear turned towards the camera is further from the nose in 2D projection,
  // while the ear turned away is closer. The turned-away ear needs a smaller outward offset.
  const outL = faceWidth * FACE.EARLOBE_OUT * Math.min(1.2, Math.max(0.15, distL / distR));
  const outR = faceWidth * FACE.EARLOBE_OUT * Math.min(1.2, Math.max(0.15, distR / distL));
  const drop = faceHeight * FACE.EARLOBE_DROP;

  const inner = a.x < b.x ? a : b; // image-left ear (smaller x, b)
  const outer = a.x < b.x ? b : a; // image-right ear (larger x, a)

  return {
    size: faceWidth * FACE.EARRING_SIZE,
    left: { x: inner.x - outL, y: inner.y + drop },
    right: { x: outer.x + outR, y: outer.y + drop }
  };
}

// Screen-space pendant placement: a product photo on the neckline plus chain anchors near
// the sides of the neck. Built from the chin, forehead and ear landmarks.
export function pendantFromFace(landmarks, map) {
  const chin = map(landmarks[FACE.CHIN]);
  const top = map(landmarks[FACE.FOREHEAD]);
  const earR = map(landmarks[FACE.EAR_RIGHT]);
  const earL = map(landmarks[FACE.EAR_LEFT]);
  const faceWidth = dist(earL, earR);
  const faceHeight = dist(top, chin);

  const center = { x: chin.x, y: chin.y + faceHeight * PENDANT.DROP };
  // Chain ends sit up at the sides of the neck (blended from the ears toward the chin), so
  // the chain rises around the neck instead of lying flat.
  const side = (ear) => ({
    x: lerp(ear.x, chin.x, PENDANT.NECK_INSET), // horizontal: width of the drape
    y: chin.y + faceHeight * PENDANT.NECK_DROP // vertical: sit just below the chin
  });
  return { center, size: faceWidth * PENDANT.SIZE, neckRight: side(earR), neckLeft: side(earL) };
}
