import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// A pixel-accurate orthographic stage. World units == screen pixels, origin at the
// top-left in screen terms; `toWorld` flips Y so jewelry lands exactly on the landmarks.
export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true, // transparent — the camera video shows through
    antialias: true,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();

  // Environment map drives the metal & gem reflections (the "sparkle").
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // Camera + lights are (re)configured on resize.
  const camera = new THREE.OrthographicCamera(0, 1, 1, 0, 1, 4000);
  camera.position.set(0, 0, 1000);

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  const rim = new THREE.DirectionalLight(0xbcd3ff, 1.2);
  const spark = new THREE.PointLight(0xffffff, 0.8, 0, 2);
  scene.add(key, rim, spark, new THREE.AmbientLight(0xffffff, 0.25));

  const size = { w: 1, h: 1 };

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    size.w = w;
    size.h = h;
    renderer.setSize(w, h, false);
    camera.left = 0;
    camera.right = w;
    camera.top = h;
    camera.bottom = 0;
    camera.updateProjectionMatrix();
    key.position.set(w * 0.5, h * 0.85, 1400);
    rim.position.set(w * 0.15, h * 0.2, 800);
    spark.position.set(w * 0.5, h * 0.6, 1200);
  }
  resize();
  window.addEventListener('resize', resize);

  // Screen pixels (y-down) -> world Vector3 (y-up).
  const toWorld = (p, target = new THREE.Vector3()) => target.set(p.x, size.h - p.y, 0);

  return {
    renderer,
    scene,
    camera,
    size,
    toWorld,
    add: (obj) => scene.add(obj),
    render: () => renderer.render(scene, camera),
    resize
  };
}
