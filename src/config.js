// Tunable constants for the demo. Tweak these while framing the 10–15s shot.

export const MEDIAPIPE = {
  // wasm version MUST match the @mediapipe/tasks-vision version in package.json.
  wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm',
  handModel:
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  faceModel:
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  // Lite pose model — fast enough to run alongside the face mesh for the necklace.
  poseModel:
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'
};

// MediaPipe pose-landmark indices (33-point model).
export const POSE = {
  L_SHOULDER: 11, // person's left shoulder
  R_SHOULDER: 12, // person's right shoulder
  MIN_VIS: 0.5 // ignore shoulders below this visibility (e.g. cropped out of frame)
};

export const CAMERA = {
  // Request the webcam's native landscape frame; the video is shown `contain` (full FOV,
  // letterboxed) so the subject isn't cropped/zoomed in.
  width: 1280,
  height: 720,
  facingMode: 'user'
};

// MediaPipe hand-landmark indices (21-point model).
export const HAND = {
  RING_MCP: 13, // base knuckle of the ring finger
  RING_PIP: 14, // first joint above the knuckle — the ring sits between MCP and PIP
  MIDDLE_MCP: 9, // used to estimate finger width (knuckle spacing)
  BAND_ALONG: 0.45, // where along MCP→PIP the ring sits (0 = knuckle, 1 = first joint)
  RING_SIZE: 1.85 // ring plane width as a multiple of finger width (band ≈ finger)
};

// MediaPipe face-mesh indices (468-point model).
export const FACE = {
  EAR_RIGHT: 234, // person's right ear region (image-left)
  EAR_LEFT: 454, //  person's left ear region (image-right)
  CHIN: 152,
  FOREHEAD: 10,
  // The 234/454 landmarks sit on the cheek silhouette, inboard of the real ear. Push each
  // ear point straight out (fraction of face width) and down (fraction of face height) to the
  // lobe. Additive per-ear offsets don't amplify head turns, so the two sides stay symmetric.
  EARLOBE_OUT: 0.02, // outward push to the lobe, as a fraction of face width
  EARLOBE_DROP: 0.085, // downward drop to the lobe, as a fraction of face height
  EARRING_SIZE: 0.12, // stud width as a fraction of face width
  // Crop the PNJ stud-pair photo down to the single front-facing piece (normalized, top-left).
  EARRING_CROP: { x: 0.02, y: 0.22, w: 0.46, h: 0.56 }
};

// Necklace placement. The chain is modelled as a real 3D ring that FULLY wraps a neck cylinder
// (360°): the front + sides are visible and the back is hidden behind the neck occluder, so it
// reads as a complete necklace worn around the neck and stays wrapped when the head turns.
// Sizes are relative to the face so they scale with distance. Tweak while framing the shot.
export const PENDANT = {
  SIZE: 0.46, // pendant photo width as a fraction of face width
  NECK_DROP: 0.3, // neck-cylinder centre below the chin, in face-heights (sits low on the neck)
  NECK_RADIUS: 0.42, // neck-cylinder radius as a fraction of face width (snug = smaller)
  CHAIN_GAP: 1.06, // chain radius = NECK_RADIUS * CHAIN_GAP (rides just outside the neck)
  CHAIN_THICK: 0.016, // chain tube radius as a fraction of neck radius — keep SMALL (thin chain)
  TILT_DEG: 24, // forward tilt of the necklace plane (front sits lower than the nape)
  FRONT_SAG: 0.05, // extra dip at the front centre from the pendant's weight, in face-heights
  YAW_GAIN: 0.85, // how strongly a head turn rotates the ring around the neck
  YAW_MAX: 78, // clamp on the wrap rotation, in degrees
  YAW_SIGN: 1, // flip to -1 if the wrap rotates the wrong way for your camera mirroring
  FOLLOW: 0.15, // horizontal follow of the head turn (keep small so it stays centred)
  SHOULDER_WEIGHT: 0.25, // gentle blend toward the shoulder midpoint (0..1) — must stay small
  PHOTO_DROP: 0.34, // how far the pendant photo hangs below the chain front, in photo-widths
  FILTER_MIN_CUTOFF: 1.2, // One Euro: lower = smoother at rest (more lag)
  FILTER_BETA: 0.03 // One Euro: higher = less lag on fast moves
};
