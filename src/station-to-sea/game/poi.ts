import * as THREE from "three";
import { GAME_CONFIG } from "./config.ts";
import type { GameState } from "./state.ts";
import { placeRoadButtons } from "./navigation.ts";

export function describePOIs(state: GameState, playerIndex = state.activePlayerIndex) {
  const player = state.players[playerIndex];
  const active = playerIndex === state.activePlayerIndex && player.status === "ACTIVE";
  return [...Object.keys(GAME_CONFIG.poiScores), "R1", "R2", ...GAME_CONFIG.finishNodeIds].map(id => {
    const node = state.graph.nodes.get(id)!;
    const kind = id in GAME_CONFIG.poiScores ? "sightseeing" : GAME_CONFIG.finishNodeIds.includes(id) ? "finish" : "recovery";
    const ordinal = "①②③④⑤"[Number(id.slice(1)) - 1];
    let name: string, icon: string, value: string, information: string, status: string;
    if (kind === "sightseeing") {
      name = `景點 ${ordinal}`; icon = "📷"; value = `★ +${GAME_CONFIG.poiScores[id]}`;
      information = `先選擇停留並放棄剩餘移動，下次自己的個人回合消耗 1 體力參觀，才獲得 ${value}；該回合不擲骰、不移動。每位玩家各限得分一次。`;
      status = player.visitedPOIs.includes(id) ? "已參觀完成" : player.standingAtPOI === id ?
        active && state.phase === "TURN_START" ? "本次個人回合可參觀" : "已停下，等待下一個個人回合參觀" :
        active && state.phase === "POI_DECISION" && state.pendingPOI === id ? "可停下參觀（下次個人回合得分）" : "未參觀";
    } else if (kind === "recovery") {
      name = `補給站 ${ordinal}`; icon = "⚡";
      value = `★ −${GAME_CONFIG.resupplyCost} → ⚡ +${GAME_CONFIG.resupplyGain}`;
      information = `花費 ${GAME_CONFIG.resupplyCost} 景點分數換取 ${GAME_CONFIG.resupplyGain} 體力，不是獲得分數。抵達當回合可買，放棄剩餘移動，不另耗一回合；每位玩家每店限用一次，體力上限 ${GAME_CONFIG.maxStamina}。`;
      const gain = Math.min(GAME_CONFIG.resupplyGain, GAME_CONFIG.maxStamina - player.stamina);
      status = player.visitedShops.includes(id) ? "已使用（每店限一次）" :
        player.earnedPoints - player.spentPoints < GAME_CONFIG.resupplyCost ? "尚未使用・分數不足" :
        player.stamina >= GAME_CONFIG.maxStamina ? "尚未使用・體力達上限；依現有規則仍可購買，實得 0 體力" :
        active && state.phase === "RESUPPLY_DECISION" && state.pendingShop === id ? `可補給（本次實得 ${gain} 體力）` : `尚未使用（抵達可換 ${gain} 體力）`;
    } else {
      name = id === GAME_CONFIG.finishNodeIds[0] ? "海灘入口・西" : "海灘入口・東";
      icon = "🏁"; value = "等價終點";
      information = "沿道路抵達木柱旁入口即完成旅程，無須額外操作。東、西兩個入口為等價終點；體力剛好為 0 抵達也有效。";
      status = player.status === "FINISHED" && player.currentNodeId === id ? "已由此完成旅程" : "抵達即完成";
    }
    return { id, x: node.worldX, z: node.worldZ, kind, name, icon, value, information, status };
  });
}

export class POIMarkers {
  private readonly root = document.createElement("div");
  private readonly svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private state: GameState | null = null;
  private selected: string | null = null;
  private readonly camera: THREE.Camera;
  private readonly travelers: THREE.Object3D[];
  private readonly floorY: (x: number, z: number) => number;
  private readonly render: () => void;
  private readonly info = document.querySelector<HTMLElement>("#poi-information")!;
  private readonly index = document.querySelector<HTMLElement>("#poi-index")!;

  constructor(camera: THREE.Camera, travelers: THREE.Object3D[], floorY: (x: number, z: number) => number, render: () => void) {
    this.camera = camera; this.travelers = travelers; this.floorY = floorY; this.render = render;
    this.root.id = "poi-markers";
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", "景點、補給站與海灘入口；查看資訊不會移動或交易");
    this.svg.setAttribute("aria-hidden", "true");
    this.root.append(this.svg); document.body.append(this.root);
    this.info.querySelector("button")!.addEventListener("click", () => { this.selected = null; this.updateInformation(); this.render(); });
    document.querySelector("#game-hud")!.addEventListener("toggle", () => this.layout());
    document.querySelector("#map-guide")!.addEventListener("toggle", () => this.layout());
  }

  setState(state: GameState): void {
    if (this.state !== state) this.selected = null;
    this.state = state;
    if (!this.buttons.size) for (const point of describePOIs(state)) {
      const button = document.createElement("button");
      button.type = "button"; button.className = `poi-marker ${point.kind}`; button.dataset.poiId = point.id;
      const show = (open: boolean) => {
        this.selected = point.id;
        this.updateInformation();
        if (open) {
          document.querySelector<HTMLDetailsElement>("#game-hud")!.open = true;
          this.info.scrollIntoView({ block: "nearest" });
        }
        this.render();
      };
      button.addEventListener("pointerenter", event => { if (event.pointerType === "mouse") show(false); });
      button.addEventListener("focus", () => { if (button.matches(":focus-visible")) show(true); });
      button.addEventListener("click", () => show(true));
      button.addEventListener("keydown", event => {
        if (event.key === "Escape") { this.selected = null; this.updateInformation(); button.blur(); this.render(); }
      });
      this.root.append(button); this.buttons.set(point.id, button);
      const entry = document.createElement("button");
      entry.type = "button"; entry.dataset.poiId = point.id;
      entry.addEventListener("click", () => show(true));
      this.index.append(entry);
    }
    for (const point of describePOIs(state)) {
      const button = this.buttons.get(point.id)!;
      const done = /已參觀完成|已使用|已由此/.test(point.status);
      button.innerHTML = `<span>${point.icon} ${point.name.match(/[①②③④⑤]|西|東/)?.[0]}${done ? "✓" : ""}</span><small>${point.kind === "recovery" ? `★−${GAME_CONFIG.resupplyCost}→⚡+${GAME_CONFIG.resupplyGain}` : point.value}</small>`;
      button.setAttribute("aria-label", `${point.name}，${point.value}，${state.players[state.activePlayerIndex].name}：${point.status}`);
      button.title = `${point.name}：${point.information} ${point.status}`;
      button.setAttribute("aria-controls", "poi-information");
      this.index.querySelector<HTMLButtonElement>(`[data-poi-id="${point.id}"]`)!.textContent = `${point.icon} ${point.name} ${point.value}`;
    }
    this.updateInformation();
  }

  private updateInformation(): void {
    this.info.hidden = !this.selected;
    if (!this.state || !this.selected) return;
    const point = describePOIs(this.state).find(p => p.id === this.selected)!;
    this.info.querySelector("h3")!.textContent = `${point.icon} ${point.name}・${point.value}`;
    this.info.querySelector(".poi-description")!.textContent = point.information;
    this.info.querySelector(".poi-player-states")!.textContent = this.state.players.map((p, i) =>
      `${p.name}：${describePOIs(this.state!, i).find(item => item.id === point.id)!.status}`).join("；");
    this.info.querySelector(".poi-action-help")!.textContent = "這裡只查看資訊；實際抵達且輪到你操作時，使用遊戲面板中的停留、參觀或補給按鈕。";
  }

  layout(): void {
    if (!this.state) return;
    const project = (x: number, z: number, lift = .02) => {
      const p = new THREE.Vector3(x, this.floorY(x, z) + lift, z).project(this.camera);
      return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2, angle: -Math.PI / 2 };
    };
    const points = describePOIs(this.state);
    const anchors = points.map(p => project(p.x, p.z));
    const excluded = Array.from(document.querySelectorAll<HTMLElement>(".overlay > header, .map-key, #game-hud, .overlay > .footer, .road-arrow"))
      .filter(e => e.getClientRects().length && getComputedStyle(e).display !== "none").map(e => e.getBoundingClientRect());
    for (const traveler of this.travelers) {
      const p = project(traveler.position.x, traveler.position.z, .4);
      excluded.push(new DOMRect(p.x - 18, p.y - 27, 36, 54));
    }
    for (const p of anchors) excluded.push(new DOMRect(p.x - 12, p.y - 12, 24, 24));
    const placed = placeRoadButtons(anchors, innerWidth, innerHeight, excluded, 60, 44);
    this.root.hidden = placed.length !== points.length;
    this.index.parentElement!.querySelector("summary")!.textContent = this.root.hidden ?
      "地點索引（標記擁擠，由此查看）" : "地點索引：📷 景點／⚡ 補給／🏁 終點";
    document.querySelector("#poi-index-hint")!.textContent = this.root.hidden ?
      "標記空間不足：展開地點索引查看，或收合遊戲面板。" : "圖示連線錨定實際位置；畫面外地點請拖曳地圖查看。";
    this.svg.setAttribute("viewBox", `0 0 ${innerWidth} ${innerHeight}`); this.svg.replaceChildren();
    placed.forEach((p, i) => {
      const button = this.buttons.get(points[i].id)!;
      button.style.left = `${p.x}px`; button.style.top = `${p.y}px`;
      button.dataset.anchorX = String(anchors[i].x); button.dataset.anchorY = String(anchors[i].y);
      const line = document.createElementNS(this.svg.namespaceURI, "line");
      for (const [key, value] of Object.entries({ x1: p.x, y1: p.y, x2: anchors[i].x, y2: anchors[i].y })) line.setAttribute(key, String(value));
      this.svg.append(line);
    });
  }
}
