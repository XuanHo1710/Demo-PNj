import * as THREE from 'three';
import { createProductPlane } from '../productPlane.js';
import { HAND } from '../../config.js';

// Real PNJ ring overlaid on the finger. The product cutout has a transparent centre, so the
// finger shows *through* the band — it reads as actually worn. We sit it on the proximal
// phalanx and tilt it to follow the finger.
export function createRing() {
  const piece = createProductPlane();

  // worldMcp / worldPip: ring-finger base & first joint. fingerWidth: px.
  function update(worldMcp, worldPip, fingerWidth) {
    const center = new THREE.Vector3().lerpVectors(worldMcp, worldPip, HAND.BAND_ALONG);
    const dir = new THREE.Vector3().subVectors(worldPip, worldMcp);
    const angle = Math.atan2(dir.y, dir.x) - Math.PI / 2; // 0 when the finger points up
    piece.place(center, fingerWidth * HAND.RING_SIZE, angle);
  }

  return { group: piece.group, setTexture: piece.setTexture, setQuality: piece.setQuality, update };
}
