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

// YOLOv8-pose (ONNX, runs in-browser via onnxruntime-web). Optional, fail-safe: it gives a
// second, robust read of the shoulders that we FUSE with MediaPipe to cut jitter and improve
// accuracy. If the model or runtime is missing it's silently skipped and the necklace falls
// back to MediaPipe Pose. Throttled (intervalMs) so it never tanks mobile FPS.
export const YOLO = {
  enabled: true,
  // Place a YOLOv8(n)-pose ONNX export here (input 640×640). Drop the file at
  // `public/models/yolov8n-pose.onnx`; export with: `yolo export model=yolov8n-pose.pt format=onnx imgsz=640`.
  modelPath: '/models/yolov8n-pose.onnx',
  // onnxruntime-web wasm binaries (version MUST match onnxruntime-web in package.json).
  wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/',
  inputSize: 640, // model input is square inputSize×inputSize (letterboxed)
  scoreThreshold: 0.45, // min person confidence to accept a detection
  minKpScore: 0.5, // min per-keypoint confidence to trust a shoulder
  intervalMs: 120, // min gap between inferences (≈8 Hz) — protects FPS; smoothing covers the rest
  // COCO-17 keypoint indices (YOLO pose order).
  L_SHOULDER: 5, // person's left shoulder
  R_SHOULDER: 6 //  person's right shoulder
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
  JAW_RIGHT: 172, // person's right jaw angle (gonion) — lowest reliable width point
  JAW_LEFT: 397, //  person's left jaw angle (gonion)
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
  SIZE: 0.44, // pendant photo width as a fraction of face width
  NECK_DROP: 0.3, // fallback neck-centre below the chin, in face-heights (no shoulders)
  DROP_TO_SHOULDER: 0.4, // with shoulders: neck-centre placed this far from chin toward shoulders
  // Real per-person neck width is measured LIVE from the jaw angle each frame (yaw-corrected),
  // so the curve fits each person instead of a fixed ratio. NECK_WIDTH scales that measurement;
  // RADIUS_MIN/MAX clamp it (as fractions of face width) against landmark glitches.
  NECK_WIDTH: 0.96, // neck radius = measured (yaw-corrected) half jaw-width × this (smaller = snugger)
  RADIUS_EAR: 0.44, // stable neck-radius estimate from the ear span (fraction of face width)
  RADIUS_STABLE: 0.55, // blend live-jaw → stable-ear (0 = all jaw/jittery, 1 = all ear/rigid)
  // YOLO/pose shoulders give the most robust neck scale (they don't foreshorten when the head
  // turns), so blend a shoulder-span estimate into the radius for the correct ratio on turns.
  SHOULDER_RADIUS_K: 0.2, // neck radius ≈ shoulder span × this
  SHOULDER_RADIUS_W: 0.4, // blend weight of the shoulder-based radius (0..1) — YOLO drives giãn nở
  RADIUS_MIN: 0.3, // lower clamp on neck radius, as a fraction of face width
  RADIUS_MAX: 0.5, // upper clamp on neck radius, as a fraction of face width
  CHAIN_GAP: 1.02, // chain radius = neck radius * CHAIN_GAP (rides just outside the neck)
  CHAIN_THICK: 0.015, // chain tube radius as a fraction of neck radius — keep SMALL (thin chain)
  OCCLUDER_RADIUS: 0.9, // neck-occluder radius as a fraction of neck radius (hides only the nape)
  OCCLUDER_PUSH: 0.3, // push the occluder back (× neck radius) so it never hides the FRONT chain
  TILT_DEG: 22, // forward tilt of the necklace plane (more = drapes lower / “bè” at the front)
  FRONT_SAG: 0.05, // subtle dip at the front centre from the pendant's weight, in face-heights
  // A real chain is FLEXIBLE: it sags in a soft catenary between the sides of the neck. DRAPE is
  // how deep the front hangs (face-heights); DRAPE_POWER shapes the curve (higher = sharper V).
  DRAPE: 0.16,
  DRAPE_POWER: 2.2,
  // Head pitch (look up/down) opens/closes the ring. The neutral baseline self-calibrates per
  // person (PITCH_SMOOTH) so it measures the CHANGE in pitch, then it's gently clamped.
  PITCH_GAIN: 3.3,
  PITCH_MAX: 26, // clamp on the pitch contribution to the tilt, in degrees
  PITCH_SMOOTH: 0.02, // how fast the neutral-pose baseline adapts per person (0..1, small = slow)
  YAW_GAIN: 0.85, // how strongly a head turn rotates the ring around the neck
  YAW_MAX: 78, // clamp on the wrap rotation, in degrees
  YAW_SIGN: 1, // flip to -1 if the wrap rotates the wrong way for your camera mirroring
  ROLL_GAIN: 0.8, // how much the neck-tilt rotates the necklace (a real chain drapes < full tilt)
  ROLL_SHOULDER: 0.5, // blend ear-roll → shoulder-roll when they AGREE (0..1)
  ROLL_AGREE: 22, // only trust shoulder tilt if within this many degrees of the head tilt
  ROLL_MAX: 30, // hard clamp on necklace tilt (deg) so the ring can never rotate edge-on
  FOLLOW: 0.15, // horizontal follow of the head turn (keep small so it stays centred)
  SHOULDER_WEIGHT: 0.35, // blend toward the shoulder midpoint (0..1) — keeps it centred on the body
  PHOTO_DROP: 0.32, // how far the pendant photo hangs below the chain front, in photo-widths
  FILTER_MIN_CUTOFF: 1.3, // One Euro (position): lower = smoother at rest (more lag)
  FILTER_BETA: 0.04, // One Euro (position): higher = less lag on fast moves
  FILTER_RAD_CUTOFF: 0.5, // One Euro (radius): very low = rock-steady ring size (kills pulsing)
  FILTER_RAD_BETA: 0.003, // One Euro (radius): tiny so the ring doesn't breathe in/out
  FILTER_ROT_CUTOFF: 0.6, // One Euro (yaw/roll): low = very steady rotation (kills sway)
  FILTER_ROT_BETA: 0.006 // One Euro (yaw/roll): keep tiny so the necklace doesn't wobble
};
