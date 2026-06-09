import * as THREE from 'three';
import { createProductPlane } from '../productPlane.js';

// Real PNJ pendant on the neckline: the product cutout plus a procedural gold chain that
// drapes in a smooth curve from the sides of the neck down through the pendant's bail — so it
// reads as worn "around the neck", not a flat bar across the chest.
const UP = new THREE.Vector3(0, 1, 0);

export function createPendant() {
  const group = new THREE.Group();
  const piece = createProductPlane();
  group.add(piece.group);

  const chainMat = new THREE.MeshStandardMaterial({
    color: 0xf4d493,
    metalness: 1.0,
    roughness: 0.28,
    envMapIntensity: 1.5
  });
  const chain = new THREE.Mesh(new THREE.BufferGeometry(), chainMat);
  chain.position.z = -2; // sit just behind the pendant
  group.add(chain);

  // center/neck*: world Vector3 (px). size: pendant width in px.
  function update(center, size, neckLeft, neckRight) {
    piece.place(center, size, 0);

    const bail = center.clone().addScaledVector(UP, size * 0.34); // top of the pendant
    // Centripetal Catmull-Rom passes through all three points without overshoot, giving a
    // natural draped curve: up at the neck sides, dipping through the bail.
    const curve = new THREE.CatmullRomCurve3(
      [neckLeft.clone(), bail, neckRight.clone()],
      false,
      'centripetal'
    );
    const r = Math.max(1, size * 0.009);
    chain.geometry.dispose();
    chain.geometry = new THREE.TubeGeometry(curve, 56, r, 8, false);
  }

  return { group, setTexture: piece.setTexture, setQuality: piece.setQuality, update };
}
