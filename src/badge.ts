import * as THREE from "three";
import { statusBadge, type StatusBadge, type StatusBadgeGlyph } from "./status.ts";

const PULSE_RATE = 4.2;

/** One pulsing badge sprite. `mount` is where it hangs, not a second status map. */
export class StatusBadgeSprite {
  readonly sprite: THREE.Sprite;
  private readonly material: THREE.SpriteMaterial;
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mount: StatusBadgeGlyph;
  private readonly baseScale: number;
  private pulse = 0;
  private painted = "";

  constructor(mount: StatusBadgeGlyph, baseScale: number) {
    this.mount = mount;
    this.baseScale = baseScale;
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing 2D canvas context for status badge");
    this.context = context;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.set(baseScale, baseScale, 1);
    this.sprite.visible = false;
  }

  setStatus(status: string): void {
    const badge = statusBadge(status);
    const show = badge?.glyph === this.mount ? badge : null;
    const wasVisible = this.sprite.visible;
    this.sprite.visible = show !== null;
    if (!show) return;
    if (!wasVisible) this.pulse = 0;
    const key = `${show.glyph}|${show.fill}|${show.stroke}|${show.ink}`;
    if (key === this.painted) return;
    this.painted = key;
    drawStatusBadge(this.context, show);
    this.texture.needsUpdate = true;
  }

  update(dtSeconds: number): void {
    if (!this.sprite.visible) return;
    this.pulse += dtSeconds;
    const wave = Math.sin(this.pulse * PULSE_RATE);
    const scale = this.baseScale * (1 + wave * 0.14);
    this.sprite.scale.set(scale, scale, 1);
    this.material.opacity = 0.82 + wave * 0.18;
  }

  dispose(): void {
    this.sprite.removeFromParent();
    this.texture.dispose();
    this.material.dispose();
  }
}

function drawStatusBadge(context: CanvasRenderingContext2D, badge: StatusBadge): void {
  const { width, height } = context.canvas;
  const cx = width / 2;
  const cy = height / 2;
  context.clearRect(0, 0, width, height);
  context.beginPath();
  context.arc(cx, cy, 52, 0, Math.PI * 2);
  context.fillStyle = badge.fill;
  context.fill();
  context.lineWidth = 8;
  context.strokeStyle = badge.stroke;
  context.stroke();

  if (badge.glyph === "!") {
    context.fillStyle = badge.ink;
    context.font = "800 74px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("!", cx, cy + 4);
    return;
  }

  context.strokeStyle = badge.ink;
  context.lineWidth = 14;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(cx - 26, cy + 2);
  context.lineTo(cx - 6, cy + 22);
  context.lineTo(cx + 30, cy - 22);
  context.stroke();
}
