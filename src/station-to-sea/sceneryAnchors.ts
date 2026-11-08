import * as THREE from "three";

// Asset staging anchors retained to preserve the already-accepted M1.3
// station, homes, foliage and figurine geometry exactly as authored.
// These values are NOT the new continuous-board shape, gameplay hex tiles,
// path nodes or a coordinate system for the final Kamakura street network.
// Future scene-asset factories can remove these once given direct transforms.
const previousSceneAnchors: readonly { q: number; r: number; lift: number }[] = [
  { q: -2, r: 0, lift: 0.00 },
  { q: -2, r: 1, lift: 0.02 },
  { q: -2, r: 2, lift: 0.04 },
  { q: -1, r: -1, lift: 0.02 },
  { q: -1, r: 0, lift: 0.07 },
  { q: -1, r: 1, lift: 0.09 },
  { q: -1, r: 2, lift: 0.03 },
  { q: 0, r: -2, lift: 0.00 },
  { q: 0, r: -1, lift: 0.06 },
  { q: 0, r: 0, lift: 0.13 },
  { q: 0, r: 1, lift: 0.08 },
  { q: 0, r: 2, lift: 0.00 },
  { q: 1, r: -2, lift: 0.02 },
  { q: 1, r: -1, lift: 0.06 },
  { q: 1, r: 0, lift: 0.09 },
  { q: 1, r: 1, lift: 0.03 },
  { q: 2, r: -2, lift: 0.01 },
  { q: 2, r: -1, lift: 0.02 },
];

// Compatibility helper for original Three.js scenery constructors only.
// Do not use this to define gameplay nodes or the new map's street layout.
export function tileSurfaceAt(q: number, r: number): THREE.Vector3 {
  const anchor = previousSceneAnchors.find(entry => entry.q === q && entry.r === r);
  if (!anchor) throw new Error(`Unknown legacy scenery anchor (${q}, ${r})`);
  return new THREE.Vector3(
    Math.sqrt(3) * 0.94 * (q + r / 2),
    0.31 + anchor.lift + 0.43 / 2 + 0.045,
    1.5 * 0.94 * r,
  );
}
