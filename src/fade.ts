import type { Material, Mesh, Object3D } from "three";

interface FadeEntry {
  target: Mesh;
  original: Material | Material[];
  clone: Material | Material[];
  opacity: number[];
}

export interface FadeController {
  set: (factor: number) => void;
  dispose: () => void;
}

function asArray(value: Material | Material[]): Material[] {
  return Array.isArray(value) ? value : [value];
}

// Clones each material once so fading one traveller cannot dim another
// traveller that shares the submodule's paint objects.
export function createFadeController(object: Object3D): FadeController {
  const entries: FadeEntry[] = [];

  object.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.material) return;
    const originals = asArray(mesh.material);
    const clones = originals.map((material) => {
      const clone = material.clone();
      clone.transparent = true;
      return clone;
    });
    entries.push({
      target: mesh,
      original: mesh.material,
      clone: Array.isArray(mesh.material) ? clones : clones[0],
      opacity: originals.map((material) => material.opacity ?? 1),
    });
    mesh.material = Array.isArray(mesh.material) ? clones : clones[0];
  });

  return {
    set(factor: number) {
      const clamped = Math.max(0, Math.min(1, factor));
      for (const entry of entries) {
        asArray(entry.clone).forEach((material, index) => {
          material.opacity = entry.opacity[index] * clamped;
        });
      }
    },
    dispose() {
      for (const entry of entries) {
        entry.target.material = entry.original;
        for (const material of asArray(entry.clone)) material.dispose();
      }
      entries.length = 0;
    },
  };
}
