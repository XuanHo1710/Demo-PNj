import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';
import { MEDIAPIPE } from '../config.js';

// Thin wrapper around MediaPipe FaceLandmarker (running-mode VIDEO).
export async function createFaceTracker() {
  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE.wasm);
  const landmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MEDIAPIPE.faceModel, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numFaces: 1
  });

  // Returns the 468 face-mesh landmarks, or null.
  function detect(video, tsMs) {
    const res = landmarker.detectForVideo(video, tsMs);
    return res.faceLandmarks && res.faceLandmarks.length ? res.faceLandmarks[0] : null;
  }

  return { detect };
}
