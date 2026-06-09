import * as THREE from 'three';
import { createProductPlane } from '../productPlane.js';
import { PENDANT } from '../../config.js';
import { OneEuroFilter } from '../../tracking/oneEuro.js';

// Real PNJ pendant worn around the neck: a thin procedural metal chain modelled as a TRUE 3D
// ring that fully (360°) wraps a neck cylinder — the front + sides show and the back is hidden
// by an invisible depth-only occluder, so it reads as a complete necklace and stays wrapped as
// the head turns. Tracking is stabilised with a One Euro filter.
const DEG = Math.PI / 180;

export function createPendant() {
  const group = new THREE.Group();

  // Invisible neck occluder: writes depth only (no colour), so chain segments that wrap behind
  // the neck fail the depth test and disappear — this is what makes it read as *around* the neck.
  const occluder = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 28, 1, true),
    new THREE.MeshBasicMaterial({ colorWrite: false })
  );
  occluder.renderOrder = -1;
  group.add(occluder);

  const chainMat = new THREE.MeshStandardMaterial({
    color: 0xe5e7eb, // Default to a gorgeous white gold/silver
    metalness: 1.0,
    roughness: 0.15, // Highly polished
    envMapIntensity: 2.5 // Highly reflective
  });
  const chain = new THREE.Mesh(new THREE.BufferGeometry(), chainMat);
  chain.renderOrder = 0;
  group.add(chain);

  // Crop the top 20% to remove printed placeholder chains.
  const piece = createProductPlane({ x: 0, y: 0.2, w: 1, h: 0.8 });
  group.add(piece.group);

  // One Euro filters smooth each pose channel independently (industry-standard AR smoothing).
  // Position channels (x/y) stay responsive; radius and the rotation channels (yaw/roll) get a
  // much gentler filter so the necklace doesn't pulse or sway/wobble ("rung") with tiny moves.
  const fo = { minCutoff: PENDANT.FILTER_MIN_CUTOFF, beta: PENDANT.FILTER_BETA };
  const frad = { minCutoff: PENDANT.FILTER_RAD_CUTOFF, beta: PENDANT.FILTER_RAD_BETA };
  const fr = { minCutoff: PENDANT.FILTER_ROT_CUTOFF, beta: PENDANT.FILTER_ROT_BETA };
  const filt = {
    x: new OneEuroFilter(fo),
    y: new OneEuroFilter(fo),
    r: new OneEuroFilter(frad),
    yaw: new OneEuroFilter(fr),
    roll: new OneEuroFilter(fr),
    pitch: new OneEuroFilter(fr)
  };
  const _photo = new THREE.Vector3();

  // center: world Vector3 (px) at the neck centre. size/radius/faceH: px. yaw/roll/pitch: radians.
  function update(center, size, radius, yaw, roll, pitch, faceH) {
    const t = performance.now() / 1000;
    const Cx = filt.x.filter(center.x, t);
    const Cy = filt.y.filter(center.y, t);
    const R = filt.r.filter(radius, t);
    const phi = filt.yaw.filter(yaw, t); // head yaw → ring rotation about the neck axis
    const rollS = filt.roll.filter(roll, t) * PENDANT.ROLL_GAIN; // damped so the ring doesn't sway
    const pitchS = filt.pitch.filter(pitch, t); // head up/down → opens/closes the ring

    const Rc = R * PENDANT.CHAIN_GAP; // chain rides just outside the neck surface
    const tilt = PENDANT.TILT_DEG * DEG + pitchS; // forward tilt + live head pitch
    const frontSag = faceH * PENDANT.FRONT_SAG; // small pendant-weight dip
    const drape = faceH * PENDANT.DRAPE; // soft catenary hang of a real, flexible chain
    const cT = Math.cos(tilt), sT = Math.sin(tilt);
    const cP = Math.cos(phi), sP = Math.sin(phi);
    const cR = Math.cos(rollS), sR = Math.sin(rollS);

    // Sample a FULL circle around the neck's vertical axis, tilt it forward, yaw it with the
    // head, then roll it into screen space. The pendant hangs from whichever point ends up most
    // forward (largest z), so it always sits at the front-bottom by gravity.
    const N = 72;
    const pts = [];
    let frontZ = -Infinity, frontX = Cx, frontY = Cy;
    for (let i = 0; i < N; i++) {
      const alpha = (i / N) * Math.PI * 2;
      const lx = Rc * Math.sin(alpha);
      const lz = Rc * Math.cos(alpha); // +z = front (toward camera), -z = behind the neck
      // forward tilt about X: front dips, nape rises
      const ty = -lz * sT;
      const tz = lz * cT;
      // yaw about Y: the ring turns with the neck
      const yx = lx * cP + tz * sP;
      const yz = -lx * sP + tz * cP;
      const yy = ty;
      // roll about Z + translate into world px
      const sx = Cx + yx * cR - yy * sR;
      let sy = Cy + yx * sR + yy * cR;
      // gravity: the forward-facing arc hangs down in a soft catenary (flexible real chain),
      // plus a small extra dip from the pendant's weight at the very front centre.
      const frontness = Math.max(0, yz / Rc);
      sy -= drape * Math.pow(frontness, PENDANT.DRAPE_POWER);
      sy -= frontSag * frontness * frontness;
      // The most forward point is where the pendant's bail sits (front centre of the chain).
      if (yz > frontZ) { frontZ = yz; frontX = sx; frontY = sy; }
      pts.push(new THREE.Vector3(sx, sy, yz));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal'); // closed loop
    const tubeR = Math.max(1.0, R * PENDANT.CHAIN_THICK); // THIN chain (with a visibility floor)
    chain.geometry.dispose();
    chain.geometry = new THREE.TubeGeometry(curve, 160, tubeR, 6, true);

    // Neck occluder: a tall invisible cylinder pushed BACK in z so it hides the nape + back
    // sides of the chain (making the ring read as a full 360° loop) but never the forward,
    // tilted-down FRONT of the chain. It also tilts with the neck (rollS) so the hidden region
    // tracks the real nape when the head/body leans.
    const occR = R * PENDANT.OCCLUDER_RADIUS;
    occluder.geometry.dispose();
    occluder.geometry = new THREE.CylinderGeometry(occR, occR, faceH * 2.6, 36, 1, true);
    occluder.position.set(Cx, Cy - faceH * 0.2, -R * PENDANT.OCCLUDER_PUSH);
    occluder.rotation.z = rollS;

    // Pendant hangs straight down (gravity) from the chain's front centre (the bail), so it
    // stays connected to the chain and reads as truly worn, without swaying side to side.
    _photo.set(frontX, frontY - size * PENDANT.PHOTO_DROP, 0);
    piece.place(_photo, size, 0);
    piece.group.position.z = frontZ + size * 0.5; // sit in front of the neck & chain
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
