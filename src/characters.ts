import * as THREE from "three";

export const TRAVELLERS = ["Amber", "Teal", "Moss", "Plum", "Slate", "Sand"] as const;
export type TravellerName = (typeof TRAVELLERS)[number];

export const ACCENTS: Record<TravellerName, string> = {
  Amber: "#f2b705",
  Teal: "#3d9bb5",
  Moss: "#8fbf6a",
  Plum: "#c47fc9",
  Slate: "#93a9c9",
  Sand: "#e8bd63",
};

const FACE = "#f1d2a9";
const EYES = "#4c534b";
const LINEN = "#f7ebcf";

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

function pawnBase(group: THREE.Group, main: THREE.Material): void {
  part(group, new THREE.CylinderGeometry(0.198, 0.205, 0.052, 14), main, 0, 0.037, 0);
  part(group, new THREE.CylinderGeometry(0.162, 0.162, 0.034, 14), material(LINEN), 0, 0.079, 0);
  part(group, new THREE.CylinderGeometry(0.100, 0.141, 0.280, 10), main, 0, 0.224, 0);
  for (const x of [-0.138, 0.138]) {
    const arm = part(group, new THREE.IcosahedronGeometry(0.060, 0), main, x, 0.264, 0.010);
    arm.scale.set(0.72, 1.27, 0.85);
  }
  part(group, new THREE.CylinderGeometry(0.112, 0.108, 0.055, 10), material(LINEN), 0, 0.371, 0);
  part(group, new THREE.IcosahedronGeometry(0.136, 1), material(FACE), 0, 0.473, 0);
  for (const x of [-0.049, 0.049]) {
    part(group, new THREE.IcosahedronGeometry(0.016, 0), material(EYES), x, 0.485, 0.126);
  }
}

function bucketHat(group: THREE.Group, main: THREE.Material, accent: THREE.Material): void {
  part(group, new THREE.CylinderGeometry(0.228, 0.228, 0.030, 14), main, 0, 0.598, 0);
  part(group, new THREE.CylinderGeometry(0.140, 0.155, 0.115, 12), main, 0, 0.666, 0);
  part(group, new THREE.CylinderGeometry(0.158, 0.158, 0.026, 12), accent, 0, 0.636, 0);
}

function beret(group: THREE.Group, main: THREE.Material, accent: THREE.Material): void {
  const cap = part(group, new THREE.SphereGeometry(0.158, 14, 8), main, 0.018, 0.641, 0);
  cap.scale.set(1.12, 0.48, 1.12);
  cap.rotation.z = -0.16;
  part(group, new THREE.CylinderGeometry(0.022, 0.022, 0.045, 8), accent, 0.02, 0.694, 0);
  part(group, new THREE.CylinderGeometry(0.150, 0.150, 0.024, 12), accent, 0, 0.606, 0);
}

function capHat(group: THREE.Group, main: THREE.Material, accent: THREE.Material): void {
  part(group, new THREE.SphereGeometry(0.148, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), main, 0, 0.612, 0);
  part(group, new THREE.BoxGeometry(0.230, 0.030, 0.142), main, 0, 0.611, 0.122);
  part(group, new THREE.BoxGeometry(0.150, 0.032, 0.024), accent, 0, 0.636, 0.138);
}

function beanie(group: THREE.Group, main: THREE.Material, accent: THREE.Material): void {
  part(group, new THREE.CylinderGeometry(0.152, 0.148, 0.145, 12), main, 0, 0.655, 0);
  part(group, new THREE.CylinderGeometry(0.158, 0.158, 0.038, 12), accent, 0, 0.589, 0);
  part(group, new THREE.SphereGeometry(0.071, 10, 8), accent, 0, 0.744, 0);
}

function backpack(group: THREE.Group, color: string): void {
  const pack = material(color);
  part(group, new THREE.BoxGeometry(0.166, 0.214, 0.092), pack, 0, 0.246, -0.128);
  part(group, new THREE.BoxGeometry(0.038, 0.230, 0.020), material(LINEN), -0.079, 0.264, -0.079);
  part(group, new THREE.BoxGeometry(0.038, 0.230, 0.020), material(LINEN), 0.079, 0.264, -0.079);
  part(group, new THREE.BoxGeometry(0.110, 0.058, 0.022), material(LINEN), 0, 0.186, -0.181);
}

function scarf(group: THREE.Group, color: string): void {
  const cloth = material(color);
  part(group, new THREE.TorusGeometry(0.118, 0.036, 8, 14), cloth, 0, 0.365, 0).rotation.x = Math.PI / 2;
  const tail = part(group, new THREE.BoxGeometry(0.078, 0.172, 0.032), cloth, 0.064, 0.286, 0.135);
  tail.rotation.z = 0.18;
  part(group, new THREE.BoxGeometry(0.056, 0.044, 0.034), material(LINEN), 0.064, 0.207, 0.135);
}

function sideBag(group: THREE.Group, color: string): void {
  const bag = material(color);
  const pouch = part(group, new THREE.BoxGeometry(0.138, 0.172, 0.096), bag, -0.166, 0.216, 0.075);
  pouch.rotation.z = 0.16;
  const strap = part(group, new THREE.BoxGeometry(0.022, 0.260, 0.027), material(LINEN), -0.052, 0.282, 0.144);
  strap.rotation.z = -0.44;
  part(group, new THREE.BoxGeometry(0.096, 0.028, 0.102), material(LINEN), -0.166, 0.302, 0.075);
}

function canteen(group: THREE.Group, color: string): void {
  const body = material(color);
  part(group, new THREE.CylinderGeometry(0.052, 0.058, 0.116, 10), body, 0.196, 0.190, 0.048);
  part(group, new THREE.CylinderGeometry(0.023, 0.023, 0.034, 8), material(LINEN), 0.196, 0.263, 0.048);
  part(group, new THREE.TorusGeometry(0.037, 0.010, 6, 12, Math.PI), material("#8b6b43"), 0.196, 0.258, 0.048)
    .rotation.z = Math.PI / 2;
}

function resident(slot: 2 | 3 | 4 | 5): THREE.Group {
  const group = new THREE.Group();
  const styles = [
    { name: "Moss", main: "#5f7d4a", accent: "#a9c97e", hat: "bucket" },
    { name: "Plum", main: "#7d4b86", accent: "#d0a0d5", hat: "beret" },
    { name: "Slate", main: "#5b7085", accent: "#a9bcd6", hat: "cap" },
    { name: "Sand", main: "#b08d4f", accent: "#e8c77f", hat: "beanie" },
  ] as const;
  const style = styles[slot - 2];
  const main = material(style.main);
  const accent = material(style.accent);

  group.name = `${style.name} resident (agent-machi character)`;
  pawnBase(group, main);

  if (style.hat === "bucket") bucketHat(group, main, accent);
  else if (style.hat === "beret") beret(group, main, accent);
  else if (style.hat === "cap") capHat(group, main, accent);
  else beanie(group, main, accent);

  if (style.name === "Moss") backpack(group, "#3f5235");
  else if (style.name === "Plum") scarf(group, "#d0a0d5");
  else if (style.name === "Slate") sideBag(group, "#3d4d5c");
  else canteen(group, "#d8b15f");

  return group;
}

export function createResidents(): THREE.Group[] {
  return ([2, 3, 4, 5] as const).map((slot) => resident(slot));
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
