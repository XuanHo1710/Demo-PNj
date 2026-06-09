import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { MEDIAPIPE } from '../config.js';

// Thin wrapper around MediaPipe HandLandmarker (running-mode VIDEO).
export async function createHandTracker() {
  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE.wasm);
  const landmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MEDIAPIPE.handModel, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 1
  });

  // Returns the first hand's 21 landmarks, or null.
  function detect(video, tsMs) {
    const res = landmarker.detectForVideo(video, tsMs);
    return res.landmarks && res.landmarks.length ? res.landmarks[0] : null;
  }

  return { detect };
}
