import * as THREE from "three";
import type { Graph, OutgoingEdgeOption } from "./graph.ts";
import { getAvailableJunctionOptions } from "./state.ts";
import type { GameState } from "./state.ts";

export function roadPreview(graph: Graph, option: OutgoingEdgeOption) {
  return graph.samplePathAlongEdge(option.edge, option.direction, 0, Math.min(1.25, option.edge.worldLength));
}

export function screenDirection(dx: number, dy: number, returning: boolean): string {
  if (returning) return "回頭";
  return ["往右", "往右下", "往下", "往左下", "往左", "往左上", "往上", "往右上"][(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
}

interface Rect { x: number; y: number; width: number; height: number }
interface Anchor { x: number; y: number; angle: number }

export function placeRoadButtons(anchors: Anchor[], width: number, height: number, excluded: Rect[], targetWidth = 68, targetHeight = 56) {
  const placed: { x: number; y: number }[] = [];
  // ponytail: tiny junctions use a screen grid search; spatial indexing only if exit counts grow substantially.
  for (const a of anchors) {
    let best: { x: number; y: number } | null = null, score = Infinity;
    for (let y = targetHeight / 2 + 2; y <= height - targetHeight / 2 - 2; y += 15) for (let x = targetWidth / 2 + 2; x <= width - targetWidth / 2 - 2; x += 18) {
      if (excluded.some(r => x + targetWidth / 2 > r.x && x - targetWidth / 2 < r.x + r.width && y + targetHeight / 2 > r.y && y - targetHeight / 2 < r.y + r.height)) continue;
      if (placed.some(p => Math.abs(x - p.x) < targetWidth + 4 && Math.abs(y - p.y) < targetHeight + 4)) continue;
      const cost = Math.hypot(x - a.x - 55 * Math.cos(a.angle), y - a.y - 55 * Math.sin(a.angle));
      if (cost < score) { best = { x, y }; score = cost; }
    }
    if (!best) return [];
    placed.push(best);
  }
  return placed;
}

const colors = ["#167b85", "#a1551b", "#6a4ca0", "#267336", "#a33563", "#436da5"];

export class RoadNavigation {
  private readonly root = document.createElement("div");
  private readonly svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  private readonly layer = new THREE.Group();
  private state: GameState | null = null;
  private key = "";
  private options: OutgoingEdgeOption[] = [];
  private buttons: HTMLButtonElement[] = [];
  private roads: THREE.Mesh[] = [];
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly floorY: (x: number, z: number) => number;
  private readonly select: (edgeId: string) => void;
  private readonly render: () => void;

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    floorY: (x: number, z: number) => number,
    select: (edgeId: string) => void,
    render: () => void,
  ) {
    this.scene = scene;
    this.camera = camera;
    this.floorY = floorY;
    this.select = select;
    this.render = render;
    this.root.id = "road-navigation";
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", "點選棋盤箭頭選路，虛線是標示連線而非行走路線");
    this.svg.setAttribute("aria-hidden", "true");
    this.root.append(this.svg);
    document.body.append(this.root);
    this.layer.name = "Junction_Road_Previews";
    document.querySelector("#game-hud")?.addEventListener("toggle", () => this.layout());
    document.querySelector("#map-guide")?.addEventListener("toggle", () => this.layout());
  }

  setState(state: GameState, animating: boolean): void {
    this.state = state;
    const options = animating ? [] : getAvailableJunctionOptions(state);
    const key = `${state.activePlayerIndex}:${options.map(o => o.edge.id + o.direction).join(",")}`;
    if (this.key === key && this.layer.parent === this.scene.getObjectByName("StationToSea_GameplayLayer")) { this.layout(); return; }
    this.key = key;
    this.options = options;
    delete this.root.dataset.preview;
    this.layer.removeFromParent();
    for (const road of this.roads) { road.geometry.dispose(); (road.material as THREE.Material).dispose(); }
    this.layer.clear();
    this.roads = [];
    this.buttons.forEach(b => b.remove());
    this.buttons = [];
    this.svg.replaceChildren();
    this.scene.getObjectByName("StationToSea_GameplayLayer")?.add(this.layer);
    options.forEach((option, i) => {
      const color = colors[i % colors.length];
      const path = roadPreview(state.graph, option), vertices: number[] = [];
      for (let j = 1; j < path.length; j++) {
        const a = path[j - 1], b = path[j], length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length < 1e-8) continue;
        const dx = -(b.z - a.z) / length * .045, dz = (b.x - a.x) / length * .045;
        const ay = this.floorY(a.x, a.z) + .035, by = this.floorY(b.x, b.z) + .035;
        vertices.push(a.x + dx, ay, a.z + dz, a.x - dx, ay, a.z - dz, b.x + dx, by, b.z + dz,
          a.x - dx, ay, a.z - dz, b.x - dx, by, b.z - dz, b.x + dx, by, b.z + dz);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
      const road = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .55, side: THREE.DoubleSide, depthWrite: false }));
      road.name = `Road_Preview_${option.edge.id}`;
      this.layer.add(road);
      this.roads.push(road);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "road-arrow";
      button.dataset.edgeId = option.edge.id;
      button.style.setProperty("--road-color", color);
      button.innerHTML = '<span class="road-symbol" aria-hidden="true">➜</span><span class="road-caption"></span>';
      const preview = (active: boolean) => {
        if (active) this.buttons.forEach((other, index) => {
          other.classList.remove("previewing");
          (this.roads[index].material as THREE.MeshBasicMaterial).opacity = .55;
        });
        button.classList.toggle("previewing", active);
        if (active) this.root.dataset.preview = String(i);
        else if (this.root.dataset.preview === String(i)) delete this.root.dataset.preview;
        (road.material as THREE.MeshBasicMaterial).opacity = active ? .95 : .55;
        this.render();
      };
      button.addEventListener("pointerenter", () => preview(true));
      button.addEventListener("pointerleave", () => preview(button === document.activeElement));
      button.addEventListener("focus", () => preview(true));
      button.addEventListener("blur", () => preview(false));
      button.addEventListener("pointerdown", () => preview(true));
      button.addEventListener("pointercancel", () => { button.blur(); preview(false); });
      button.addEventListener("keydown", e => { if (e.key === "Escape") { button.blur(); preview(false); } });
      button.addEventListener("click", () => {
        // Revalidate against the current shared action source, never a captured stale option.
        if (this.state && getAvailableJunctionOptions(this.state).some(o => o.edge.id === option.edge.id)) this.select(option.edge.id);
      });
      this.root.append(button);
      this.buttons.push(button);
    });
    this.layout();
  }

  layout(): void {
    const state = this.state;
    if (!state || !this.options.length) { this.root.hidden = true; return; }
    const width = innerWidth, height = innerHeight;
    const project = (x: number, y: number, z: number) => {
      const p = new THREE.Vector3(x, y, z).project(this.camera);
      return { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 };
    };
    const anchors = this.options.map(option => {
      const distance = Math.min(.7, option.edge.worldLength * .7);
      const p = state.graph.samplePointAlongEdge(option.edge, option.direction, distance);
      const a = project(p.x, this.floorY(p.x, p.z) + .035, p.z);
      const b = project(p.x + Math.sin(p.yaw), this.floorY(p.x, p.z) + .035, p.z + Math.cos(p.yaw));
      return { ...a, angle: Math.atan2(b.y - a.y, b.x - a.x) };
    });
    const excluded: Rect[] = Array.from(document.querySelectorAll<HTMLElement>(".overlay > header, .map-key, #game-hud, .overlay > .footer"))
      .filter(e => getComputedStyle(e).display !== "none").map(e => e.getBoundingClientRect());
    for (const player of state.players) {
      const p = project(player.position.x, this.floorY(player.position.x, player.position.z) + .4, player.position.z);
      excluded.push({ x: p.x - 18, y: p.y - 27, width: 36, height: 54 });
    }
    for (const node of state.graph.nodes.values()) if (/^[PR]|^F-/.test(node.id)) {
      const p = project(node.worldX, this.floorY(node.worldX, node.worldZ) + .02, node.worldZ);
      excluded.push({ x: p.x - 12, y: p.y - 12, width: 24, height: 24 });
    }
    const placed = placeRoadButtons(anchors, width, height, excluded);
    this.root.hidden = placed.length !== anchors.length;
    const hint = document.querySelector("#navigation-hint");
    if (hint) hint.textContent = this.root.hidden ? "請收合街區圖例或遊戲面板，騰出選路空間" :
      anchors.some(a => a.x < 0 || a.x > width || a.y < 0 || a.y > height) ? "部分道路在畫面外：請拖曳地圖或按全圖總覽查看，再選路" : "點選棋盤上的方向箭頭選路";
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.svg.replaceChildren();
    placed.forEach((p, i) => {
      const a = anchors[i], button = this.buttons[i];
      button.style.left = `${p.x}px`;
      button.style.top = `${p.y}px`;
      button.querySelector<HTMLElement>(".road-symbol")!.style.transform = `rotate(${a.angle}rad)`;
      const returning = this.options[i].edge.id === state.players[state.activePlayerIndex].previousEdgeId;
      const label = `${i + 1} ${screenDirection(Math.cos(a.angle), Math.sin(a.angle), returning)}`;
      button.querySelector(".road-caption")!.textContent = label;
      button.setAttribute("aria-label", label);
      const line = document.createElementNS(this.svg.namespaceURI, "line");
      line.classList.toggle("focused-road-link", this.root.dataset.preview === String(i));
      for (const [key, value] of Object.entries({ x1: p.x, y1: p.y, x2: a.x, y2: a.y, stroke: colors[i % colors.length] })) line.setAttribute(key, String(value));
      this.svg.append(line);
      const text = document.createElementNS(this.svg.namespaceURI, "text");
      text.classList.toggle("focused-road-label", this.root.dataset.preview === String(i));
      text.setAttribute("x", String(a.x)); text.setAttribute("y", String(a.y));
      text.textContent = String(i + 1);
      this.svg.append(text);
    });
  }
}
