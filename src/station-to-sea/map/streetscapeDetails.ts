import * as THREE from "three";

// Blueprint-aligned block-level scenery. This layer organizes streets and
// gardens without replacing existing detailed houses, shops or ground mesh.
// These are hand-authored visual parcels, not game tiles/path/colliders.
type Point = readonly [number, number];
type Lot = { name: string; style: "shop" | "home" | "garden"; border: readonly Point[] };
const mat = (color: string): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true, side: THREE.DoubleSide });
const ink = {
  shop: mat("#c4b9a5"),
  home: mat("#b5bea9"),
  garden: mat("#9db496"),
  stone: mat("#b7ac98"),
  timber: mat("#816b56"),
  greenery: mat("#779880"),
  sand: mat("#d9ceb2"),
  lamp: new THREE.MeshStandardMaterial({ color: "#f1dfb9", roughness: 1, emissive: "#665940", emissiveIntensity: 0.12 }),
};
const cube = new THREE.BoxGeometry(1, 1, 1);
const bush = new THREE.IcosahedronGeometry(0.14, 0);
const globe = new THREE.SphereGeometry(0.105, 7, 5);
function box(group: THREE.Group, material: THREE.Material,
  w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(cube, material);
  mesh.position.set(x, y, z);
  mesh.scale.set(w, h, d);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

// The 2D reference shows street-facing BUILDING GROUPS rather than model
// samples surrounded by turf. These irregular pads link groups behind each
// frontage and remain OFF the named roads, rail bed and A/B/C clearances.
const lots: readonly Lot[] = [
  { name: "B01/B03 continuous Onari shop-side apron", style: "shop",
    border: [[-4.70,-5.90],[-3.02,-5.90],[-2.99,-4.30],[-3.04,-2.40],[-3.06,-0.89],[-4.75,-0.91],[-4.86,-3.00]] },
  // Rear lots and the narrow inner alley now have enough visual depth
  // because the miniature's western side was widened in this pass.
  { name: "B01/B03 Enoden-facing rear household gardens", style: "home",
    border: [[-5.86,-5.95],[-4.83,-5.88],[-4.80,-3.98],
      [-4.82,-2.65],[-4.84,-1.09],[-5.85,-1.13],[-6.02,-3.54]] },
  { name: "B02/B05 east Wakamiya shop-side apron", style: "shop",
    border: [[4.54,-5.68],[5.89,-5.62],[5.87,-3.72],[5.81,-1.07],[4.52,-1.05]] },
  // B04 used to be painted twice: these narrow under-lot strips made the
  // later tiny yards impossible to distinguish. The TWO complete B04
  // parcel surfaces/edges are now composed once in onariCentral.ts.
  { name: "B06 western small family block", style: "home",
    border: [[-4.96,0.45],[-2.72,0.42],[-2.69,1.43],[-3.13,1.62],[-4.94,1.57]] },
  { name: "B06 Wadazuka-inspired garden back lots", style: "garden",
    border: [[-4.57,2.81],[-3.03,2.83],[-3.02,4.24],[-3.90,4.46],[-4.66,4.25]] },
  { name: "B07 staggered inner courtyard block", style: "home",
    border: [[-2.01,0.83],[-0.96,0.83],[-0.93,1.92],[-1.06,3.62],[-0.94,4.52],[-1.98,4.49]] },
  { name: "B07 east planted home lots", style: "garden",
    border: [[1.54,0.70],[2.76,0.70],[2.76,1.97],[2.80,3.40],[1.75,3.45],[1.35,2.49]] },
  { name: "B08 southern Wakamiya shop plot", style: "shop",
    border: [[4.55,1.84],[5.75,1.87],[5.85,2.89],[5.72,3.32],[4.55,3.28]] },
  { name: "B08 east small seaside residential pocket", style: "home",
    border: [[4.64,3.65],[6.00,3.67],[6.00,4.57],[5.52,4.82],[4.65,4.71]] },
];

function flatLot(lot: Lot, groundY: number): THREE.Mesh {
  const outline = new THREE.Shape();
  lot.border.forEach(([x, z], i) => {
    if (i === 0) outline.moveTo(x, -z);
    else outline.lineTo(x, -z);
  });
  outline.closePath();
  const geometry = new THREE.ShapeGeometry(outline, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, groundY + 0.006, 0);
  const mesh = new THREE.Mesh(geometry, ink[lot.style]);
  mesh.name = lot.name + " / decorative plot, not a gameplay tile";
  mesh.receiveShadow = true;
  return mesh;
}

// A softly winding narrow service/walking ALLEY makes the Onari back row
// legible. It is scenic circulation, not a game route/path graph.
function onariBackLane(y: number): THREE.Group {
  const lane = new THREE.Group();
  lane.name = "B01/B03 inner passage between shopfront and rear houses";
  const stops: readonly Point[] = [
    [-4.46,-5.60],[-4.41,-4.77],[-4.48,-3.88],
    [-4.43,-2.86],[-4.49,-1.93],[-4.42,-1.21],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [ax,az] = stops[i-1], [bx,bz] = stops[i];
    const dx=bx-ax, dz=bz-az;
    // Physically meaningful pedestrian-width visual lane, not a hairline
    // between model lots. Shop backs and the detailed rear homes still
    // have grass/setback space on both sides.
    const width = 0.39, length = Math.hypot(dx,dz);
    const panel = box(lane, ink.stone, width, 0.025, length,
      (ax+bx)/2, y+0.023, (az+bz)/2);
    panel.rotation.y = Math.atan2(dx,dz);
  }
  return lane;
}

function lowFence(group: THREE.Group, a: Point, b: Point, y: number): void {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  const edge = box(group, ink.stone, 0.06, 0.09, length,
    (a[0]+b[0])/2, y+0.05, (a[1]+b[1])/2);
  edge.rotation.y = Math.atan2(dx, dz);
}

function bushes(group: THREE.Group, x: number, z: number, y: number,
  count: number, horizontal: boolean): void {
  for(let i = 0; i < count; i++) {
    const pos = (i-(count-1)/2)*0.23;
    const shrub = new THREE.Mesh(bush, ink.greenery);
    shrub.position.set(x+(horizontal?pos:0), y+0.13, z+(horizontal?0:pos));
    shrub.scale.y = 0.9+(i%2)*0.15;
    shrub.castShadow = true;
    group.add(shrub);
  }
}

function lamp(group: THREE.Group, x:number, z:number, y:number): void {
  box(group, ink.timber, 0.055, 0.74, 0.055, x, y+0.37, z);
  box(group, ink.timber, 0.18, 0.05, 0.18, x, y+0.76, z);
  const light = new THREE.Mesh(globe, ink.lamp);
  light.position.set(x, y+0.69, z);
  light.castShadow = true;
  group.add(light);
}

function blockEdges(y:number): THREE.Group {
  const edge = new THREE.Group();
  edge.name = "B01–B08 gardens and lamplit street-facing blocks";
  const fences: readonly [Point, Point][] = [
    [[-4.82,-3.38],[-4.82,-2.64]],
    [[-1.91,-3.57],[-1.91,-3.08]],
    [[2.72,-2.41],[2.72,-1.95]],
    [[-4.59,3.92],[-4.08,4.10]],
    [[-1.92,3.66],[-1.92,4.26]],
    [[5.95,3.82],[5.95,4.47]],
  ];
  fences.forEach(([a,b]) => lowFence(edge, a, b, y));
  const hedges: readonly [number,number,number,boolean][] = [
    [-4.81,-2.10,3,false],[-1.83,-2.16,3,false],
    [2.58,-3.52,3,false],[-4.50,3.77,3,true],
    [-3.10,3.94,3,true],[-1.91,2.04,3,false],
    [2.55,2.56,3,false],[5.67,4.54,3,true],
  ];
  hedges.forEach(([x,z,n,h]) => bushes(edge,x,z,y,n,h));
  // Both street axes gain legible human-scale rhythm while road centers
  // and the narrow residential passage remain physically open.
  const lightSites: readonly Point[] = [
    [-2.95,-5.60],[-2.95,-4.18],[-2.96,-2.86],[-2.95,-1.59],
    [2.98,-5.08],[2.99,-3.56],[3.00,-0.67],[2.99,4.04],
  ];
  lightSites.forEach(([x,z]) => lamp(edge,x,z,y));
  return edge;
}

function coastalTransition(y:number): THREE.Group {
  const shore = new THREE.Group();
  shore.name = "B09 planted coastal footpath; C clearance and original water preserved";
  // A slightly curved series of small stone boards visually separates
  // the coastal road from sand, instead of a single featureless color band.
  for(let i=0;i<16;i++) {
    const x=-5.0+i*0.65, z=5.90+0.035*Math.sin(x*0.9);
    box(shore,ink.sand,0.61,0.026,0.18,x,y+0.018,z);
    box(shore,ink.stone,0.017,0.004,0.18,x-0.30,y+0.034,z);
  }
  // Low dune plants FRAME, never fill, the south-center sea approach.
  for(const [x,z] of [
    [-4.44,5.92],[-3.72,5.96],[-2.85,5.94],
    [2.84,5.94],[3.84,5.94],[4.65,5.91],
  ] as const) bushes(shore,x,z,y,2,true);
  for(const x of [-4.82,4.82]) {
    box(shore,ink.stone,0.52,0.043,0.29,x,y+0.025,5.67);
    for(const dx of [-0.21,0.21]) {
      box(shore,ink.timber,0.044,0.27,0.044,x+dx,y+0.14,5.64);
    }
  }
  return shore;
}

export function createNeighborhoodDetail(groundY:number):THREE.Group {
  const group=new THREE.Group();
  group.name="Screenshot-driven neighborhood composition B.2";
  lots.forEach(lot => group.add(flatLot(lot,groundY)));
  group.add(onariBackLane(groundY));
  group.add(blockEdges(groundY));
  group.add(coastalTransition(groundY));
  return group;
}
