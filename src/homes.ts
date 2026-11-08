import * as THREE from "three";
import { statusColor } from "./status.ts";

// Doorstep coordinates are agent-machi data, not graph data. Each point was
// derived from the submodule's authored building placement: take the nearest
// authored entrance, then stand just outside its facade.
export interface HomeSpot {
  node: string;
  x: number;
  z: number;
  signX: number;
  signZ: number;
  signYaw: number;
  building: string;
}

export const HOME_SPOTS: Record<string, HomeSpot> = {
  P4: {
    node: "P4", x: -0.814, z: -3.452,
    signX: -0.05, signZ: -2.95, signYaw: 0.46,
    building: "B04 north courtyard house",
  },
  P2: {
    node: "P2", x: -4.87, z: -1.496,
    signX: -4.75, signZ: -0.75, signYaw: 0.46,
    building: "B03 south rear household",
  },
  P1: {
    node: "P1", x: -3.158, z: -3.948,
    signX: -2.72, signZ: -3.55, signYaw: 0.46,
    building: "B01 Onari craft frontage",
  },
  R1: {
    node: "R1", x: -3.037, z: -2.621,
    signX: -2.637, signZ: -2.221, signYaw: 0.46,
    building: "B03 Onari tea frontage",
  },
  P3: {
    node: "P3", x: 4.538, z: -4.924,
    signX: 3.95, signZ: -4.35, signYaw: 0.46,
    building: "B02 east-gate tea frontage",
  },
  P5: {
    node: "P5", x: 4.557, z: 2.791,
    signX: 4.686, signZ: 3.101, signYaw: 0.46,
    building: "B08 south Wakamiya craft frontage",
  },
  R2: {
    node: "R2", x: 4.538, z: -3.331,
    signX: 4.25, signZ: -2.9, signYaw: 0.46,
    building: "B02/B05 Wakamiya coffee frontage",
  },
};

export function homeSpot(node: string): HomeSpot | null {
  return HOME_SPOTS[node] ?? null;
}

function drawPanel(
  context: CanvasRenderingContext2D,
  texture: THREE.CanvasTexture,
  name: string,
  status: string,
): void {
  const { width, height } = context.canvas;
  context.clearRect(0, 0, width, height);

  context.fillStyle = "#f4ecd8";
  context.beginPath();
  context.roundRect(5, 5, width - 10, height - 10, 18);
  context.fill();
  context.strokeStyle = "#46584d";
  context.lineWidth = 7;
  context.stroke();
  context.strokeStyle = "#b8a888";
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(17, 17, width - 34, height - 34, 12);
  context.stroke();

  context.fillStyle = "#46584d";
  context.font = "600 20px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText("HOME", 92, 50);

  const color = statusColor(status);
  context.beginPath();
  context.arc(58, 132, 27, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
  context.lineWidth = 5;
  context.strokeStyle = "#2b3730";
  context.stroke();

  let size = 64;
  context.font = `700 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  while (size > 28 && context.measureText(name).width > 390) {
    size -= 2;
    context.font = `700 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  }
  context.fillStyle = "#18211b";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(name, 105, 138, 390);
  texture.needsUpdate = true;
}

function drawBadge(context: CanvasRenderingContext2D, texture: THREE.CanvasTexture): void {
  const { width, height } = context.canvas;
  context.clearRect(0, 0, width, height);
  context.beginPath();
  context.arc(width / 2, height / 2, 52, 0, Math.PI * 2);
  context.fillStyle = "#f2b705";
  context.fill();
  context.lineWidth = 8;
  context.strokeStyle = "#5e4a12";
  context.stroke();
  context.fillStyle = "#2b2410";
  context.font = "800 74px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("!", width / 2, height / 2 + 4);
  texture.needsUpdate = true;
}

export class HomeSign {
  readonly group: THREE.Group;
  private readonly panel: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly pole: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly badge: THREE.Sprite;
  private readonly badgeMaterial: THREE.SpriteMaterial;
  private name = "";
  private status = "";
  private lit: boolean | null = null;
  private done: boolean | null = null;
  private pulse = 0;

  constructor(spot: HomeSpot, groundY: number, initialName: string, initialStatus: string) {
    this.group = new THREE.Group();
    this.group.name = `home sign ${spot.node}`;
    this.group.position.set(spot.signX, groundY, spot.signZ);
    this.group.rotation.y = spot.signYaw;

    this.canvas = document.createElement("canvas");
    this.canvas.width = 512;
    this.canvas.height = 256;
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Missing 2D canvas context for home sign");
    this.context = context;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.92, 0.46),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    this.panel.position.set(0, 0.76, 0.03);
    this.panel.name = `home sign panel ${spot.node}`;

    const poleMaterial = new THREE.MeshStandardMaterial({
      color: "#6d5c4b",
      roughness: 1,
      flatShading: true,
    });
    this.pole = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.70, 0.055), poleMaterial);
    this.pole.position.set(0, 0.35, 0);
    this.pole.castShadow = true;
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(0.24, 0.06, 0.24),
      new THREE.MeshStandardMaterial({ color: "#aaa998", roughness: 1, flatShading: true }),
    );
    base.position.set(0, 0.03, 0);
    base.castShadow = true;

    const badgeCanvas = document.createElement("canvas");
    badgeCanvas.width = 128;
    badgeCanvas.height = 128;
    const badgeContext = badgeCanvas.getContext("2d");
    if (!badgeContext) throw new Error("Missing 2D canvas context for done badge");
    const badgeTexture = new THREE.CanvasTexture(badgeCanvas);
    badgeTexture.colorSpace = THREE.SRGBColorSpace;
    drawBadge(badgeContext, badgeTexture);
    this.badgeMaterial = new THREE.SpriteMaterial({
      map: badgeTexture,
      transparent: true,
      depthWrite: false,
    });
    this.badge = new THREE.Sprite(this.badgeMaterial);
    this.badge.scale.set(0.28, 0.28, 1);
    this.badge.position.set(0, 1.16, 0.04);
    this.badge.visible = false;
    this.badge.renderOrder = 3;

    this.group.add(base, this.pole, this.panel, this.badge);
    this.setContent(initialName, initialStatus);
    this.setLit(false);
  }

  setContent(name: string, status: string): void {
    if (name === this.name && status === this.status) return;
    this.name = name;
    this.status = status;
    drawPanel(this.context, this.texture, name, status);
  }

  setLit(lit: boolean): void {
    if (lit === this.lit) return;
    this.lit = lit;
    const brightness = lit ? 1 : 0.42;
    this.panel.material.color.setScalar(brightness);
    this.pole.material.color.set("#6d5c4b").multiplyScalar(brightness);
  }

  setDone(done: boolean): void {
    if (done === this.done) return;
    this.done = done;
    this.badge.visible = done;
    if (done) this.pulse = 0;
  }

  update(dtSeconds: number): void {
    if (!this.badge.visible) return;
    this.pulse += dtSeconds;
    const scale = 0.28 * (1 + Math.sin(this.pulse * 4.2) * 0.14);
    this.badge.scale.set(scale, scale, 1);
    this.badgeMaterial.opacity = 0.82 + Math.sin(this.pulse * 4.2) * 0.18;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.texture.dispose();
    this.panel.material.dispose();
    this.panel.geometry.dispose();
    this.pole.geometry.dispose();
    this.pole.material.dispose();
    const base = this.group.children.find((child) => child !== this.panel && child !== this.pole && child !== this.badge);
    if (base instanceof THREE.Mesh) {
      base.geometry.dispose();
      (base.material as THREE.Material).dispose();
    }
    this.badgeMaterial.map?.dispose();
    this.badgeMaterial.dispose();
  }
}
