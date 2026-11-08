import * as THREE from "three";

// B.1: fictional Japanese shop types, not actual Kamakura businesses.
// Purely visual / native Three.js. No gameplay or new art pipeline.
const finish = (color: string) =>
  new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, flatShading: true });
const ink = {
  timber: finish("#745d4b"), trim: finish("#e5d8bd"),
  plaster: finish("#efe4cf"), pale: finish("#e0e3d6"),
  glass: finish("#95b7b3"), stone: finish("#b2ac9c"),
  slate: finish("#617777"), clay: finish("#a77969"), sage: finish("#818a79"),
  curtainTeal: finish("#557a6e"), curtainCoral: finish("#bb8c74"),
  curtainBlue: finish("#6f809a"), wood: finish("#806a55"),
  plant: finish("#7d9f83"),
};
const cube = new THREE.BoxGeometry(1, 1, 1);
function box(g: THREE.Group, m: THREE.Material, w: number, h: number, d: number,
  x: number, y: number, z: number): THREE.Mesh {
  const part = new THREE.Mesh(cube, m);
  part.scale.set(w, h, d);
  part.position.set(x, y, z);
  part.castShadow = true;
  part.receiveShadow = true;
  g.add(part);
  return part;
}
type Kind = "tea" | "coffee" | "craft";
type Spec = { name: string; text: string; tint: string;
  wall: THREE.Material; roof: THREE.Material; curtain: THREE.Material };
const designs: Record<Kind, Spec> = {
  tea: { name: "Tea house", text: "茶屋", tint: "#53786d",
    wall: ink.plaster, roof: ink.slate, curtain: ink.curtainTeal },
  coffee: { name: "Kissaten cafe", text: "喫茶", tint: "#85634f",
    wall: ink.pale, roof: ink.clay, curtain: ink.curtainCoral },
  craft: { name: "Zakka craft shop", text: "雑貨", tint: "#586980",
    wall: ink.plaster, roof: ink.sage, curtain: ink.curtainBlue },
};
function shopSign(spec: Spec): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Shop sign requires a 2D canvas context");
  ctx.fillStyle = "#f7efdf";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = spec.tint;
  ctx.lineWidth = 7;
  ctx.strokeRect(8, 8, 368, 112);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = spec.tint;
  ctx.font = 'bold 72px "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';
  ctx.fillText(spec.text, 192, 68);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
function shop(spec: Spec, kind: Kind, upperFloorHeight = 0): THREE.Group {
  const g = new THREE.Group();
  g.name = spec.name + " — native Three.js storefront";
  const width = 1.12, depth = 0.85;
  box(g, ink.stone, 1.24, 0.085, 1.05, 0, 0.043, 0.04);
  box(g, spec.wall, width, 0.74, depth, 0, 0.47, 0);
  // Tall/short alternating machiya façades give Onari an actual SHOP
  // skyline: the original one-storey B.1 archetypes remain the basis.
  // Only an optional upper storey is added; lower sign/door/noren stay.
  if (upperFloorHeight > 0.01) {
    box(g, spec.wall, width * 0.96, upperFloorHeight + 0.035,
      depth * 0.92, 0, 0.84 + upperFloorHeight / 2, 0);
    box(g, ink.timber, width + 0.07, 0.075, depth + 0.075,
      0, 0.855, 0);
    const upperWindowY = 0.88 + upperFloorHeight * 0.53;
    for (const upperX of [-0.31, 0.31]) {
      box(g, ink.timber, 0.26, 0.21, 0.045, upperX, upperWindowY, depth / 2 + 0.015);
      box(g, ink.glass, 0.21, 0.15, 0.053, upperX, upperWindowY, depth / 2 + 0.044);
      for (const dx of [-0.065, 0.065]) {
        box(g, ink.timber, 0.022, 0.19, 0.06,
          upperX + dx, upperWindowY, depth / 2 + 0.080);
      }
    }
    box(g, ink.timber, 1.24, 0.050, 0.07,
      0, 0.84 + upperFloorHeight, depth / 2 + 0.04);
  }
  for (const x of [-0.53, 0.53]) {
    box(g, ink.timber, 0.055, 0.81 + upperFloorHeight, 0.06,
      x, 0.48 + upperFloorHeight / 2, depth / 2 + 0.04);
    box(g, ink.timber, 0.055, 0.75 + upperFloorHeight, depth + 0.03,
      x, 0.47 + upperFloorHeight / 2, 0);
  }
  for (const x of [-0.37, 0.37]) {
    box(g, ink.timber, 0.30, 0.42, 0.04, x, 0.43, depth / 2 + 0.03);
    box(g, ink.glass, 0.24, 0.36, 0.055, x, 0.44, depth / 2 + 0.06);
    box(g, ink.trim, 0.026, 0.38, 0.057, x, 0.43, depth / 2 + 0.095);
    box(g, ink.timber, 0.29, 0.025, 0.057, x, 0.43, depth / 2 + 0.097);
  }
  box(g, ink.wood, 0.29, 0.53, 0.05, 0, 0.34, depth / 2 + 0.07);
  box(g, ink.trim, 0.035, 0.07, 0.04, 0.08, 0.31, depth / 2 + 0.105);

  // Two gabled roof slopes follow the detail language of the accepted houses.
  const run = depth / 2 + 0.14, rise = 0.29;
  const angle = Math.atan2(rise, run), span = Math.hypot(run, rise) + 0.10;
  for (const side of [-1, 1]) {
    const slope = box(g, spec.roof, 1.42, 0.074, span,
      0, 0.91 + upperFloorHeight + rise / 2, side * run / 2);
    slope.rotation.x = side * angle;
  }
  box(g, spec.roof, 1.45, 0.07, 0.10,
    0, 0.91 + upperFloorHeight + rise, 0);

  // Sign projects beyond the roof overhang, avoiding the station's old
  // roof/fascia occlusion. Small noren panels communicate shop identity.
  const signFront = depth / 2 + 0.205;
  box(g, ink.timber, 0.85, 0.26, 0.065, 0, 0.76, signFront - 0.05);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.218),
    new THREE.MeshBasicMaterial({ map: shopSign(spec), side: THREE.DoubleSide }));
  sign.name = spec.name + " generic label";
  sign.position.set(0, 0.76, signFront);
  g.add(sign);
  // A separate storefront canopy/noren roof gives the lower-floor
  // silhouette a recognisable shop eave even at full-board overview.
  box(g, spec.roof, 1.31, 0.060, 0.225,
    0, 0.642, depth / 2 + 0.14);
  box(g, ink.wood, 1.20, 0.055, 0.20, 0, 0.615, depth / 2 + 0.10);
  for (const x of [-0.275, 0, 0.275]) {
    box(g, spec.curtain, 0.245, 0.205, 0.018,
      x, 0.49, depth / 2 + 0.205);
  }

  if (kind === "tea") {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.075, 0.17, 8), ink.wood);
    pot.position.set(0.59, 0.13, 0.54);
    pot.castShadow = true;
    g.add(pot);
    const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.14), ink.plant);
    leaves.position.set(0.59, 0.32, 0.54);
    leaves.castShadow = true;
    g.add(leaves);
  } else if (kind === "coffee") {
    box(g, ink.wood, 0.32, 0.32, 0.06, -0.62, 0.39, 0.47);
    box(g, ink.trim, 0.24, 0.25, 0.065, -0.62, 0.40, 0.50);
  } else {
    for (const x of [-0.32, 0.32]) {
      box(g, ink.wood, 0.075, 0.29, 0.078, x, 0.23, 0.66);
      box(g, ink.trim, 0.18, 0.11, 0.06, x, 0.30, 0.70);
    }
  }
  return g;
}

// Reusable source-quality B.1 archetypes for the cohesive Blueprint-aligned
// B.2 street frontage. The three original B.1 shops stay in this group.
export function createShopfrontArchetype(
  kind: "tea" | "coffee" | "craft", upperFloorHeight = 0,
): THREE.Group {
  return shop(designs[kind], kind, upperFloorHeight);
}

export function createScenicShopfronts(groundY: number): THREE.Group {
  const district = new THREE.Group();
  district.name = "Blockout B.1 — 3 decorative shopfronts";
  const locations: readonly {
    zone: string; kind: Kind; x: number; z: number;
    yaw: number; scale: number;
  }[] = [
    { zone: "B01 Onari", kind: "tea", x: -3.47, z: -5.31,
      yaw: Math.PI / 2, scale: 0.99 },
    { zone: "B03 Onari", kind: "coffee", x: -3.65, z: -1.29,
      yaw: Math.PI / 2, scale: 0.98 },
    { zone: "B05 Wakamiya", kind: "craft", x: 5.03, z: -1.71,
      yaw: -Math.PI / 2, scale: 0.98 },
  ];
  for (const { zone, kind, x, z, yaw, scale } of locations) {
    // Only the lead Onari tea shop gains an upstairs lattice level here.
    // The following Onari café stays low, giving the street a stepped roofline.
    const loft = zone === "B01 Onari" ? 0.40 : 0;
    const building = shop(designs[kind], kind, loft);
    building.position.set(x, groundY, z);
    building.rotation.y = yaw;
    building.scale.setScalar(scale);
    building.name = zone + " / " + building.name;
    district.add(building);
  }
  return district;
}
