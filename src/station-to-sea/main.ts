import * as THREE from "three";
import { createMapBlockout, createZoneOverlay, MAP_GROUND_Y } from "./map/scene";
import { createTown } from "./town";
import { createScenicShopfronts } from "./shops";
import { createScenicResidences } from "./residences";
import { createBlueprintStreetfronts } from "./streetscape";
import { createNeighborhoodDetail } from "./map/streetscapeDetails";
import { createOnariCentralFocus } from "./map/onariCentral";
import { createWakamiyaAvenueFinish, decorateWakamiyaShopfronts } from "./map/wakamiya";
import { createCoast, createRoutePreview } from "./coast";
import { tileSurfaceAt } from "./sceneryAnchors";
import { GAME_CONFIG } from "./game/config.ts";
import { createInitialGameState, calculateFinalScore } from "./game/state.ts";
import { Presenter } from "./game/presenter.ts";
import { RoadNavigation } from "./game/navigation.ts";
import { POIMarkers, describePOIs } from "./game/poi.ts";
import { createCPUMemory, decideCPU } from "./game/cpu.ts";
import { LocalNetwork } from "./game/network.ts";
import type { NetworkEvent } from "./game/network.ts";
import type { GameAction, GameState } from "./game/state.ts";
import type { CPUDecision } from "./game/cpu.ts";
import "./style.css";

declare global {
  interface Window {
    __stationToSeaMapStats?: () => {
      calls: number; triangles: number; geometries: number; textures: number;
    };
    __stationToSeaGame?: unknown;
  }
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app on Station to Sea home");

const scene = new THREE.Scene();
scene.background = new THREE.Color("#e5ebe6");
scene.add(createMapBlockout());
scene.add(createNeighborhoodDetail(MAP_GROUND_Y));
const zones = createZoneOverlay();
scene.add(zones);

// Re-use exactly the accepted M1.3 source models. Only 4 detailed existing
// houses are deployed to show relative scale. We intentionally do NOT add
// a dense/fake Japanese town or a new low-fidelity set of placeholder assets.
const town = createTown();
if (town.children.length !== 17) {
  throw new Error("Source town composition changed: revisit blockout reuse indexes");
}

const station = town.children[0];
station.position.set(-0.40, MAP_GROUND_Y, -6.25);
station.scale.setScalar(1.12);
// Do not re-add an existing child: THREE.Group.add() would reorder
// town.children and break the stable source asset index mapping.

const jr = town.children[1];
// The accepted M1 railway group uses world-positioned meshes at the tile's
// own z/y; translate the whole group to the back behind Kamakura station.
jr.position.set(0, MAP_GROUND_Y - tileSurfaceAt(1, -2).y,
  -7.47 - tileSurfaceAt(1, -2).z);
jr.scale.x = 1.40;
// Original track group is already a child of town; preserve its index.

// B04 now has two inward-facing residential rows either side of the
// adjusted central lane. Original M1.3 roofs/windows remain unchanged.
const placement = [
  [1.49, -4.32, 0.34],
  // The original door/windows are on local +Z. The old 2.94 rad rotation
  // hid them behind a blank rear wall at the fixed camera angle.
  // A modest turn reveals the source M1 facade; courtyard access is via
  // the lane-side opening, not a forced 180° house rotation.
  [1.98, -2.76, -0.48],
  [-3.78, 3.30, 0.16],
  [1.33, 3.95, -0.10],
] as const;
for (let i = 0; i < 4; i += 1) {
  const home = town.children[2 + i];
  const [x, z, rotation] = placement[i];
  home.position.set(x, MAP_GROUND_Y, z);
  home.rotation.y = rotation;
  // One modestly smaller central roof creates an L-shaped court skyline.
  home.scale.setScalar(i === 1 ? 1.08 : 1.17);
}

// The accepted town's three hex-specific rectangular paving stamps are hidden.
// They are replaced with full-map curved road ribbons, NOT new simplified homes.
for (let i = 6; i <= 8; i += 1) town.children[i].visible = false;

const treeSites: readonly [number, number][] = [
  [-6.08, -0.78], [1.10, -6.17], [6.15, -2.03], [6.20, 3.05],
];
const shrubSites: readonly [number, number][] = [
  [-4.50, -2.05], [-4.24, 4.30], [1.44, -0.94], [2.35, 4.04],
];
treeSites.forEach(([x, z], i) => town.children[9 + i].position.set(x, MAP_GROUND_Y, z));
shrubSites.forEach(([x, z], i) => town.children[13 + i].position.set(x, MAP_GROUND_Y, z));
scene.add(town);

// B.1 adds only a small, distinctive shopfront sample to existing streets.
const scenicShops=createScenicShopfronts(MAP_GROUND_Y);
decorateWakamiyaShopfronts(scenicShops);
scene.add(scenicShops);

// B.2 is a separate incremental layer. The original four houses, all shop
// models, travelers and camera remain untouched.
scene.add(createScenicResidences(MAP_GROUND_Y));

// Corrective Blueprint v0.4/v0.5 alignment: deliberate streetfront rows,
// small pavement edges, a B08 torii silhouette and open coastal threshold.
const blueprintShops=createBlueprintStreetfronts(MAP_GROUND_Y);
decorateWakamiyaShopfronts(blueprintShops);
scene.add(blueprintShops);
// Focused work only: Onari and central homes; other districts unchanged.
scene.add(createOnariCentralFocus(MAP_GROUND_Y));
// Isolated B.3a east-only boulevard slice; approved B.2 geometry stays.
scene.add(createWakamiyaAvenueFinish(MAP_GROUND_Y));

// Preserve the accepted travelers' actual arms, bags, hats, colored pawn bases.
// Decorative M1 route beacons are omitted here; they are NOT the gameplay graph.
const sourcePreview = createRoutePreview();
const travelers = sourcePreview.children.filter(obj => obj.name.includes("traveller"));
if (travelers.length !== 2) throw new Error("Expected both original traveler assets");
travelers[0].position.set(-0.45, MAP_GROUND_Y, -5.16); // clearance A
travelers[1].position.set(0.72, MAP_GROUND_Y, 1.65); // clearance B
travelers.forEach(obj => scene.add(obj));

// Reuse the ORIGINAL beach geometry, shells and two foam ribbons; stretch
// only its horizontal composition and move it to the full board's south edge.
const coast = createCoast();
coast.scale.x = 1.65;
coast.position.z = 2.82;
scene.add(coast);

const tabletop = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: "#e5ebe6", roughness: 1, metalness: 0 }),
);
tabletop.rotation.x = -Math.PI / 2;
tabletop.position.y = -0.025;
tabletop.receiveShadow = true;
scene.add(tabletop);

// Same material/lighting/shadow character as the accepted M1.3 homepage;
// only shadow-camera coverage expands for the larger test map.
scene.add(new THREE.HemisphereLight("#fff9e9", "#91a59a", 2));
const sunlight = new THREE.DirectionalLight("#fff3db", 2.55);
sunlight.position.set(-7, 16, 12);
sunlight.castShadow = true;
sunlight.shadow.mapSize.set(2048, 2048);
sunlight.shadow.camera.left = -19;
sunlight.shadow.camera.right = 19;
sunlight.shadow.camera.top = 19;
sunlight.shadow.camera.bottom = -19;
sunlight.shadow.camera.near = 0.5;
sunlight.shadow.camera.far = 50;
sunlight.shadow.bias = -0.0002;
sunlight.shadow.normalBias = 0.025;
sunlight.shadow.radius = 3;
scene.add(sunlight);

// Full-map geometry remains large. Default view is a close-up of the
// station-to-street walk, NOT a distant always-fit whole-board thumbnail.
// Camera orientation remains fixed: dragging only pans over the ground.
type ViewMode = "explore" | "overview";
const stationFocus = new THREE.Vector3(-0.35, 0.28, -4.65);
// Explore initially visits a PARTICULAR neighborhood, not the whole board.
// The Onari shop row and B04 gardens share this local framing; players can
// pan beyond it or request the separate full overview.
const neighborhoodFocus = new THREE.Vector3(-1.82, 0.28, -3.52);
const overviewFocus = new THREE.Vector3(0, 0.28, 0.65);
const focus = neighborhoodFocus.clone();
const cameraOffset = new THREE.Vector3(15, 21, 30);
const camera = new THREE.OrthographicCamera(-11, 11, 7, -7, 0.1, 90);
camera.position.copy(focus).add(cameraOffset);
camera.lookAt(focus);
let mode: ViewMode = "explore";
let magnification = 1;
const minMagnification = 0.70;
const maxMagnification = 2.20;
const focusLimits = { minX: -7.25, maxX: 6.10, minZ: -6.90, maxZ: 7.55 };

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
app.appendChild(renderer.domElement);

function placeFocus(nextX: number, nextZ: number): void {
  const x = THREE.MathUtils.clamp(nextX, focusLimits.minX, focusLimits.maxX);
  const z = THREE.MathUtils.clamp(nextZ, focusLimits.minZ, focusLimits.maxZ);
  const translation = new THREE.Vector3(x - focus.x, 0, z - focus.z);
  focus.add(translation);
  camera.position.add(translation);
  camera.lookAt(focus);
  camera.updateMatrixWorld();
}

// Hand-authored visual content bounds: continuous base, northern JR/station,
// scaled existing coast at the south, and all pawn/building silhouettes.
// Excludes the infinite shadow-catching tabletop. This envelope is a camera
// design bound, NOT gameplay collision geometry or surveyed map coordinates.
const mapEnvelope = {
  // B.3b eastern rounded sea cap reaches x=4.93*1.65 ≈ 8.13;
  // expand OVERVIEW art-only bounds, not Explore camera or pan/zoom.
  minX: -8.60, maxX: 8.45,
  minY: -0.06, maxY: 2.55,
  minZ: -8.55, maxZ: 9.65,
};

function overviewFitHeight(aspect: number): number {
  // Orthographic camera X/Y basis depends on its fixed oblique orientation.
  // Measure ALL eight bounds corners in that basis relative to the current
  // intended overview target, not the unrotated world X/Z footprint.
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const delta = new THREE.Vector3();
  let halfWidth = 0;
  let halfHeight = 0;
  for (const x of [mapEnvelope.minX, mapEnvelope.maxX]) {
    for (const y of [mapEnvelope.minY, mapEnvelope.maxY]) {
      for (const z of [mapEnvelope.minZ, mapEnvelope.maxZ]) {
        delta.set(x, y, z).sub(overviewFocus);
        halfWidth = Math.max(halfWidth, Math.abs(delta.dot(right)));
        halfHeight = Math.max(halfHeight, Math.abs(delta.dot(up)));
      }
    }
  }
  const padding = 1.13;
  return Math.max(2 * halfHeight, (2 * halfWidth) / aspect) * padding;
}

const cameraStatus = document.querySelector<HTMLOutputElement>("#camera-status");
let roadNavigation: RoadNavigation | undefined;
let poiMarkers: POIMarkers | undefined;
function renderMap(): void {
  const width = Math.max(1, app!.clientWidth);
  const height = Math.max(1, app!.clientHeight);
  const aspect = width / height;
  const landscapeBlend = THREE.MathUtils.clamp((aspect - 0.45) / 0.9, 0, 1);

  // A smaller visible orthographic height makes town details readable.
  // On portrait only a PART of the large town is visible by design: pan to
  // explore the remainder, or choose the deliberate overview control.
  // A second, restrained step closer: show the *Onari/B04 neighborhood*
  // rather than the broader Scenic Walk. Full-map Overview is independent.
  // Portrait still presents a local walkable slice, never the entire map.
  // Desktop objects appear ~22% larger than the previous 6.20 framing.
  const exploreHeight = THREE.MathUtils.lerp(6.15, 5.10, landscapeBlend);
  // The prior "17.9 / aspect" width assumption clipped the eastern
  // land corner in 390px portrait. Fit a camera-aligned 3D content envelope,
  // with padding, on BOTH axes rather than guessing the projected width.
  const overviewHeight = overviewFitHeight(aspect);
  const viewHeight = (mode === "overview" ? overviewHeight : exploreHeight) / magnification;
  camera.left = (-viewHeight * aspect) / 2;
  camera.right = (viewHeight * aspect) / 2;
  camera.top = viewHeight / 2;
  camera.bottom = -viewHeight / 2;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  renderer.render(scene, camera);
  roadNavigation?.layout();
  poiMarkers?.layout();
  if (cameraStatus) {
    cameraStatus.textContent = mode === "overview"
      ? "全圖總覽 · 可拖曳查看"
      : "局部街區探索 · 拖曳平移／滾輪縮放";
  }
}

function selectExplore(): void {
  mode = "explore";
  magnification = 1;
  renderMap();
}

function zoomBy(multiplier: number): void {
  // Zooming from overview returns to the detailed view at the current focus.
  // The focus never jumps to a distant street while adjusting magnification.
  if (mode === "overview") selectExplore();
  magnification = THREE.MathUtils.clamp(
    magnification * multiplier, minMagnification, maxMagnification,
  );
  renderMap();
}

function selectOverview(): void {
  mode = "overview";
  magnification = 1;
  placeFocus(overviewFocus.x, overviewFocus.z);
  renderMap();
}

function returnToStation(): void {
  mode = "explore";
  magnification = 1;
  placeFocus(stationFocus.x, stationFocus.z);
  renderMap();
}

// Pointer Events work for mouse and one-finger touch. Using a ray-plane
// intersection preserves the picked ground point under the cursor when panning
// a tilted orthographic camera; no free orbit/rotation or gameplay path change.
const canvas = renderer.domElement;
canvas.tabIndex = 0;
canvas.setAttribute("aria-label",
  "鎌倉地圖：拖曳移動視野，滾輪縮放，方向鍵平移，按加減號縮放");
canvas.style.touchAction = "none";
canvas.style.cursor = "grab";
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -MAP_GROUND_Y);
const raycaster = new THREE.Raycaster();
let pointerId: number | null = null;
let pinnedWorldPoint: THREE.Vector3 | null = null;

function worldAtPointer(event: PointerEvent): THREE.Vector3 | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const coords = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  camera.updateMatrixWorld();
  raycaster.setFromCamera(coords, camera);
  return raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
}

canvas.addEventListener("pointerdown", event => {
  if (pointerId !== null || (event.pointerType === "mouse" && event.button !== 0)) return;
  const anchor = worldAtPointer(event);
  if (!anchor) return;
  pointerId = event.pointerId;
  pinnedWorldPoint = anchor;
  canvas.setPointerCapture(event.pointerId);
  canvas.style.cursor = "grabbing";
  event.preventDefault();
});
canvas.addEventListener("pointermove", event => {
  if (event.pointerId !== pointerId || !pinnedWorldPoint) return;
  const current = worldAtPointer(event);
  if (!current) return;
  const dx = pinnedWorldPoint.x - current.x;
  const dz = pinnedWorldPoint.z - current.z;
  placeFocus(focus.x + dx, focus.z + dz);
  renderMap();
  event.preventDefault();
});
function releasePointer(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return;
  pointerId = null;
  pinnedWorldPoint = null;
  canvas.style.cursor = "grab";
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}
canvas.addEventListener("pointerup", releasePointer);
canvas.addEventListener("pointercancel", releasePointer);
canvas.addEventListener("lostpointercapture", releasePointer);
canvas.addEventListener("wheel", event => {
  event.preventDefault();
  zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });
canvas.addEventListener("keydown", event => {
  const step = 0.65;
  switch (event.key) {
    case "ArrowLeft": placeFocus(focus.x - step, focus.z); break;
    case "ArrowRight": placeFocus(focus.x + step, focus.z); break;
    case "ArrowUp": placeFocus(focus.x, focus.z - step); break;
    case "ArrowDown": placeFocus(focus.x, focus.z + step); break;
    case "+": case "=": zoomBy(1.15); break;
    case "-": case "_": zoomBy(1 / 1.15); break;
    case "Home": returnToStation(); break;
    default: return;
  }
  event.preventDefault();
  renderMap();
});
document.querySelector<HTMLButtonElement>("#zoom-in")?.addEventListener("click", () => zoomBy(1.25));
document.querySelector<HTMLButtonElement>("#zoom-out")?.addEventListener("click", () => zoomBy(1 / 1.25));
document.querySelector<HTMLButtonElement>("#camera-overview")?.addEventListener("click", selectOverview);
document.querySelector<HTMLButtonElement>("#camera-station")?.addEventListener("click", returnToStation);

// Keep the guide available without allowing a tall fixed panel to obscure
// rooftops on initial Explore. Either viewport starts collapsed; opening the
// native <details> is a deliberate choice. Resize closes the temporary
// drawer and restores the compact safe controls.
const guide = document.querySelector<HTMLDetailsElement>("#map-guide");
const compactLayout = window.matchMedia("(max-width: 650px)");
if (guide) guide.open = false;
compactLayout.addEventListener("change", () => {
  if (guide) guide.open = false;
});

const toggle = document.querySelector<HTMLButtonElement>("#toggle-zones");
if (toggle) {
  toggle.addEventListener("click", () => {
    zones.visible = !zones.visible;
    toggle.setAttribute("aria-pressed", String(zones.visible));
    toggle.textContent = zones.visible ? "隱藏街區界線" : "顯示街區界線";
    renderMap();
  });
}

window.__stationToSeaMapStats = () => ({
  calls: renderer.info.render.calls,
  triangles: renderer.info.render.triangles,
  geometries: renderer.info.memory.geometries,
  textures: renderer.info.memory.textures,
});

const observer = new ResizeObserver(renderMap);
observer.observe(app);
renderMap();

// -------------------------------------------------------------
// G3 v0.8 First Playable Gameplay Integration
// -------------------------------------------------------------
let presenter: Presenter;
const roomId = new URLSearchParams(location.search).get("room");
const networkMode = !!roomId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(roomId);
const createRoom = document.querySelector<HTMLButtonElement>("#create-room")!;
const roomMessage = document.querySelector<HTMLElement>("#room-message")!;
createRoom.hidden = networkMode;
if (networkMode) {
  document.querySelector<HTMLElement>("#share-room-label")!.hidden = false;
  document.querySelector<HTMLInputElement>("#share-room")!.value = `${location.origin}/?room=${roomId}`;
} else {
  createRoom.addEventListener("click", async () => {
    createRoom.disabled = true;
    try {
      const response = await fetch('/rooms', { method: 'POST' });
      if (!response.ok) throw new Error('無法建立房間');
      const room = await response.json() as { roomId: string; token: string };
      sessionStorage.setItem(`station-room-${room.roomId}`, room.token);
      location.assign(`/?room=${room.roomId}`);
    } catch {
      roomMessage.textContent = '建立房間失敗，請稍後再試。';
      createRoom.disabled = false;
    }
  });
}
const networkStatus = document.querySelector<HTMLElement>("#network-status")!;
let network: LocalNetwork | undefined;
let networkSeat: number | undefined;
let networkVersion = -1;
let networkPending = false;
const snapshots: Array<Extract<NetworkEvent, { type: "state" }>> = [];
let isLoopRunning = false;
let animationFrame = 0;
let cpuTimer: ReturnType<typeof setTimeout> | undefined;
let cpuMemory = createCPUMemory();
let cpuHistory: Array<CPUDecision & { phase: string; stamina: number; roll: number | null }> = [];
const gameMode = document.querySelector<HTMLSelectElement>("#game-mode")!;
const cpuStatus = document.querySelector<HTMLElement>("#cpu-status")!;
const isCPUTurn = (state: GameState) => gameMode.value === "cpu" && state.activePlayerIndex === 1 && state.phase !== "GAME_OVER";
const isUnavailable = (state: GameState) => isCPUTurn(state) || (networkMode && (networkSeat !== state.activePlayerIndex || networkVersion < 0 || networkPending));
function dispatchHuman(action: GameAction): void {
  if (isUnavailable(presenter.getState()) || presenter.getAnimationStatus().isAnimating) return;
  if (networkMode) {
    networkPending = true;
    network?.send(action);
    updateHUD();
    return;
  }
  presenter.dispatch(action);
  startAnimationLoop();
}
function scheduleCPU(state: GameState, isAnimating: boolean): void {
  const moving = isAnimating && presenter?.recordedTrace.at(-1)?.playerId === "Teal";
  cpuStatus.hidden = gameMode.value !== "cpu";
  cpuStatus.textContent = `${state.phase === "GAME_OVER" ? "對戰結束" : moving ? "Teal（CPU）正在移動" : isCPUTurn(state) ? "Teal（CPU）正在思考" : "Amber（Human）回合"}。${cpuHistory.at(-1)?.reason ?? "Normal CPU：先確保完賽，再評估景點與補給。"}`;
  if (isAnimating || !isCPUTurn(state)) {
    clearTimeout(cpuTimer); cpuTimer = undefined;
    return;
  }
  if (cpuTimer !== undefined) return;
  cpuTimer = setTimeout(() => {
    cpuTimer = undefined;
    if (state !== presenter.getState() || !isCPUTurn(state) || presenter.getAnimationStatus().isAnimating) return;
    const choice = decideCPU(state, cpuMemory);
    if (!choice) { cpuStatus.textContent = "CPU 無合法行動；請保留狀態供檢查。"; return; }
    cpuHistory.push({ ...choice, phase: state.phase, stamina: state.players[1].stamina, roll: state.currentRoll });
    try {
      presenter.dispatch(choice.action);
      startAnimationLoop();
    } catch (error) {
      clearTimeout(cpuTimer); cpuTimer = undefined;
      cpuStatus.textContent = `CPU 行動失敗：${String(error)}`;
    }
  }, 650);
}
poiMarkers = new POIMarkers(camera, travelers, (x, z) => presenter?.getCalibratedFloorY(x, z) ?? .589, renderMap);
roadNavigation = new RoadNavigation(scene, camera,
  (x, z) => presenter?.getCalibratedFloorY(x, z) ?? .589,
  edgeId => {
    dispatchHuman({ type: "CHOOSE_JUNCTION_EDGE", edgeId });
  }, renderMap);

function startAnimationLoop(): void {
  if (isLoopRunning) return;
  isLoopRunning = true;
  function step(now: number): void {
    const continuing = presenter.update(now);
    renderMap();
    if (continuing) {
      animationFrame = requestAnimationFrame(step);
    } else {
      isLoopRunning = false;
      drainSnapshots();
      renderMap();
    }
  }
  animationFrame = requestAnimationFrame(step);
}

function drainSnapshots(): void {
  if (presenter.getAnimationStatus().isAnimating) return;
  const next = snapshots.shift();
  if (!next) return;
  const first = networkVersion < 0;
  networkVersion = next.version;
  networkPending = false;
  presenter.receiveSnapshot(next.state, !first);
  startAnimationLoop();
  if (!presenter.getAnimationStatus().isAnimating) drainSnapshots();
}

const hudPlayerDot = document.querySelector<HTMLElement>("#hud-player-dot");
const hudPlayerName = document.querySelector<HTMLElement>("#hud-player-name");
const hudPlayerStatus = document.querySelector<HTMLElement>("#hud-player-status");
const hudStamina = document.querySelector<HTMLElement>("#hud-stamina");
const hudPoints = document.querySelector<HTMLElement>("#hud-points");
const hudDice = document.querySelector<HTMLElement>("#hud-dice");
const hudBudget = document.querySelector<HTMLElement>("#hud-budget");

const btnRollDice = document.querySelector<HTMLButtonElement>("#btn-roll-dice");
const btnVisitPOI = document.querySelector<HTMLButtonElement>("#btn-visit-poi");

const junctionControls = document.querySelector<HTMLElement>("#junction-controls");

const poiControls = document.querySelector<HTMLElement>("#poi-controls");
const poiTitle = document.querySelector<HTMLElement>("#poi-title");
const btnStopPOI = document.querySelector<HTMLButtonElement>("#btn-stop-poi");
const btnPassPOI = document.querySelector<HTMLButtonElement>("#btn-pass-poi");

const shopControls = document.querySelector<HTMLElement>("#shop-controls");
const shopTitle = document.querySelector<HTMLElement>("#shop-title");
const btnBuyShop = document.querySelector<HTMLButtonElement>("#btn-buy-shop");
const btnPassShop = document.querySelector<HTMLButtonElement>("#btn-pass-shop");

const hudLog = document.querySelector<HTMLElement>("#hud-log");
const chkOnariLink = document.querySelector<HTMLInputElement>("#chk-onari-link");
const inputSeed = document.querySelector<HTMLInputElement>("#input-seed");
const btnResetGame = document.querySelector<HTMLButtonElement>("#btn-reset-game");

const gameOverModal = document.querySelector<HTMLElement>("#game-over-modal");
const modalWinnerTitle = document.querySelector<HTMLElement>("#modal-winner-title");
const modalWinnerDesc = document.querySelector<HTMLElement>("#modal-winner-desc");
const modalScoreDetails = document.querySelector<HTMLElement>("#modal-score-details");
const btnModalRestart = document.querySelector<HTMLButtonElement>("#btn-modal-restart");

function updateHUD(state = presenter.getState(), isAnimating = false): void {
  const activePlayer = state.players[state.activePlayerIndex];
  if (networkMode && networkVersion >= 0 && networkSeat !== undefined) {
    networkStatus.textContent = `線上房間・${networkSeat === 0 ? "Amber" : "Teal"}・版本 ${networkVersion}・${isAnimating ? "移動中" : state.phase === "GAME_OVER" ? "對局結束" : networkPending ? "等待伺服器" : networkSeat === state.activePlayerIndex ? "你的回合" : `等待 ${activePlayer.name}`}`;
  }

  if (hudPlayerDot) hudPlayerDot.style.background = activePlayer.color;
  if (hudPlayerName) hudPlayerName.textContent = `${activePlayer.name}${gameMode.value === "cpu" ? state.activePlayerIndex === 0 ? "（Human）" : "（CPU）" : ""}`;
  if (hudPlayerStatus) {
    if (state.phase === "GAME_OVER") hudPlayerStatus.textContent = "(遊戲結束)";
    else if (activePlayer.status === "FINISHED") hudPlayerStatus.textContent = "(已抵達海灘・凍結)";
    else if (activePlayer.status === "DNF") hudPlayerStatus.textContent = "(體力耗盡 DNF)";
    else hudPlayerStatus.textContent = isAnimating ? "(移動中...)" : isCPUTurn(state) ? "(正在思考...)" : `(${{ TURN_START: "準備出發", MOVING: "移動中", JUNCTION_CHOICE: "點選棋盤箭頭", POI_DECISION: "要停下參觀嗎？", RESUPPLY_DECISION: "要停下補給嗎？", GAME_OVER: "旅程結束" }[state.phase]})`;
  }

  if (hudStamina) hudStamina.textContent = `${activePlayer.stamina} / ${GAME_CONFIG.maxStamina}`;
  if (hudPoints) hudPoints.textContent = `${activePlayer.earnedPoints} 分 (花費: ${activePlayer.spentPoints})`;
  if (hudDice) hudDice.textContent = state.currentRoll !== null ? `${state.currentRoll}` : "-";
  if (hudBudget) hudBudget.textContent = `${state.remainingBudgetWU.toFixed(2)} WU`;

  // Action Buttons
  const isCommittedToPOI = Boolean(activePlayer.standingAtPOI);
  if (btnRollDice) {
    btnRollDice.style.display = state.phase === "TURN_START" && !isCommittedToPOI ? "block" : "none";
    btnRollDice.disabled = isAnimating || isUnavailable(state) || activePlayer.status !== "ACTIVE";
    btnRollDice.textContent = "擲骰 1–3（消耗 1 體力）";
  }

  if (btnVisitPOI) {
    const canVisit = state.phase === "TURN_START" && isCommittedToPOI;
    btnVisitPOI.style.display = canVisit ? "block" : "none";
    btnVisitPOI.disabled = isAnimating || isUnavailable(state) || activePlayer.status !== "ACTIVE";
    if (canVisit && activePlayer.standingAtPOI) {
      const score = GAME_CONFIG.poiScores[activePlayer.standingAtPOI] ?? 0;
      btnVisitPOI.textContent = `參觀景點（+${score} 分・消耗 1 體力）`;
    }
  }

  // Junction choices
  if (junctionControls) {
    const isJunction = state.phase === "JUNCTION_CHOICE" && !isAnimating && !isUnavailable(state);
    junctionControls.style.display = isJunction ? "block" : "none";
  }
  roadNavigation?.setState(state, isAnimating || isUnavailable(state));
  poiMarkers?.setState(state);
  poiMarkers?.layout();
  const debugMarkers = scene.getObjectByName("Board_Waypoints");
  if (debugMarkers) debugMarkers.visible = Boolean(document.querySelector<HTMLDetailsElement>(".test-mode-drawer")?.open);

  // POI choices
  if (poiControls) {
    const isPOI = state.phase === "POI_DECISION" && !isAnimating && !isUnavailable(state);
    poiControls.style.display = isPOI ? "block" : "none";
    if (isPOI && poiTitle) {
      const point = describePOIs(state).find(p => p.id === state.pendingPOI)!;
      poiTitle.textContent = `${point.name}・${point.value}：先停留，下次自己的個人回合參觀才得分。`;
    }
  }

  // Shop choices
  if (shopControls) {
    const isShop = state.phase === "RESUPPLY_DECISION" && !isAnimating && !isUnavailable(state);
    shopControls.style.display = isShop ? "block" : "none";
    if (isShop && shopTitle) {
      const point = describePOIs(state).find(p => p.id === state.pendingShop)!;
      shopTitle.textContent = `${point.name}・${point.value}（花費分數換體力，當回合補給）`;
      const netPoints = activePlayer.earnedPoints - activePlayer.spentPoints;
      if (btnBuyShop) {
        if (netPoints >= GAME_CONFIG.resupplyCost) {
          btnBuyShop.disabled = false;
          const gain = Math.min(GAME_CONFIG.resupplyGain, GAME_CONFIG.maxStamina - activePlayer.stamina);
          btnBuyShop.textContent = `花費 ${GAME_CONFIG.resupplyCost} 分 → 實得 ${gain} 體力${gain === 0 ? "（已達上限，仍會扣分）" : ""}`;
        } else {
          btnBuyShop.disabled = true;
          btnBuyShop.textContent = `積分不足（現有 ${netPoints} / 需 ${GAME_CONFIG.resupplyCost} 分）`;
        }
      }
    }
  }

  // Log
  if (hudLog) {
    hudLog.innerHTML = state.logs.map(log => `<p>${log}</p>`).join("");
    hudLog.scrollTop = hudLog.scrollHeight;
  }

  // Game over modal
  if (gameOverModal) {
    if (state.phase === "GAME_OVER") {
      gameOverModal.style.display = "block";
      if (modalWinnerTitle) {
        modalWinnerTitle.textContent = state.winner === "Tie" ? "對戰結果：平手 (Tie)！" :
          state.winner ? `勝者：${state.winner}！` : "雙方皆未完成 (Double DNF)";
      }
      if (modalWinnerDesc) {
        modalWinnerDesc.textContent = state.winner ? `恭喜 ${state.winner} 贏得鎌倉到由比濱海灘的旅程！` : "雙方皆耗盡體力未達海灘。";
      }
      if (modalScoreDetails) {
        const s0 = calculateFinalScore(state.players[0]);
        const s1 = calculateFinalScore(state.players[1]);
        modalScoreDetails.innerHTML = `
          <p><strong>Amber${gameMode.value === "cpu" ? "（Human）" : ""}:</strong> ${state.players[0].earnedPoints}分 - ${state.players[0].spentPoints}補給 + ${state.players[0].stamina}剩餘體力 = <strong>${s0 >= 0 ? s0 : 'DNF'}</strong></p>
          <p><strong>Teal${gameMode.value === "cpu" ? "（CPU）" : ""}:</strong> ${state.players[1].earnedPoints}分 - ${state.players[1].spentPoints}補給 + ${state.players[1].stamina}剩餘體力 = <strong>${s1 >= 0 ? s1 : 'DNF'}</strong></p>
        `;
      }
    } else {
      gameOverModal.style.display = "none";
    }
  }
  scheduleCPU(state, isAnimating);
}

function initGame(seed = 42, enableOnariLink = false): void {
  clearTimeout(cpuTimer); cpuTimer = undefined;
  cancelAnimationFrame(animationFrame);
  cpuMemory = createCPUMemory();
  cpuHistory = [];
  // Dispose existing presenter resources and cancel active animation
  if (presenter) {
    presenter.dispose();
  }
  isLoopRunning = false;

  const gameState = createInitialGameState({
    rngSeed: seed,
    enableCandidateOnariLink: enableOnariLink,
  });

  presenter = new Presenter(
    gameState,
    [travelers[0] as THREE.Group, travelers[1] as THREE.Group],
    scene,
    (state, isAnimating) => {
      updateHUD(state, isAnimating);
      renderMap();
    },
  );

  // Read-only test diagnostics and control hooks for QA runtime recording
  window.__stationToSeaGame = {
    scene,
    camera,
    meshes: travelers,
    presenter,
    get mode() { return gameMode.value; },
    get cpuDecisions() { return cpuHistory; },
    get traversalTrace() {
      return presenter.recordedTrace;
    },
    get animationStatus() {
      return presenter.getAnimationStatus();
    },
    getState: () => presenter.getState(),
    dispatch: (action: any) => {
      if (networkMode) return;
      presenter.dispatch(action);
      startAnimationLoop();
    },
    reset: (s?: number, l?: boolean) => { if (!networkMode) initGame(s ?? 42, l ?? false); },
  };

  updateHUD();
  renderMap();
}

// Bind Button Actions
document.querySelector(".test-mode-drawer")?.addEventListener("toggle", () => { updateHUD(); renderMap(); });
btnRollDice?.addEventListener("click", () => {
  dispatchHuman({ type: "ROLL_DICE" });
});

btnVisitPOI?.addEventListener("click", () => {
  dispatchHuman({ type: "VISIT_POI" });
});

btnStopPOI?.addEventListener("click", () => {
  dispatchHuman({ type: "STOP_AT_POI" });
});

btnPassPOI?.addEventListener("click", () => {
  dispatchHuman({ type: "PASS_POI" });
});

btnBuyShop?.addEventListener("click", () => {
  dispatchHuman({ type: "BUY_RECOVERY" });
});

btnPassShop?.addEventListener("click", () => {
  dispatchHuman({ type: "PASS_SHOP" });
});

btnResetGame?.addEventListener("click", () => {
  if (networkMode) return;
  const seed = parseInt(inputSeed?.value || "42", 10);
  const linkEnabled = Boolean(chkOnariLink?.checked);
  initGame(seed, linkEnabled);
});

btnModalRestart?.addEventListener("click", () => {
  if (networkMode) return;
  const seed = parseInt(inputSeed?.value || "42", 10);
  const linkEnabled = Boolean(chkOnariLink?.checked);
  initGame(seed, linkEnabled);
});

chkOnariLink?.addEventListener("change", () => {
  if (networkMode) return;
  const seed = parseInt(inputSeed?.value || "42", 10);
  const linkEnabled = Boolean(chkOnariLink?.checked);
  initGame(seed, linkEnabled);
});

// Start Initial Game
gameMode.addEventListener("change", () => initGame(parseInt(inputSeed?.value || "42", 10), Boolean(chkOnariLink?.checked)));
initGame(42, false);
if (networkMode) {
  gameMode.disabled = true;
  document.querySelector<HTMLDetailsElement>(".test-mode-drawer")!.hidden = true;
  if (btnModalRestart) btnModalRestart.hidden = true;
  networkStatus.hidden = false;
  networkStatus.textContent = "線上房間：連線中";
  network = new LocalNetwork(() => new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/rooms/${roomId}`), event => {
    if (event.type === "joined") {
      networkSeat = event.seat === "Amber" ? 0 : 1;
      networkStatus.textContent = `線上房間・${event.seat}・等待雙方`;
    } else if (event.type === "state") {
      if (event.version > Math.max(networkVersion, ...snapshots.map(s => s.version))) snapshots.push(event);
      drainSnapshots();
    } else {
      networkPending = false;
      if (event.type === "closed") {
        networkSeat = undefined;
        networkVersion = -1;
        snapshots.length = 0;
      }
      updateHUD();
      networkStatus.textContent = event.type === "closed" ? "連線已中斷；如未恢復，請重新整理" : `${networkStatus.textContent}・伺服器拒絕：${event.error}`;
    }
  }, roomId!);
  updateHUD();
}
