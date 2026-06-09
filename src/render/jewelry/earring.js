import { createProductPlane } from '../productPlane.js';
import { FACE } from '../../config.js';

// Real PNJ earring on the earlobe. PNJ stud shots frame the *pair*, so we crop to the
// front-facing piece (left side of the image) and place that single stud on each lobe.
export function createEarring() {
  const piece = createProductPlane(FACE.EARRING_CROP);

  // world: earlobe anchor (Vector3, px). size: plane width in px.
  function update(world, size) {
    piece.place(world, size, 0);
  }

  return { group: piece.group, setTexture: piece.setTexture, setQuality: piece.setQuality, update };
}
