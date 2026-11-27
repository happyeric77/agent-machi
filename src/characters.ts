import * as THREE from "three";

// Residents are modular the LEGO way: one standard body, six fixed silhouette
// modules (the existing cast's hat + bag pairs) and three colour zones drawn
// from one curated palette. Nothing here is generated geometry; a resident's
// module and colours are a pure function of its raw pane_id string.
export interface PaletteColor {
  name: string;
  hex: string;
}

export const PALETTE: readonly PaletteColor[] = [
  { name: "Amber", hex: "#f2b705" },
  { name: "Teal", hex: "#3d9bb5" },
  { name: "Moss", hex: "#8fbf6a" },
  { name: "Plum", hex: "#c47fc9" },
  { name: "Slate", hex: "#93a9c9" },
  { name: "Sand", hex: "#e8bd63" },
  { name: "Rust", hex: "#ad6643" },
  { name: "Straw", hex: "#e5c78a" },
  { name: "Navy", hex: "#45636b" },
  { name: "Kelp", hex: "#4f6b46" },
];

const FACE = "#f1d2a9";
const EYES = "#4c534b";
const LINEN = "#f7ebcf";

export type SilhouetteModule = "sunhat" | "sailor" | "bucket" | "beret" | "cap" | "beanie";

export const MODULES: readonly SilhouetteModule[] = [
  "sunhat",
  "sailor",
  "bucket",
  "beret",
  "cap",
  "beanie",
];

export interface Look {
  module: SilhouetteModule;
  head: PaletteColor;
  torso: PaletteColor;
  legs: PaletteColor;
}

/** FNV-1a over the raw pane_id: same resident, same look, in any mode. */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function lookFor(paneId: string): Look {
  const module = MODULES[stableHash(paneId) % MODULES.length];
  const head = PALETTE[stableHash(`${paneId}|head`) % PALETTE.length];
  // Head and torso never match, so the hat reads against the tunic.
  const torso =
    PALETTE[
      (PALETTE.indexOf(head) + 1 + (stableHash(`${paneId}|torso`) % (PALETTE.length - 1))) %
        PALETTE.length
    ];
  const legs = PALETTE[stableHash(`${paneId}|legs`) % PALETTE.length];
  return { module, head, torso, legs };
}

function material(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true });
}

function part(
  parent: THREE.Group,
  geometry: THREE.BufferGeometry,
  paint: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, paint);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function pawnBase(group: THREE.Group, torso: THREE.Material, legs: THREE.Material): void {
  part(group, new THREE.CylinderGeometry(0.198, 0.205, 0.052, 14), legs, 0, 0.037, 0);
  part(group, new THREE.CylinderGeometry(0.162, 0.162, 0.034, 14), material(LINEN), 0, 0.079, 0);
  part(group, new THREE.CylinderGeometry(0.100, 0.141, 0.280, 10), torso, 0, 0.224, 0);
  for (const x of [-0.138, 0.138]) {
    const arm = part(group, new THREE.IcosahedronGeometry(0.060, 0), torso, x, 0.264, 0.010);
    arm.scale.set(0.72, 1.27, 0.85);
  }
  part(group, new THREE.CylinderGeometry(0.112, 0.108, 0.055, 10), material(LINEN), 0, 0.371, 0);
  part(group, new THREE.IcosahedronGeometry(0.136, 1), material(FACE), 0, 0.473, 0);
  for (const x of [-0.049, 0.049]) {
    part(group, new THREE.IcosahedronGeometry(0.016, 0), material(EYES), x, 0.485, 0.126);
  }
}

type Hat = (group: THREE.Group, head: THREE.Material, band: THREE.Material) => void;
type Bag = (group: THREE.Group, body: THREE.Material) => void;

const sunhat: Hat = (group, head, band) => {
  part(group, new THREE.CylinderGeometry(0.237, 0.237, 0.036, 14), head, 0, 0.616, 0);
  part(group, new THREE.CylinderGeometry(0.134, 0.158, 0.132, 12), head, 0, 0.687, 0);
  part(group, new THREE.CylinderGeometry(0.159, 0.16, 0.033, 12), band, 0, 0.648, 0);
};

const sailor: Hat = (group, head, band) => {
  part(group, new THREE.CylinderGeometry(0.157, 0.135, 0.121, 12), head, 0, 0.637, 0);
  part(group, new THREE.BoxGeometry(0.22, 0.032, 0.135), head, 0, 0.591, 0.116);
  part(group, new THREE.BoxGeometry(0.112, 0.026, 0.02), band, 0, 0.653, 0.138);
};

const bucket: Hat = (group, head, band) => {
  part(group, new THREE.CylinderGeometry(0.228, 0.228, 0.03, 14), head, 0, 0.598, 0);
  part(group, new THREE.CylinderGeometry(0.14, 0.155, 0.115, 12), head, 0, 0.666, 0);
  part(group, new THREE.CylinderGeometry(0.158, 0.158, 0.026, 12), band, 0, 0.636, 0);
};

const beret: Hat = (group, head, band) => {
  const cap = part(group, new THREE.SphereGeometry(0.158, 14, 8), head, 0.018, 0.641, 0);
  cap.scale.set(1.12, 0.48, 1.12);
  cap.rotation.z = -0.16;
  part(group, new THREE.CylinderGeometry(0.022, 0.022, 0.045, 8), band, 0.02, 0.694, 0);
  part(group, new THREE.CylinderGeometry(0.15, 0.15, 0.024, 12), band, 0, 0.606, 0);
};

const cap: Hat = (group, head, band) => {
  part(group, new THREE.SphereGeometry(0.148, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), head, 0, 0.612, 0);
  part(group, new THREE.BoxGeometry(0.23, 0.03, 0.142), head, 0, 0.611, 0.122);
  part(group, new THREE.BoxGeometry(0.15, 0.032, 0.024), band, 0, 0.636, 0.138);
};

const beanie: Hat = (group, head, band) => {
  part(group, new THREE.CylinderGeometry(0.152, 0.148, 0.145, 12), head, 0, 0.655, 0);
  part(group, new THREE.CylinderGeometry(0.158, 0.158, 0.038, 12), band, 0, 0.589, 0);
  part(group, new THREE.SphereGeometry(0.071, 10, 8), band, 0, 0.744, 0);
};

const satchel: Bag = (group, body) => {
  const bag = part(group, new THREE.BoxGeometry(0.146, 0.192, 0.112), body, 0.168, 0.235, 0.08);
  bag.rotation.z = -0.1;
  const strap = part(group, new THREE.BoxGeometry(0.022, 0.252, 0.025), material(LINEN), 0.045, 0.259, 0.148);
  strap.rotation.z = 0.4;
};

const travelPouch: Bag = (group, body) => {
  part(group, new THREE.BoxGeometry(0.085, 0.152, 0.052), material(LINEN), 0.016, 0.294, 0.128);
  const pouch = part(group, new THREE.BoxGeometry(0.14, 0.165, 0.102), body, 0.162, 0.215, 0.081);
  pouch.rotation.z = 0.15;
  const strap = part(group, new THREE.BoxGeometry(0.022, 0.248, 0.027), material(LINEN), 0.055, 0.281, 0.142);
  strap.rotation.z = -0.46;
};

const backpack: Bag = (group, body) => {
  part(group, new THREE.BoxGeometry(0.166, 0.214, 0.092), body, 0, 0.246, -0.128);
  part(group, new THREE.BoxGeometry(0.038, 0.23, 0.02), material(LINEN), -0.079, 0.264, -0.079);
  part(group, new THREE.BoxGeometry(0.038, 0.23, 0.02), material(LINEN), 0.079, 0.264, -0.079);
  part(group, new THREE.BoxGeometry(0.11, 0.058, 0.022), material(LINEN), 0, 0.186, -0.181);
};

const scarf: Bag = (group, body) => {
  part(group, new THREE.TorusGeometry(0.118, 0.036, 8, 14), body, 0, 0.365, 0).rotation.x = Math.PI / 2;
  const tail = part(group, new THREE.BoxGeometry(0.078, 0.172, 0.032), body, 0.064, 0.286, 0.135);
  tail.rotation.z = 0.18;
  part(group, new THREE.BoxGeometry(0.056, 0.044, 0.034), material(LINEN), 0.064, 0.207, 0.135);
};

const sideBag: Bag = (group, body) => {
  const pouch = part(group, new THREE.BoxGeometry(0.138, 0.172, 0.096), body, -0.166, 0.216, 0.075);
  pouch.rotation.z = 0.16;
  const strap = part(group, new THREE.BoxGeometry(0.022, 0.26, 0.027), material(LINEN), -0.052, 0.282, 0.144);
  strap.rotation.z = -0.44;
  part(group, new THREE.BoxGeometry(0.096, 0.028, 0.102), material(LINEN), -0.166, 0.302, 0.075);
};

const canteen: Bag = (group, body) => {
  part(group, new THREE.CylinderGeometry(0.052, 0.058, 0.116, 10), body, 0.196, 0.19, 0.048);
  part(group, new THREE.CylinderGeometry(0.023, 0.023, 0.034, 8), material(LINEN), 0.196, 0.263, 0.048);
  part(group, new THREE.TorusGeometry(0.037, 0.01, 6, 12, Math.PI), material("#8b6b43"), 0.196, 0.258, 0.048)
    .rotation.z = Math.PI / 2;
};

const PARTS: Record<SilhouetteModule, { hat: Hat; bag: Bag }> = {
  sunhat: { hat: sunhat, bag: satchel },
  sailor: { hat: sailor, bag: travelPouch },
  bucket: { hat: bucket, bag: backpack },
  beret: { hat: beret, bag: scarf },
  cap: { hat: cap, bag: sideBag },
  beanie: { hat: beanie, bag: canteen },
};

export function createCharacter(look: Look): THREE.Group {
  const group = new THREE.Group();
  const head = material(look.head.hex);
  const torso = material(look.torso.hex);
  const legs = material(look.legs.hex);
  group.name = `${look.torso.name} resident (agent-machi character)`;
  pawnBase(group, torso, legs);
  const parts = PARTS[look.module];
  parts.hat(group, head, torso);
  parts.bag(group, legs);
  return group;
}

export interface NameTag {
  sprite: THREE.Sprite;
  setText: (text: string) => void;
  dispose: () => void;
}

export function createNameTag(initial: string): NameTag {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Missing 2D canvas context for name tag");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(1.75, 0.438, 1);
  sprite.position.set(0, 1.02, 0);
  sprite.renderOrder = 2;

  let current = "";
  const setText = (text: string): void => {
    if (text === current) return;
    current = text;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(22, 30, 26, 0.78)";
    context.beginPath();
    context.roundRect(4, 8, 248, 48, 12);
    context.fill();

    let size = 28;
    context.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    while (size > 16 && context.measureText(text).width > 228) {
      size -= 2;
      context.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    }
    context.fillStyle = "#f7f4e8";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, 128, 33, 228);
    texture.needsUpdate = true;
  };
  setText(initial);

  return {
    sprite,
    setText,
    dispose: () => {
      texture.dispose();
      (sprite.material as THREE.SpriteMaterial).dispose();
    },
  };
}
