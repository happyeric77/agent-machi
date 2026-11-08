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

  context.fillStyle = "#f8f0da";
  context.beginPath();
  context.roundRect(10, 10, width - 20, height - 20, 36);
  context.fill();
  context.strokeStyle = "#3c4f43";
  context.lineWidth = 14;
  context.stroke();
  context.strokeStyle = "#b7a583";
  context.lineWidth = 4;
  context.beginPath();
  context.roundRect(34, 34, width - 68, height - 68, 24);
  context.stroke();

  context.fillStyle = "#3c4f43";
  context.font = "800 52px ui-sans-serif, -apple-system, 'Helvetica Neue', Arial, sans-serif";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText("HOME", 80, 88);

  context.strokeStyle = "#c9b795";
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(80, 148);
  context.lineTo(width - 80, 148);
  context.stroke();

  const lampDiameter = 168;
  const gap = 36;
  const maxTextWidth = width - 160 - lampDiameter - gap;
  let size = 170;
  context.font = `800 ${size}px ui-sans-serif, -apple-system, 'Helvetica Neue', Arial, sans-serif`;
  while (size > 68 && context.measureText(name).width > maxTextWidth) {
    size -= 4;
    context.font = `800 ${size}px ui-sans-serif, -apple-system, 'Helvetica Neue', Arial, sans-serif`;
  }
  const textWidth = Math.min(context.measureText(name).width, maxTextWidth);
  const rowWidth = lampDiameter + gap + textWidth;
  const rowX = (width - rowWidth) / 2;
  const rowY = 300;

  const color = statusColor(status);
  context.beginPath();
  context.arc(rowX + lampDiameter / 2, rowY, lampDiameter / 2, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
  context.lineWidth = 12;
  context.strokeStyle = "#26332b";
  context.stroke();

  context.fillStyle = "#0e140f";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(name, rowX + lampDiameter + gap, rowY, maxTextWidth);
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
    this.canvas.width = 1024;
    this.canvas.height = 512;
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Missing 2D canvas context for home sign");
    this.context = context;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;

    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 0.58),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    this.panel.position.set(0, 0.84, 0.07);
    this.panel.name = `home sign panel ${spot.node}`;

    const poleMaterial = new THREE.MeshStandardMaterial({
      color: "#6d5c4b",
      roughness: 1,
      flatShading: true,
    });
    this.pole = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.82, 0.065), poleMaterial);
    this.pole.position.set(0, 0.44, 0);
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
    this.badge.position.set(0, 1.36, 0.08);
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
