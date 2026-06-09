// Tunable constants for the demo. Tweak these while framing the 10–15s shot.

export const MEDIAPIPE = {
  // wasm version MUST match the @mediapipe/tasks-vision version in package.json.
  wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm',
  handModel:
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  faceModel:
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
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

// Pendant / necklace placement, relative to face dimensions so it scales with distance.
export const PENDANT = {
  DROP: 0.46, // pendant centre below the chin (sits on the upper chest), in face-heights
  SIZE: 0.5, // pendant width as a fraction of face width
  // Chain ends sit just below the chin, at the sides of the neck.
  NECK_INSET: 0.18, // chain-end X: blend from the ears toward the chin (0 = at ears, wide)
  NECK_DROP: 0.45 // chain-end Y: how far below the ears, in face-heights (sits around jaw/neck level)
};
