import * as THREE from 'three';

// A billboard that shows a real PNJ product cutout (transparent PNG), color-accurate and
// unlit so it matches the catalog exactly. Optional UV crop isolates one piece from a
// product shot that frames a pair (e.g. stud earrings). "Premium" quality adds a soft
// silhouette drop-shadow that grounds the piece on the skin.
const FULL = { x: 0, y: 0, w: 1, h: 1 };

export function createProductPlane(crop = FULL) {
  const group = new THREE.Group();
  const geo = new THREE.PlaneGeometry(1, 1);

  const mat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.35, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;

  // Drop shadow reuses the product's own alpha as its shape.
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.3,
    alphaTest: 0.1,
    depthWrite: false
  });
  const shadow = new THREE.Mesh(geo, shadowMat);
  shadow.renderOrder = 1;
  shadow.visible = false;

  group.add(shadow, mesh);

  let aspect = crop.w / crop.h; // source images are square, so this is the crop's aspect

  function applyCrop(tex) {
    tex.repeat.set(crop.w, crop.h);
    tex.offset.set(crop.x, 1 - crop.y - crop.h); // v is measured from the bottom
  }

  function setTexture(tex) {
    applyCrop(tex);
    mat.map = tex;
    shadowMat.map = tex;
    mat.needsUpdate = true;
    shadowMat.needsUpdate = true;
  }

  function setQuality(q) {
    shadow.visible = q === 'premium';
  }

  // world: THREE.Vector3 (px). size: plane *width* in px. rotZ: radians.
  function place(world, size, rotZ = 0) {
    const h = size / aspect;
    mesh.position.set(world.x, world.y, 0);
    mesh.scale.set(size, h, 1);
    mesh.rotation.z = rotZ;
    shadow.position.set(world.x + size * 0.03, world.y - size * 0.04, -1);
    shadow.scale.set(size * 1.05, h * 1.05, 1);
    shadow.rotation.z = rotZ;
  }

  return { group, setTexture, setQuality, place };
}
