import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createMapBlockout, createZoneOverlay, MAP_GROUND_Y } from "./town/map/scene.ts";
import { createTown } from "./town/town.ts";
import { createScenicShopfronts } from "./town/shops.ts";
import { createScenicResidences } from "./town/residences.ts";
import { createBlueprintStreetfronts } from "./town/streetscape.ts";
import { createNeighborhoodDetail } from "./town/map/streetscapeDetails.ts";
import { createOnariCentralFocus } from "./town/map/onariCentral.ts";
import {
  createWakamiyaAvenueFinish,
  decorateWakamiyaShopfronts,
} from "./town/map/wakamiya.ts";
import { createCoast, createRoutePreview } from "./town/coast.ts";
import { tileSurfaceAt } from "./town/sceneryAnchors.ts";
import { loadGraph } from "./town/graph/graph.ts";
import { Director } from "./director.ts";
import { createResidents } from "./characters.ts";
import { LogPanel, RosterPanel } from "./panels.ts";
import { getLog } from "./log.ts";
import "./style.css";

declare global {
  interface Window {
    __agentMachi?: { log: () => readonly string[] };
  }
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app");
const statusElement = document.querySelector<HTMLDivElement>("#bridge-status");
if (!statusElement) throw new Error("Missing #bridge-status");

const BACKGROUND_COLOR = "#16191d";
const scene = new THREE.Scene();
scene.background = new THREE.Color(BACKGROUND_COLOR);
scene.add(createMapBlockout());
scene.add(createNeighborhoodDetail(MAP_GROUND_Y));
scene.add(createZoneOverlay());

const town = createTown();
if (town.children.length !== 17) {
  throw new Error("Source town composition changed: revisit blockout reuse indexes");
}

const station = town.children[0];
station.position.set(-0.40, MAP_GROUND_Y, -6.25);
station.scale.setScalar(1.12);

const jr = town.children[1];
jr.position.set(0, MAP_GROUND_Y - tileSurfaceAt(1, -2).y, -7.47 - tileSurfaceAt(1, -2).z);
jr.scale.x = 1.40;

const homePlacement = [
  [1.49, -4.32, 0.34],
  [1.98, -2.76, -0.48],
  [-3.78, 3.30, 0.16],
  [1.33, 3.95, -0.10],
] as const;
for (let i = 0; i < 4; i += 1) {
  const home = town.children[2 + i];
  const [x, z, rotation] = homePlacement[i];
  home.position.set(x, MAP_GROUND_Y, z);
  home.rotation.y = rotation;
  home.scale.setScalar(i === 1 ? 1.08 : 1.17);
}

for (let i = 6; i <= 8; i += 1) town.children[i].visible = false;

const treeSites: readonly [number, number][] = [
  [-6.08, -0.78],
  [1.10, -6.17],
  [6.15, -2.03],
  [6.20, 3.05],
];
const shrubSites: readonly [number, number][] = [
  [-4.50, -2.05],
  [-4.24, 4.30],
  [1.44, -0.94],
  [2.35, 4.04],
];
treeSites.forEach(([x, z], i) => town.children[9 + i].position.set(x, MAP_GROUND_Y, z));
shrubSites.forEach(([x, z], i) => town.children[13 + i].position.set(x, MAP_GROUND_Y, z));
scene.add(town);

const scenicShops = createScenicShopfronts(MAP_GROUND_Y);
decorateWakamiyaShopfronts(scenicShops);
scene.add(scenicShops);

scene.add(createScenicResidences(MAP_GROUND_Y));

const blueprintShops = createBlueprintStreetfronts(MAP_GROUND_Y);
decorateWakamiyaShopfronts(blueprintShops);
scene.add(blueprintShops);
scene.add(createOnariCentralFocus(MAP_GROUND_Y));
scene.add(createWakamiyaAvenueFinish(MAP_GROUND_Y));

const sourcePreview = createRoutePreview();
const previewTravelers = sourcePreview.children.filter((object) => object.name.includes("traveller"));
if (previewTravelers.length !== 2) throw new Error("Expected both original traveler assets");
previewTravelers.forEach((traveler) => {
  traveler.visible = false;
  scene.add(traveler);
});

const residents = createResidents();
for (const resident of residents) {
  resident.visible = false;
  scene.add(resident);
}
const travelers = [...previewTravelers, ...residents];

const coast = createCoast();
coast.scale.x = 1.65;
coast.position.z = 2.82;
scene.add(coast);

const tabletop = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshBasicMaterial({ color: BACKGROUND_COLOR, toneMapped: false }),
);
tabletop.rotation.x = -Math.PI / 2;
tabletop.position.y = -0.025;
tabletop.receiveShadow = true;
scene.add(tabletop);

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

const focus = new THREE.Vector3(0, 0.28, 0.65);
const camera = new THREE.OrthographicCamera(-12, 12, 8, -8, 0.1, 120);
const cameraOffset = new THREE.Vector3(15, 21, 30);
camera.position.copy(focus).add(cameraOffset);
camera.lookAt(focus);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(focus);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minPolarAngle = 0.12;
controls.maxPolarAngle = Math.PI / 2 - 0.08;
// OrthographicCamera zooms through camera.zoom, not camera distance, so the
// effective OrbitControls limits are minZoom/maxZoom (equivalent distance
// range is about 72.0 to 7.9 world units for the initial offset).
controls.minZoom = 0.55;
controls.maxZoom = 5;
controls.update();

const initialCameraPosition = camera.position.clone();
const initialTarget = controls.target.clone();
const resetButton = document.querySelector<HTMLButtonElement>("#reset-view");
if (!resetButton) throw new Error("Missing #reset-view");
resetButton.addEventListener("click", () => {
  camera.position.copy(initialCameraPosition);
  controls.target.copy(initialTarget);
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  controls.update();
});

function resize(): void {
  const width = Math.max(1, app!.clientWidth);
  const height = Math.max(1, app!.clientHeight);
  const aspect = width / height;
  const viewHeight = 20;
  camera.left = (-viewHeight * aspect) / 2;
  camera.right = (viewHeight * aspect) / 2;
  camera.top = viewHeight / 2;
  camera.bottom = -viewHeight / 2;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
}
window.addEventListener("resize", resize);
resize();

const graph = loadGraph();
const director = new Director(graph, travelers, MAP_GROUND_Y, statusElement, scene);
const bridgeUrl =
  new URLSearchParams(window.location.search).get("bridge") ||
  `http://${location.hostname}:8731`;
new RosterPanel(director);
new LogPanel(director, bridgeUrl);
director.start(bridgeUrl);

window.__agentMachi = { log: getLog };

const clock = new THREE.Clock();
function frame(): void {
  const dt = Math.min(clock.getDelta(), 0.1);
  director.update(dt);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
