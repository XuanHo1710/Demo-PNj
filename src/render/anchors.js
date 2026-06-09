import { HAND, FACE, PENDANT, POSE } from '../config.js';

const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DEG = Math.PI / 180;

// Self-calibrating neutral for the vertical face ratio, so head pitch is measured as the CHANGE
// from each person's own straight-ahead pose (no fixed per-face assumption).
let pitchNeutral = null;

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

  // Occlusion: if the head is turned too far, hide the earring on the turned-away side
  const leftVisible = distL / (distR || 1) > 0.45;
  const rightVisible = distR / (distL || 1) > 0.45;

  // Symmetrical head-turn factor: 0 when facing forward, increases as head turns.
  // We reduce the outward push as the head turns because the earlobes project less from the silhouette.
  const turn = Math.abs(distL - distR) / (distL + distR || 1);
  const factor = Math.max(0.1, 1.0 - turn * 2.0);
  const out = faceWidth * FACE.EARLOBE_OUT * factor;
  const drop = faceHeight * FACE.EARLOBE_DROP;

  // Lateral correction shift: when the head turns, the cheek outline landmarks (a and b)
  // shift sideways relative to the physical ears. We calculate a correction offset
  // to shift both earrings back, clamped to prevent over-correcting at extreme angles.
  const bias = (distL - distR) / (distL + distR || 1);
  const correction = faceWidth * Math.min(0.06, Math.max(-0.06, bias * 0.25));

  const inner = a.x < b.x ? a : b; // image-left ear (smaller x, b)
  const outer = a.x < b.x ? b : a; // image-right ear (larger x, a)

  return {
    size: faceWidth * FACE.EARRING_SIZE,
    left: { x: inner.x - out - correction, y: inner.y + drop },
    right: { x: outer.x + out - correction, y: outer.y + drop },
    leftVisible,
    rightVisible
  };
}

// Screen-space necklace placement. Returns the parameters of a 3D loop that the renderer wraps
// around a neck cylinder: the neck centre, its radius, plus head yaw (turn) and roll (tilt).
// `shoulders` is optional ({ left, right, visL, visR } in screen px) and, when confident, keeps
// the chain anchored to the body so it stays around the neck as the head turns.
export function pendantFromFace(landmarks, map, shoulders) {
  const chin = map(landmarks[FACE.CHIN]);
  const top = map(landmarks[FACE.FOREHEAD]);
  const earR = map(landmarks[FACE.EAR_RIGHT]); // person's right ear (screen-right, larger x)
  const earL = map(landmarks[FACE.EAR_LEFT]); //  person's left ear (screen-left, smaller x)
  const jawR = map(landmarks[FACE.JAW_RIGHT]); // person's right jaw angle
  const jawL = map(landmarks[FACE.JAW_LEFT]); //  person's left jaw angle
  const nose = map(landmarks[4]);
  const faceWidth = dist(earL, earR);
  const faceHeight = dist(top, chin);

  // Head yaw from ear↔nose foreshortening (mirror-safe in screen space): >0 when the face
  // turns toward screen-right. Drives how far the chain rotates around the neck.
  const distL = dist(earL, nose);
  const distR = dist(earR, nose);
  const yawRaw = (distL - distR) / (distL + distR || 1);
  const yaw = clamp(
    PENDANT.YAW_SIGN * yawRaw * PENDANT.YAW_GAIN * (Math.PI / 2),
    -PENDANT.YAW_MAX * DEG,
    PENDANT.YAW_MAX * DEG
  );

  // Head pitch (look up/down). The vertical face proportion (forehead→nose vs nose→chin) is
  // mirror-invariant and sign-stable. Its neutral baseline self-calibrates while the head is
  // roughly straight, so we read the change in pitch and the ring opens/closes like a real one.
  const upper = Math.abs(nose.y - top.y);
  const lower = Math.abs(chin.y - nose.y);
  const vRatio = lower / (upper + lower || 1);
  if (pitchNeutral === null) pitchNeutral = vRatio;
  if (Math.abs(yaw) < 0.25) pitchNeutral += (vRatio - pitchNeutral) * PENDANT.PITCH_SMOOTH;
  const pitch = clamp(
    (pitchNeutral - vRatio) * PENDANT.PITCH_GAIN,
    -PENDANT.PITCH_MAX * DEG,
    PENDANT.PITCH_MAX * DEG
  );

  // Are the shoulders a trustworthy, in-frame match for THIS face?
  const haveShoulders =
    shoulders &&
    shoulders.visL > POSE.MIN_VIS &&
    shoulders.visR > POSE.MIN_VIS &&
    (shoulders.left.y + shoulders.right.y) / 2 > chin.y;

  // Necklace tilt (roll). A necklace lies on the NECK/BODY, so its tilt should follow the body.
  // The face ear-line is the RELIABLE base read in a head-shot; the shoulder line (YOLO/pose)
  // refines it ONLY when the two agree — in tight/dark frames the shoulders are often mis-read,
  // and trusting them blindly tips the whole ring over (the lopsided-collapse bug). Screen is
  // y-down but the renderer is y-up, so negate; both formulas put the larger-x point first so
  // they share one sign convention.
  let roll = -Math.atan2(earR.y - earL.y, earR.x - earL.x);
  if (haveShoulders) {
    // shoulders.left is the person's left shoulder, which sits at the LARGER screen x (mirror).
    const sRoll = -Math.atan2(
      shoulders.left.y - shoulders.right.y,
      shoulders.left.x - shoulders.right.x
    );
    // Reject a shoulder tilt that disagrees with the head by more than the trust window.
    if (Math.abs(sRoll - roll) < PENDANT.ROLL_AGREE * DEG) {
      roll = lerp(roll, sRoll, PENDANT.ROLL_SHOULDER);
    }
  }
  // Hard clamp: a real necklace never tips far, and this guarantees the ring stays a wide,
  // neck-wrapping ellipse instead of rotating edge-on into a thin sliver.
  roll = clamp(roll, -PENDANT.ROLL_MAX * DEG, PENDANT.ROLL_MAX * DEG);

  // Per-person neck width. Start from the jaw angle (yaw-corrected so it doesn't shrink on a
  // turn) blended with a stable ear-span estimate, then fold in the shoulder span — the most
  // robust scale of all, because the shoulders barely foreshorten when only the head turns.
  const yawCos = Math.max(0.5, Math.cos(yaw));
  const jawHalf = dist(jawL, jawR) / yawCos / 2;
  const jawBased = jawHalf * PENDANT.NECK_WIDTH;
  const earBased = faceWidth * PENDANT.RADIUS_EAR;
  let radius = lerp(jawBased, earBased, PENDANT.RADIUS_STABLE);
  if (haveShoulders) {
    const shoulderR = dist(shoulders.left, shoulders.right) * PENDANT.SHOULDER_RADIUS_K;
    radius = lerp(radius, shoulderR, PENDANT.SHOULDER_RADIUS_W);
  }
  radius = clamp(radius, faceWidth * PENDANT.RADIUS_MIN, faceWidth * PENDANT.RADIUS_MAX);

  // Horizontal neck centre = the head's vertical centreline (jaw-corner midpoint). It's
  // symmetric by construction, so the necklace stays centred on the neck instead of drifting
  // to one side. A small follow toward the nose eases it with strong head turns. Shoulders only
  // nudge it gently, and are ignored when they disagree wildly with the face (a misdetection),
  // so they can never yank the necklace off-centre.
  const centreX = (earL.x + earR.x) / 2;
  let cx = lerp(centreX, nose.x, PENDANT.FOLLOW);
  // Vertical placement adapts to each person's neck length: when the shoulders are visible we
  // sit the chain partway down from the chin to the shoulder line; otherwise fall back to a
  // face-height ratio.
  let cy = chin.y + faceHeight * PENDANT.NECK_DROP;
  if (haveShoulders) {
    const midX = (shoulders.left.x + shoulders.right.x) / 2;
    const midY = (shoulders.left.y + shoulders.right.y) / 2;
    if (Math.abs(midX - centreX) < faceWidth * 0.5) {
      cx = lerp(cx, midX, PENDANT.SHOULDER_WEIGHT);
    }
    cy = lerp(chin.y, midY, PENDANT.DROP_TO_SHOULDER);
  }

  return {
    center: { x: cx, y: cy }, // neck-cylinder centre (front low point of the drape)
    size: faceWidth * PENDANT.SIZE, // pendant photo width (px)
    radius, // neck-cylinder radius (px), measured live per person
    yaw, // wrap rotation around the neck (rad)
    roll, // head tilt (rad, y-up)
    pitch, // head up/down (rad) — opens/closes the ring
    faceH: faceHeight // for the drape sag + occluder height (px)
  };
}
