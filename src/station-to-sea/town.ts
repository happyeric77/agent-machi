import * as THREE from "three";
import { tileSurfaceAt } from "./sceneryAnchors";

// M1.2 is a hand-arranged scenery study. Nothing here is gameplay path data.
const paint = (color: string): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, flatShading: true });

const ink = {
  timber: paint("#6d5c4b"),
  trim: paint("#d8c9af"),
  plaster: paint("#f0e7d3"),
  cream: paint("#e9dcc7"),
  slate: paint("#53656c"),
  charcoal: paint("#59615d"),
  indigo: paint("#6a7e85"),
  terracotta: paint("#9f776c"),
  shutters: paint("#899388"),
  glazing: paint("#93b5b3"),
  stone: paint("#aaa998"),
  road: paint("#bdbaa8"),
  rail: paint("#677378"),
  sleepers: paint("#695b4f"),
  green: paint("#71917d"),
  moss: paint("#8aa18a"),
  sage: paint("#98b09a"),
  blossom: paint("#d8afa9"),
};

function block(
  parent: THREE.Group,
  material: THREE.Material,
  width: number, height: number, depth: number,
  x: number, y: number, z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function tileGroup(q: number, r: number, rotation = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.copy(tileSurfaceAt(q, r));
  group.rotation.y = rotation;
  return group;
}

// The two broad, shallow roof planes are more legible from an orthographic view
// than thin individual roof tiles and keep draw calls low.
function gabledRoof(
  parent: THREE.Group, width: number, depth: number,
  eave: number, rise: number, material: THREE.Material,
): void {
  const run = depth / 2 + 0.13;
  const angle = Math.atan2(rise, run);
  const length = Math.hypot(run, rise) + 0.10;
  for (const side of [-1, 1]) {
    const plane = block(
      parent, material, width + 0.20, 0.065, length,
      0, eave + rise / 2, side * run / 2,
    );
    plane.rotation.x = side * angle;
  }
  block(parent, material, width + 0.22, 0.075, 0.12, 0, eave + rise, 0);
}

function windowPair(
  parent: THREE.Group, width: number, depth: number,
  height: number,
): void {
  for (const x of [-width * 0.27, width * 0.27]) {
    block(parent, ink.timber, 0.255, 0.28, 0.035, x, height, depth / 2 + 0.020);
    block(parent, ink.glazing, 0.185, 0.205, 0.045, x, height, depth / 2 + 0.047);
    block(parent, ink.trim, 0.026, 0.235, 0.052, x, height, depth / 2 + 0.077);
  }
}

function house(
  q: number, r: number, turn: number,
  wall: THREE.Material, roof: THREE.Material,
): THREE.Group {
  const home = tileGroup(q, r, turn);
  const width = 0.92;
  const depth = 0.79;
  block(home, ink.stone, width + 0.11, 0.09, depth + 0.11, 0, 0.045, 0);
  block(home, wall, width, 0.67, depth, 0, 0.425, 0);
  for (const x of [-width / 2 + 0.06, width / 2 - 0.06]) {
    block(home, ink.timber, 0.048, 0.67, depth + 0.012, x, 0.425, 0);
  }
  block(home, ink.timber, 0.23, 0.45, 0.042, 0, 0.30, depth / 2 + 0.030);
  block(home, ink.trim, 0.045, 0.07, 0.050, 0.067, 0.28, depth / 2 + 0.056);
  windowPair(home, width, depth, 0.58);
  gabledRoof(home, width, depth, 0.79, 0.29, roof);
  return home;
}

function signTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas for station sign unavailable");
  ctx.fillStyle = "#f6f0df";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#7b8e82";
  ctx.lineWidth = 8;
  ctx.strokeRect(6, 6, 500, 116);
  ctx.font = "bold 68px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#425b53";
  ctx.fillText("KAMAKURA", 256, 67);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function station(): THREE.Group {
  // Small station faces the village, with the railway running behind it.
  const stop = tileGroup(-1, -1);
  const width = 1.36;
  const depth = 0.79;
  block(stop, ink.stone, 1.52, 0.09, 1.09, 0, 0.045, 0.09); // platform
  block(stop, ink.timber, width + 0.06, 0.08, depth + 0.04, 0, 0.13, 0);
  block(stop, ink.plaster, width, 0.64, depth, 0, 0.49, 0);

  // Timber pillars, sliding entrance and shallow canopy.
  for (const x of [-0.58, 0, 0.58]) {
    block(stop, ink.timber, 0.06, 0.66, 0.065, x, 0.50, depth / 2 + 0.038);
  }
  block(stop, ink.glazing, 0.30, 0.46, 0.030, -0.30, 0.41, depth / 2 + 0.054);
  block(stop, ink.glazing, 0.30, 0.46, 0.030, 0.30, 0.41, depth / 2 + 0.054);
  for (const x of [-0.29, 0.29]) {
    block(stop, ink.timber, 0.03, 0.46, 0.045, x, 0.41, depth / 2 + 0.084);
  }

  gabledRoof(stop, width + 0.07, depth + 0.04, 0.87, 0.31, ink.slate);
  block(stop, ink.terracotta, width + 0.13, 0.055, 0.06, 0, 0.86, depth / 2 + 0.14);

  // The roof overhang sits ahead of the facade from our orthographic view.
  // Mount a larger sign on a shallow projecting fascia, below the eaves
  // and in front of the roof silhouette, so the station name stays readable.
  const signHeight = 0.71;
  const signFront = depth / 2 + 0.305;
  block(stop, ink.timber, 1.19, 0.34, 0.06, 0, signHeight, signFront - 0.052);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.12, 0.275),
    new THREE.MeshBasicMaterial({ map: signTexture(), side: THREE.DoubleSide }),
  );
  sign.position.set(0, signHeight, signFront);
  sign.name = "KAMAKURA station fascia";
  stop.add(sign);

  stop.name = "Kamakura-inspired miniature station";
  return stop;
}

function railway(): THREE.Group {
  const tracks = new THREE.Group();
  tracks.name = "Decorative railway (not a playable path)";
  const z = tileSurfaceAt(1, -2).z;
  // Slightly raised on tile tops; the small terrain elevation offsets are intentional.
  const y = tileSurfaceAt(1, -2).y + 0.075;
  block(tracks, ink.stone, 4.74, 0.03, 0.78, 0, y - 0.06, z);
  for (let i = 0; i < 15; i += 1) {
    const x = -2.20 + i * (4.40 / 14);
    block(tracks, ink.sleepers, 0.16, 0.07, 0.68, x, y - 0.02, z);
  }
  for (const side of [-1, 1]) {
    block(tracks, ink.rail, 4.65, 0.075, 0.075, 0, y + 0.045, z + side * 0.225);
  }
  return tracks;
}

function tree(
  q: number, r: number, x: number, z: number,
  canopy: THREE.Material, size: number,
): THREE.Group {
  const plant = tileGroup(q, r);
  block(plant, ink.timber, 0.10 * size, 0.47 * size, 0.10 * size,
    x, 0.23 * size, z);
  const foliage = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.37 * size, 0), canopy,
  );
  foliage.position.set(x, 0.66 * size, z);
  foliage.castShadow = true;
  foliage.receiveShadow = true;
  plant.add(foliage);
  return plant;
}

function shrub(q: number, r: number, x: number, z: number): THREE.Group {
  const plant = tileGroup(q, r);
  const foliage = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 0), ink.moss);
  foliage.position.set(x, 0.17, z);
  foliage.castShadow = true;
  plant.add(foliage);
  return plant;
}

function paving(q: number, r: number): THREE.Group {
  const lane = tileGroup(q, r);
  // Street atmosphere only. Formal branching routes are deferred to M1.3 / gameplay ADR.
  block(lane, ink.road, 1.00, 0.025, 0.42, 0, 0.027, 0);
  for (const x of [-0.28, 0, 0.28]) {
    block(lane, ink.stone, 0.19, 0.015, 0.35, x, 0.049, 0);
  }
  return lane;
}

// Reuse the IDENTICAL original M1 house/foliage constructors for Blockout
// B.2. These public factories add no low-detail replacement geometry.
// They decouple new full-map placements from the old 18-tile staging origins.
export type ResidenceVariant = 0 | 1 | 2 | 3;

export function createResidentialHouse(variant: ResidenceVariant): THREE.Group {
  const palette: readonly { wall: THREE.Material; roof: THREE.Material }[] = [
    { wall: ink.cream, roof: ink.indigo },
    { wall: ink.plaster, roof: ink.charcoal },
    { wall: ink.cream, roof: ink.terracotta },
    { wall: ink.plaster, roof: ink.slate },
  ];
  const chosen = palette[variant];
  if (!chosen) throw new Error("Unknown residential color variant");
  const building = house(-2, 1, 0, chosen.wall, chosen.roof);
  building.position.set(0, 0, 0);
  building.name = "Detailed original M1-style residence / variant " + variant;
  return building;
}

export function createResidentialTree(variant: 0 | 1): THREE.Group {
  const newTree = variant === 0
    ? tree(-2, 2, 0, 0, ink.green, 0.94)
    : tree(0, 1, 0, 0, ink.sage, 0.89);
  newTree.position.set(0, 0, 0);
  return newTree;
}

export function createResidentialShrub(): THREE.Group {
  const newShrub = shrub(-1, 2, 0, 0);
  newShrub.position.set(0, 0, 0);
  return newShrub;
}

export function createTown(): THREE.Group {
  const town = new THREE.Group();
  town.name = "Japanese town visual study — M1.2";

  town.add(station());
  town.add(railway());

  // Four authored houses; variation is limited to palette and orientation.
  town.add(house(-2, 1, 0.12, ink.cream, ink.indigo));
  town.add(house(-1, 1, -0.10, ink.plaster, ink.charcoal));
  town.add(house(0, 2, 0.17, ink.cream, ink.terracotta));
  town.add(house(1, 0, -0.12, ink.plaster, ink.slate));

  for (const [q, r] of [[-2, 0], [-1, 0], [0, 0]] as const) {
    town.add(paving(q, r));
  }

  town.add(tree(-2, 2, -0.07, 0.04, ink.green, 0.94));
  town.add(tree(0, 1, -0.12, -0.04, ink.sage, 0.89));
  town.add(tree(2, -1, 0.03, 0.08, ink.blossom, 1.02));
  town.add(tree(1, -1, 0.17, 0.09, ink.moss, 0.84));

  town.add(shrub(-1, 2, -0.34, 0.12));
  town.add(shrub(-1, 2, 0.28, -0.14));
  town.add(shrub(1, 1, 0.29, -0.16));
  town.add(shrub(1, 1, -0.33, 0.18));

  return town;
}
