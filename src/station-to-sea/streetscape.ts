import * as THREE from "three";
import { createShopfrontArchetype } from "./shops";

// The 2D illustration depicts GROUPS of houses and storefronts, not
// isolated product samples. This scenic visual layer creates a continuous
// block rhythm using the existing detailed B.1 shop archetypes. No gameplay,
// georeferenced shop claims, private map sources or new HTML routes.
const finish = (color: string) =>
  new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true });
const streetStone = finish("#c2b9a7");
const paleStone = finish("#d4cabb");
const warmStone = finish("#a89c87");
const vermilion = finish("#bb614e");
const gateBlack = finish("#565a51");
const softGreen = finish("#91a58c");
const cube = new THREE.BoxGeometry(1, 1, 1);

function block(
  parent: THREE.Group, material: THREE.Material,
  width: number, height: number, depth: number,
  x: number, y: number, z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(cube, material);
  mesh.scale.set(width, height, depth);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function storefrontSidewalk(
  parent: THREE.Group,
  label: string, x: number, z: number, length: number, groundY: number,
): void {
  const frontage = new THREE.Group();
  frontage.name = label + " — low shopfront threshold, not a road graph";
  // Short segmented paving in front of a linked row of miniature shops.
  // Pavement sits on the grass verge, OUTSIDE the named road ribbon.
  block(frontage, streetStone, 0.22, 0.022, length,
    x, groundY + 0.025, z);
  for (let i = 0; i < Math.floor(length / 0.46); i += 1) {
    const along = z - length / 2 + 0.23 + i * 0.46;
    block(frontage, paleStone, 0.19, 0.003, 0.025,
      x, groundY + 0.041, along);
  }
  parent.add(frontage);
}

function torii(groundY: number): THREE.Group {
  // Modest Ichi-no-Torii-INSPIRED distant silhouette on the B08 axis.
  // Exact placement/real-world station geometry is NOT surveyed.
  const gate = new THREE.Group();
  gate.name = "B08 Ichi-no-Torii-inspired visual landmark (schematic)";
  gate.position.set(3.70, groundY, 3.53);
  for (const x of [-0.69, 0.69]) {
    block(gate, paleStone, 0.22, 0.08, 0.22, x, 0.05, 0);
    block(gate, vermilion, 0.11, 1.50, 0.11, x, 0.81, 0);
    block(gate, vermilion, 0.16, 0.11, 0.15, x, 1.58, 0);
  }
  block(gate, vermilion, 1.70, 0.11, 0.19, 0, 1.22, 0);
  block(gate, vermilion, 2.01, 0.18, 0.21, 0, 1.69, 0);
  block(gate, gateBlack, 2.10, 0.042, 0.235, 0, 1.80, 0);
  // Small flat ties stop it from resembling an arbitrary gatepost.
  block(gate, gateBlack, 0.23, 0.14, 0.025, 0, 1.50, 0.13);
  return gate;
}

function coastalGardenEnds(groundY: number): THREE.Group {
  const edge = new THREE.Group();
  edge.name = "B09 split low coastal verges; pawn space C remains open";
  // Compact shoulder/low planters either side of the B09 entrance.
  // The central corridor near (-0.12, 4.55) is intentionally EMPTY.
  for (const [x, z] of [[-2.64, 4.57], [2.69, 4.58]] as const) {
    block(edge, warmStone, 0.72, 0.115, 0.26,
      x, groundY + 0.075, z);
    for (const dx of [-0.21, 0, 0.21]) {
      const hedge = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.115, 0), softGreen,
      );
      hedge.position.set(x + dx, groundY + 0.23, z);
      hedge.castShadow = true;
      edge.add(hedge);
    }
  }
  return edge;
}

export function createBlueprintStreetfronts(groundY: number): THREE.Group {
  const streets = new THREE.Group();
  streets.name = "B.2 corrected Blueprint street-block alignment";

  // B.1 sample shops stay as originally authored, with only slight spacing
  // adjustment on the B.2 branch to complete the four-shop Onari frontage.
  const plots: readonly {
    zone: string; kind: "tea" | "coffee" | "craft";
    x: number; z: number; yaw: number; scale: number;
  }[] = [
    { zone: "B01 Onari continuous frontage", kind: "craft",
      x: -3.67, z: -3.98, yaw: Math.PI / 2, scale: 0.83 },
    { zone: "B03 Onari continuous frontage", kind: "tea",
      x: -3.55, z: -2.62, yaw: Math.PI / 2, scale: 0.83 },
    { zone: "B02 east-gate storefront row", kind: "tea",
      x: 5.08, z: -4.94, yaw: -Math.PI / 2, scale: 0.90 },
    { zone: "B02/B05 Wakamiya streetfront", kind: "coffee",
      x: 5.08, z: -3.33, yaw: -Math.PI / 2, scale: 0.90 },
    { zone: "B08 south Wakamiya frontage", kind: "craft",
      x: 5.05, z: 2.38, yaw: -Math.PI / 2, scale: 0.87 },
  ];
  for (const { zone, kind, x, z, yaw, scale } of plots) {
    // Match the approved 2D town's staggered roof rhythm: B01/B03
    // get an alternating short upstairs lattice. Other districts retain
    // their previous facade shapes in this focused pass.
    const loft = zone.includes("Onari")
      ? (kind === "craft" ? 0.24 : 0.33)
      : 0;
    const building = createShopfrontArchetype(kind, loft);
    building.name = zone + " / " + building.name;
    building.position.set(x, groundY, z);
    building.rotation.y = yaw;
    building.scale.setScalar(scale);
    streets.add(building);
  }
  // The offset paving follows the slightly stepped shop façades, while
  // leaving the Onari road ribbon itself fully open.
  storefrontSidewalk(streets, "B01/B03 Onari shop edge",
    -2.88, -3.30, 4.10, groundY);
  storefrontSidewalk(streets, "B02/B05 Wakamiya shop edge",
    4.49, -3.36, 4.10, groundY);
  storefrontSidewalk(streets, "B08 south boulevard verge",
    4.47, 2.38, 0.85, groundY);

  streets.add(torii(groundY));
  streets.add(coastalGardenEnds(groundY));
  return streets;
}
