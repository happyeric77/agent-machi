import * as THREE from "three";
import {
  createResidentialHouse, createResidentialTree, createResidentialShrub,
} from "../town";

// Scenic streetscape ONLY: Onari shop identity and B04 residence grouping.
// Existing detailed source houses, shops, roads and camera are preserved.
const material = (color: string) => new THREE.MeshStandardMaterial({
  color, flatShading: true, roughness: 1,
});
const timber = material("#735b4b");
const stone = material("#b9ae99");
const plaster = material("#e5d8c1");
const darkRoof = material("#5d7674");
const clayRoof = material("#b78a76");
const green = material("#86a086");
const clothBlue = material("#60827d");
const clothRust = material("#b17e6e");
const lantern = material("#f1d8ac");
const courtyardEarth = material("#bba889");
const courtyardGravel = material("#dfd1b6");
const plantedEdge = material("#91a38a");
const cube = new THREE.BoxGeometry(1, 1, 1);
const leafShape = new THREE.IcosahedronGeometry(0.13, 0);

// Original low-poly garden treatment, but broad enough to register as an
// actual shared household space at the NEW local Explore camera distance.
// Offsets are local to each family courtyard; the opening faces the lane.
function courtSurface(
  group: THREE.Group, name: string,
  footprint: readonly (readonly [number, number])[],
  mat: THREE.Material,
): void {
  const shape = new THREE.Shape();
  footprint.forEach(([x, z], i) => {
    if (i === 0) shape.moveTo(x, -z);
    else shape.lineTo(x, -z);
  });
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0.018, 0);
  const surface = new THREE.Mesh(geo, mat);
  surface.name = name;
  surface.receiveShadow = true;
  group.add(surface);
}

function part(g: THREE.Group, m: THREE.Material,
  w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(cube, m);
  mesh.position.set(x, y, z);
  mesh.scale.set(w, h, d);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}

// Continuous low boundary runs (with caller-defined breaks for entrances).
// Visual only: not a movement blocker or collision system.
function gardenBoundary(g: THREE.Group,a:readonly [number,number],b:readonly [number,number]):void {
  const dx=b[0]-a[0], dz=b[1]-a[1], length=Math.hypot(dx,dz);
  if(length<0.08)return;
  const angle=Math.atan2(dx,dz);
  const plinth=part(g,stone,0.082,0.07,length,(a[0]+b[0])/2,0.047,(a[1]+b[1])/2);
  plinth.rotation.y=angle;
  const rail=part(g,timber,0.050,0.064,length,(a[0]+b[0])/2,0.183,(a[1]+b[1])/2);
  rail.rotation.y=angle;
  for(const [x,z] of [a,b])part(g,timber,0.075,0.26,0.075,x,0.14,z);
}

function onariStorefronts(groundY: number): THREE.Group {
  const group = new THREE.Group();
  group.name = "Onari B01/B03: linked commercial frontage and shop banners";
  const sites = [
    { x: -3.47, z: -5.31, textile: clothBlue },
    { x: -3.67, z: -3.98, textile: clothRust },
    { x: -3.55, z: -2.62, textile: clothBlue },
    { x: -3.65, z: -1.29, textile: clothRust },
  ];
  for (const [i, site] of sites.entries()) {
    // These four frontages follow the existing four original-quality
    // shops; local +Z becomes road-facing world +X.
    const door = new THREE.Group();
    door.position.set(site.x, groundY, site.z);
    door.rotation.y = Math.PI / 2;
    door.name = "B01/B03 narrow street entrance " + (i + 1);
    part(door, timber, 0.72, 0.045, 0.14, 0, 0.082, 0.53);
    for (const x of [-0.50, 0.50]) {
      part(door, timber, 0.045, 0.55, 0.05, x, 0.37, 0.48);
    }
    const flagX = i % 2 === 0 ? -0.42 : 0.42;
    part(door, timber, 0.026, 0.63, 0.025, flagX, 1.00, 0.48);
    part(door, site.textile, 0.15, 0.31, 0.026,
      flagX + (flagX < 0 ? 0.07 : -0.07), 0.99, 0.52);
    if (i % 2 === 0) {
      part(door, lantern, 0.14, 0.19, 0.14, 0.27, 0.65, 0.53);
    }
    group.add(door);
  }
  // Each small sill joins a gap between shop roofs, without crossing the
  // Onari ribbon, western rail or residential alleys.
  for (const z of [-4.65, -3.30, -1.96]) {
    part(group, timber, 0.056, 0.055, 0.19,
      -2.96, groundY + 0.63, z);
  }
  // Both planters moved west, out of the walkable back lane, into the
  // rear-garden gap between the B01 and B03 rear houses (G3 v0.6g). The
  // original models, materials and sizes are preserved; only the two
  // world X/Z positions changed. Coordinates pending Owner visual review.
  for (const [x, z] of [[-5.60, -4.30], [-5.15, -4.30]] as const) {
    part(group, stone, 0.27, 0.15, 0.28, x, groundY + 0.08, z);
    const leaf = new THREE.Mesh(leafShape, green);
    leaf.position.set(x, groundY + 0.22, z);
    leaf.castShadow = true;
    group.add(leaf);
  }
  return group;
}

function annex(style: "wood" | "plaster"): THREE.Group {
  // Tiny garden studios are not replacements for the accepted M1 houses.
  const g = new THREE.Group();
  const wall = style === "wood" ? timber : plaster;
  const roof = style === "wood" ? darkRoof : clayRoof;
  g.name = "B04 miniature gabled side studio " + style;
  part(g, stone, 0.62, 0.05, 0.54, 0, 0.025, 0);
  part(g, wall, 0.56, 0.51, 0.47, 0, 0.31, 0);
  part(g, timber, 0.20, 0.39, 0.04, 0.06, 0.27, 0.26);
  const run = 0.32, rise = 0.18;
  for (const side of [-1, 1]) {
    const slope = part(g, roof, 0.70, 0.047, Math.hypot(run, rise) + 0.035,
      0, 0.60 + rise / 2, side * run / 2);
    slope.rotation.x = side * Math.atan2(rise, run);
  }
  part(g, roof, 0.73, 0.046, 0.055, 0, 0.60 + rise, 0);
  return g;
}

function centralCourts(groundY: number): THREE.Group {
  const group = new THREE.Group();
  group.name = "B04 quiet home grouping: low garden, sheds, uneven stone alley";
  for (const item of [
    // Two small rear-side rooflines now sit WITH the eastern house group;
    // the west side deliberately opens to its shared courtyard instead.
    { x: 2.45, z: -5.30, yaw: Math.PI, style: "wood" },
    { x: 2.68, z: -3.69, yaw: -0.16, style: "plaster" },
  ] as const) {
    const shed = annex(item.style);
    shed.position.set(item.x, groundY, item.z);
    shed.rotation.y = item.yaw;
    group.add(shed);
  }
  // Whole-lot composition (not tiny independent courtyard stamps).
  // Houses KEEP their existing world positions, roofs and visible fronts.
  // These two warm private parcel surfaces stop well short of the
  // centerline of the 0.51-wide public S-bend.
  //
  // WEST B04: paired houses at (-1.35,-3.60) and (-1.24,-1.55)
  // share a continuous, legible irregular residential plot.
  const west = new THREE.Group();
  west.position.set(0, groundY, 0);
  west.name = "B04 WEST entire enclosed residential parcel / open east gateway";
  courtSurface(west, "B04 WEST whole family parcel", [
    [-2.29,-4.16],[-1.88,-4.30],[-1.03,-4.26],
    [-0.57,-3.98],[-0.56,-3.13],[-0.51,-2.16],
    [-0.58,-1.10],[-1.23,-1.04],[-2.21,-1.13],
    [-2.33,-1.55],[-2.35,-3.65],
  ], courtyardEarth);
  // Defined WEST and EAST edges now span the full group of homes. Two
  // interrupted lane-facing runs create a visible main gate at z~-2.55.
  gardenBoundary(west,[-2.25,-4.03],[-2.27,-1.24]);
  gardenBoundary(west,[-2.25,-4.03],[-1.98,-4.17]);
  gardenBoundary(west,[-2.27,-1.24],[-1.97,-1.14]);
  gardenBoundary(west,[-0.55,-3.94],[-0.55,-3.03]);
  gardenBoundary(west,[-0.55,-2.04],[-0.55,-1.19]);
  // Continuous low planting down the back of the houses makes the
  // estate boundary read without any tall or closed perimeter wall.
  part(west, plantedEdge, 0.19,0.12,1.06, -2.10,0.082,-3.27);
  part(west, plantedEdge, 0.19,0.12,0.78, -2.10,0.082,-1.87);
  // Contrast the threshold with the main earth parcel. It reaches
  // outside the fence gate but does NOT blanket the S-bend road.
  for (const [x,z,w,l] of [
    [-0.55,-2.54,0.36,0.36],
    [-0.83,-2.54,0.26,0.33],
    [-1.17,-2.51,0.24,0.25],
  ] as const) {
    part(west,courtyardGravel,w,0.025,l,x,0.028,z);
  }
  group.add(west);

  // EAST B04: another COMPLETE plot connects the existing three main
  // roofs and both annexes. Its lane-facing WEST border has a clear
  // 0.76-wide center gap, not scattered rail stubs.
  const east = new THREE.Group();
  east.position.set(0,groundY,0);
  east.name = "B04 EAST entire enclosed residential parcel / open west gateway";
  courtSurface(east,"B04 EAST whole family parcel",[
    [0.78,-5.17],[1.20,-5.31],[2.73,-5.25],
    [3.07,-5.06],[3.10,-3.96],[3.11,-2.20],
    [3.06,-1.04],[2.55,-0.99],[1.30,-1.08],
    [0.83,-1.35],[0.82,-2.80],[0.77,-4.18],
  ],courtyardEarth);
  // The long outer margin reads as residential garden enclosure behind
  // source-quality homes. Break it beside the existing annex to avoid
  // stacking timber over the tiny annex roof.
  gardenBoundary(east,[3.06,-5.02],[3.06,-4.18]);
  gardenBoundary(east,[3.06,-3.10],[3.06,-1.19]);
  gardenBoundary(east,[3.06,-5.02],[2.84,-5.15]);
  gardenBoundary(east,[3.06,-1.19],[2.86,-1.09]);
  // An interrupted WEST perimeter defines the S-bend-side courtyard gate
  // (z=-3.70..-2.92), with original street ribbon entirely untouched.
  gardenBoundary(east,[0.79,-3.98],[0.79,-3.70]);
  gardenBoundary(east,[0.79,-2.92],[0.79,-1.23]);
  part(east, plantedEdge,0.18,0.11,0.66,2.93,0.078,-4.72);
  part(east, plantedEdge,0.18,0.11,1.20,2.93,0.078,-2.02);
  for (const [x,z,w,l] of [
    [0.82,-3.32,0.36,0.40],
    [1.09,-3.32,0.25,0.32],
    [1.43,-3.32,0.26,0.27],
  ] as const) {
    part(east,courtyardGravel,w,0.025,l,x,0.028,z);
  }
  group.add(east);

  // Small staggered threshold stones emphasize a narrow side passage,
  // not a graph edge, and do not touch the north/south major roads.
  for (let i = 0; i < 6; i++) {
    part(group, stone, 0.18, 0.018, 0.22,
      -0.60 + 0.07 * Math.sin(i * 1.21), groundY + 0.018,
      -3.38 + i * 0.38);
  }
  for (const z of [-4.07, -3.88, -3.69]) {
    part(group, timber, 0.045, 0.16, 0.045,
      2.77, groundY + 0.09, z);
  }
  part(group, timber, 0.040, 0.04, 0.46,
    2.77, groundY + 0.18, -3.88);
  return group;
}

// The 2D B01/B03 concept is a layered district: Onari shops in FRONT,
// a few true detailed homes and gardens BEHIND, Enoden framed by planting.
// These original M1 house/tree factories are reused, never generic boxes.
function railSideBackLots(groundY: number): THREE.Group {
  const back = new THREE.Group();
  back.name = "B01/B03 Onari back-lane homes with planted Enoden buffer";

  // Both new homes sit between the existing four-shop frontage and the
  // Enoden-inspired rail ribbon without entering the 311 street corridor.
  const familyLots = [
    { name: "B03 timber-facade rear household", variant: 1 as const,
      x: -5.30, z: -3.36, yaw: -0.25, scale: 0.77 },
    { name: "B03 south rear tiny household", variant: 2 as const,
      x: -5.34, z: -1.67, yaw: 0.17, scale: 0.73 },
  ];
  for (const site of familyLots) {
    const home = createResidentialHouse(site.variant);
    home.name = site.name + " / original detailed source home";
    home.position.set(site.x, groundY, site.z);
    home.rotation.y = site.yaw;
    home.scale.setScalar(site.scale);
    back.add(home);
  }

  // Broad crowns, not tiny potted shrub dots, create the rail-to-town
  // transition present in the concept art. Keep rails/ties and doorways
  // visible through distinct breaks between the planted pockets.
  const treeLots: readonly [number, number, 0 | 1, number][] = [
    [-5.95, -5.79, 0, 0.72],
    [-5.94, -4.08, 1, 0.72],
    [-5.96, -2.37, 0, 0.70],
  ];
  for (const [x, z, kind, scale] of treeLots) {
    const planted = createResidentialTree(kind);
    planted.position.set(x, groundY, z);
    planted.scale.setScalar(scale);
    planted.name = "B01/B03 Enoden lane tree group";
    back.add(planted);
  }

  const shrubLots: readonly [number, number][] = [
    [-5.90, -5.35], [-5.97, -3.89], [-5.91, -2.61], [-5.96, -1.13],
  ];
  for (const [x, z] of shrubLots) {
    const planted = createResidentialShrub();
    planted.position.set(x, groundY, z);
    planted.name = "B01/B03 planted rear-garden edge";
    back.add(planted);
  }
  // Three short, broken, LOW garden boundary runs sit between original
  // foliage and the west-side Enoden rail. Gaps preserve sightlines and
  // the inner alley; these are not collision walls or rail crossings.
  for (const [x, z, length] of [
    [-6.22, -5.18, 0.87],
    [-6.21, -3.68, 1.00],
    [-6.20, -1.98, 0.96],
  ] as const) {
    part(back, stone, 0.045, 0.075, length, x, groundY + 0.046, z);
    part(back, green, 0.14, 0.10, length * 0.66,
      x + 0.11, groundY + 0.095, z);
  }
  return back;
}

// B04 needs the TWO clusters of houses to read as a shared green
// residential fabric in overview. These full-size M1 foliage silhouettes
// bind the existing main homes/annexes into garden plots instead of adding
// tiny decorative stones that cannot be perceived from an overview.
function centralGreenCourts(groundY: number): THREE.Group {
  const plots = new THREE.Group();
  plots.name = "B04 paired-house garden volumes around narrow central lane";
  const trees: readonly [number, number, 0 | 1, number][] = [
    // Keep west court's lane-side entrance FREE of tree canopy/trunk.
    [-1.98, -2.55, 0, 0.64],
    [2.56, -4.39, 1, 0.75],
    [0.90, -1.12, 0, 0.65],
  ];
  for (const [x, z, kind, scale] of trees) {
    const tree = createResidentialTree(kind);
    tree.position.set(x, groundY, z);
    tree.scale.setScalar(scale);
    tree.name = "B04 original model tree / courtyard canopy";
    plots.add(tree);
  }
  const shrubs: readonly [number, number][] = [
    [-1.79, -3.90], [-0.83, -3.58], [2.73, -4.17],
    [1.87, -1.59], [-1.76, -2.20],
  ];
  for (const [x, z] of shrubs) {
    const shrub = createResidentialShrub();
    shrub.position.set(x, groundY, z);
    shrub.name = "B04 family garden foliage / not street obstacle";
    plots.add(shrub);
  }
  return plots;
}

export function createOnariCentralFocus(groundY: number): THREE.Group {
  const focus = new THREE.Group();
  focus.name = "Blueprint composition test: Onari commerce + B04 home courts";
  focus.add(onariStorefronts(groundY));
  focus.add(railSideBackLots(groundY));
  focus.add(centralCourts(groundY));
  focus.add(centralGreenCourts(groundY));
  return focus;
}
