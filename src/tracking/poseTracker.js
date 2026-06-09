import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { MEDIAPIPE } from '../config.js';

// Thin wrapper around MediaPipe PoseLandmarker (running-mode VIDEO). Used by the necklace to
// read the shoulders, which anchor the chain to the body so it stays around the neck when the
// head turns. Detects a couple of people so the caller can pick the one that matches the face.
// Loaded best-effort — if it fails, the necklace falls back to face landmarks.
export async function createPoseTracker() {
    const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE.wasm);
    // GPU is fastest, but it's unavailable on some phones/browsers — fall back to CPU.
    const landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MEDIAPIPE.poseModel, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 2
    }).catch(() =>
        PoseLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MEDIAPIPE.poseModel, delegate: 'CPU' },
            runningMode: 'VIDEO',
            numPoses: 2
        })
    );

    // Returns an array of poses (each = 33 landmarks with x,y,z,visibility), or null.
    function detect(video, tsMs) {
        const res = landmarker.detectForVideo(video, tsMs);
        return res.landmarks && res.landmarks.length ? res.landmarks : null;
    }

    return { detect };
}
