import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';
import { MEDIAPIPE } from '../config.js';

// Thin wrapper around MediaPipe FaceLandmarker (running-mode VIDEO). It detects several faces
// and locks onto the LARGEST (closest to camera) one, so a person standing in the background
// can't steal the jewelry overlay.
export async function createFaceTracker() {
  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE.wasm);
  // GPU is fastest, but it's unavailable on some phones/browsers — fall back to CPU.
  const landmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MEDIAPIPE.faceModel, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numFaces: 3
  }).catch(() =>
    FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MEDIAPIPE.faceModel, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numFaces: 3
    })
  );

  // Returns the 468 landmarks of the largest detected face, or null.
  function detect(video, tsMs) {
    const res = landmarker.detectForVideo(video, tsMs);
    const faces = res.faceLandmarks;
    if (!faces || !faces.length) return null;
    let best = faces[0];
    if (faces.length > 1) {
      let bestW = -1;
      for (const f of faces) {
        // Ear-to-ear span (234/454) is a cheap proxy for "how close / how big".
        const w = Math.hypot(f[234].x - f[454].x, f[234].y - f[454].y);
        if (w > bestW) {
          bestW = w;
          best = f;
        }
      }
    }
    return best;
  }

  return { detect };
}
