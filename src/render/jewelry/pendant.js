import * as THREE from 'three';
import { createProductPlane } from '../productPlane.js';

// Real PNJ pendant on the neckline: the product cutout plus a procedural gold chain that
// drapes in a smooth curve from the sides of the neck down through the pendant's bail — so it
// reads as worn "around the neck", not a flat bar across the chest.
const UP = new THREE.Vector3(0, 1, 0);

export function createPendant() {
  const group = new THREE.Group();
  // Crop the top 20% to remove printed placeholder chains
  const piece = createProductPlane({ x: 0, y: 0.2, w: 1, h: 0.8 });
  group.add(piece.group);

  const chainMat = new THREE.MeshStandardMaterial({
    color: 0xe5e7eb, // Default to a gorgeous white gold/silver
    metalness: 1.0,
    roughness: 0.15, // Highly polished
    envMapIntensity: 2.5 // Highly reflective
  });
  const chain = new THREE.Mesh(new THREE.BufferGeometry(), chainMat);
  chain.position.z = -2; // sit just behind the pendant
  group.add(chain);

  // center/neck*: world Vector3 (px). size: pendant width in px.
  function update(center, size, neckLeft, neckRight) {
    // Shift the plane center down by 0.1 * size to account for the top crop
    const shiftedCenter = center.clone().addScaledVector(UP, -size * 0.1);
    piece.place(shiftedCenter, size, 0);

    // The loop of the pendant is at center + 0.16 * size
    const bail = center.clone().addScaledVector(UP, size * 0.16);
    // Centripetal Catmull-Rom passes through all three points without overshoot, giving a
    // natural draped curve: up at the neck sides, dipping through the bail.
    const curve = new THREE.CatmullRomCurve3(
      [neckLeft.clone(), bail, neckRight.clone()],
      false,
      'centripetal'
    );
    const r = Math.max(1.2, size * 0.01); // Slightly thicker for better specular highlights
    chain.geometry.dispose();
    chain.geometry = new THREE.TubeGeometry(curve, 64, r, 8, false);
  }

  function setMetalColor(colorName) {
    if (colorName === 'white') {
      chainMat.color.setHex(0xe5e7eb);
    } else {
      chainMat.color.setHex(0xf4d493);
    }
    chainMat.needsUpdate = true;
  }

  return { group, setTexture: piece.setTexture, setQuality: piece.setQuality, update, setMetalColor };
}
