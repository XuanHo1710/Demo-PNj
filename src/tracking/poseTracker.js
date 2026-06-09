import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { MEDIAPIPE } from '../config.js';

// Thin wrapper around MediaPipe PoseLandmarker (running-mode VIDEO). Used by the necklace to
// read the shoulders, which anchor the chain to the body so it stays around the neck when the
// head turns. Loaded best-effort — if it fails, the necklace falls back to face landmarks.
export async function createPoseTracker() {
    const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE.wasm);
    const landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MEDIAPIPE.poseModel, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 1
    });

    // Returns the first pose's 33 landmarks (x,y,z,visibility), or null.
    function detect(video, tsMs) {
        const res = landmarker.detectForVideo(video, tsMs);
        return res.landmarks && res.landmarks.length ? res.landmarks[0] : null;
    }

    return { detect };
}
