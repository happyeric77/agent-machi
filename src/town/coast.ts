import * as THREE from "three";
import { tileSurfaceAt } from "./sceneryAnchors";

// M1.3 visual composition only: no route graph, turn state, or gameplay logic.
type ShorePoint = readonly [x: number, z: number];

const shore = {
  sand: new THREE.MeshStandardMaterial({ color: "#ead8b3", roughness: 1, flatShading: true }),
  sandSide: new THREE.MeshStandardMaterial({ color: "#bda787", roughness: 1, flatShading: true }),
  water: new THREE.MeshStandardMaterial({ color: "#7bbdc0", roughness: 0.78, metalness: 0, flatShading: true }),
  deepWater: new THREE.MeshStandardMaterial({ color: "#4e9da4", roughness: 1, metalness: 0, flatShading: true }),
  foam: new THREE.MeshBasicMaterial({ color: "#f0fbf4", transparent: true, opacity: 0.78, side: THREE.DoubleSide, depthWrite: false }),
  foamSecondary: new THREE.MeshBasicMaterial({ color: "#ddf3e9", transparent: true, opacity: 0.48, side: THREE.DoubleSide, depthWrite: false }),
  shells: new THREE.MeshStandardMaterial({ color: "#f8e6ca", roughness: 1, flatShading: true }),
  dune: new THREE.MeshStandardMaterial({ color: "#d9c7a8", roughness: 1, flatShading: true, side: THREE.DoubleSide }),
  dryBeach: new THREE.MeshStandardMaterial({ color: "#e6d4b2", roughness: 1, flatShading: true, side: THREE.DoubleSide }),
  wetBeach: new THREE.MeshStandardMaterial({ color: "#c9b69b", roughness: 1, flatShading: true, side: THREE.DoubleSide }),
};

function extrudedContour(
  outline: readonly ShorePoint[],
  height: number,
  elevation: number,
  top: THREE.Material,
  sides: THREE.Material,
): THREE.Mesh {
  // Shape's Y maps to world -Z after a -90° X rotation.
  const path = new THREE.Shape();
  outline.forEach(([x, z], index) => {
    if (index === 0) path.moveTo(x, -z);
    else path.lineTo(x, -z);
  });
  path.closePath();
  const geometry = new THREE.ExtrudeGeometry(path, {
    depth: height,
    steps: 1,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, elevation, 0);
  const slab = new THREE.Mesh(geometry, [top, sides]);
  slab.castShadow = true;
  slab.receiveShadow = true;
  return slab;
}

// B.3b final southeast fix: reshape ONLY the sand slab's visible
// eastern RIM, without changing its outline/footprint or adding a second
// overlaid sand mesh. The original 0.48-high tabletop slab is still full
// thickness beneath the inland beach; the x>3.45 / z>3.02 corner thins
// gradually to a ~0.02 sand lip above the accepted turquoise water.
// This avoids another exposed dark 0.48-high side wall at the tip.
function easternSandTaper(x:number,z:number):number {
  const across=THREE.MathUtils.smoothstep(x,3.45,3.90);
  const towardSea=THREE.MathUtils.clamp((z-3.02)/0.85,0,1);
  return across*towardSea;
}
function gradeEasternSandRim(sand:THREE.Mesh):void {
  const points=sand.geometry.getAttribute("position") as THREE.BufferAttribute;
  for(let i=0;i<points.count;i++){
    const x=points.getX(i), y=points.getY(i), z=points.getZ(i);
    const taper=easternSandTaper(x,z);
    if(taper<0.000001)continue;
    if(y>0.30){
      // Original sand TOP y=.045+.48=.525. The surf-contact end
      // resolves to .265, just above the untouched water top .245.
      points.setY(i,0.525-0.260*Math.sqrt(taper));
    }else{
      // Raise the BOTTOM of the exposed shore-side face toward the same
      // water level. Keep >=.020 material between bottom and top.
      const top=0.525-0.260*Math.sqrt(taper);
      points.setY(i,Math.min(top-0.020,0.045+0.200*Math.min(1,taper*2.1)));
    }
  }
  points.needsUpdate=true;
  sand.geometry.computeVertexNormals();
  sand.geometry.computeBoundingBox();
  sand.geometry.computeBoundingSphere();
}

function waveRibbon(
  points: readonly ShorePoint[],
  width: number,
  height: number,
  material: THREE.Material,
): THREE.Mesh {
  // Flat ribbon following a hand-authored shoreline, not animated water.
  const positions: number[] = [];
  for (let index = 0; index + 1 < points.length; index += 1) {
    const [x1, z1] = points[index];
    const [x2, z2] = points[index + 1];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const length = Math.hypot(dx, dz) || 1;
    const px = (-dz * width) / (length * 2);
    const pz = (dx * width) / (length * 2);
    positions.push(
      x1 + px, height, z1 + pz,
      x1 - px, height, z1 - pz,
      x2 + px, height, z2 + pz,
      x1 - px, height, z1 - pz,
      x2 - px, height, z2 - pz,
      x2 + px, height, z2 + pz,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const foam = new THREE.Mesh(geometry, material);
  foam.renderOrder = 2;
  return foam;
}

// A low piecewise-slope ribbon bridges the original M1.3 raised board
// (top y=0.59) through sand (top y=0.525) down to the water (top y=0.245).
// All Y coordinates here are LOCAL to createCoast(); main.ts only changes
// x scale and z position. No vertical water wall or coplanar sand stamp.
function shoreSlope(
  spine: readonly ShorePoint[],
  fromZ: number, toZ: number,
  fromY: number, toY: number,
  material: THREE.Material,
  label: string,
  fromHeightAt?: (x:number,z:number)=>number,
): THREE.Mesh {
  const positions: number[] = [];
  for (let index = 0; index + 1 < spine.length; index++) {
    const [ax, az] = spine[index];
    const [bx, bz] = spine[index + 1];
    const ay=fromHeightAt?.(ax,az) ?? fromY;
    const by=fromHeightAt?.(bx,bz) ?? fromY;
    positions.push(
      ax, ay, az + fromZ,
      bx, by, bz + fromZ,
      ax, toY, az + toZ,
      ax, toY, az + toZ,
      bx, by, bz + fromZ,
      bx, toY, bz + toZ,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = label + " — scenic grade, no playable path";
  mesh.receiveShadow = true;
  return mesh;
}

export function createCoast(): THREE.Group {
  const coast = new THREE.Group();
  coast.name = "Seaside miniature — sand, surf and shallow water";

  // Land slips beneath the front row of raised terrain pieces. The shore
  // extends from those tiles into a small, self-contained turquoise sea slab.
  const sand: ShorePoint[] = [
    [-3.48, 3.18], [-2.60, 3.32], [-1.55, 3.39],
    [-0.40, 3.38], [0.70, 3.37], [1.70, 3.42], [2.62, 3.34],
    // B.3b east seam repair: the previous direct diagonal from 3.45/3.18
    // to 3.95/4.39 MISSED the raised terrain's southeast corner
    // (world x≈6.55,z≈5.84). The uncovered wedge showed background
    // between the cliff face and sea, like a pale triangular seam.
    // Join that corner with a gently outward rounded SAND tip while
    // keeping the accepted surf/water contact point unchanged.
    [3.45, 3.18], [4.03, 3.02], [4.17, 3.50],
    [4.11, 4.05], [3.95, 4.39],
    [2.79, 4.54], [1.51, 4.40],
    [0.22, 4.57], [-1.20, 4.47], [-2.47, 4.48], [-3.70, 4.34],
  ];
  // B.3b: the old sea ended on one straight segment from (3.95,4.38)
  // to (4.42,5.83). After x*1.65 and fixed oblique camera projection,
  // that segment appeared as a conspicuously VERTICAL cut at right.
  // Hand-round BOTH end-caps into shallow coves, with a wider continuous
  // offshore body that naturally curls away from the eastern beachfront.
  // All first seven points coincide with the ACCEPTED sand surf edge.
  const water: ShorePoint[] = [
    [-3.71, 4.34], [-2.48, 4.47], [-1.20, 4.46], [0.22, 4.56],
    [1.51, 4.39], [2.79, 4.53], [3.95, 4.38],
    // Eastern shoal: a curved peninsula of shallow water, not a cut face.
    [4.18, 4.50], [4.42, 4.75], [4.63, 5.02],
    [4.82, 5.42], [4.93, 5.80], [4.86, 6.11],
    [4.61, 6.30], [4.17, 6.43], [3.55, 6.49],
    // Soft miniature sea frontage, visibly widening beyond the surf.
    [2.79, 6.50], [1.61, 6.53], [0.26, 6.58],
    [-1.20, 6.51], [-2.45, 6.42], [-3.45, 6.21],
    // Western shallows similarly turn back into the beach.
    [-4.12, 5.96], [-4.50, 5.65], [-4.60, 5.22],
    [-4.45, 4.74],
  ];

  const originalSand = extrudedContour(sand, 0.48, 0.045, shore.sand, shore.sandSide);
  originalSand.name = "M1.3 beach slab with tapered southeast sand rim";
  gradeEasternSandRim(originalSand);
  coast.add(originalSand);
  const curvedWater = extrudedContour(water, 0.20, 0.045, shore.water, shore.deepWater);
  curvedWater.name = "B.3b widened sea with rounded east and west shoals";
  coast.add(curvedWater);

  // Sand begins under the continuous raised land. Instead of exposing a
  // height-0.065 seam, descend along a SINGLE multi-point dune shoulder.
  // The B09 coast road/clearance C is north of this strip, untouched.
  // Continue the ORIGINAL soft land-to-dune grade through the new
  // eastern terrain-corner join, not just to the old x=3.45 endpoint.
  // The final two sand-tip turns remain clear of the surf/water seam.
  const firstDryEdge = sand.slice(0, 9);
  coast.add(shoreSlope(firstDryEdge, -0.22, 0.13,
    0.602, 0.558, shore.dune, "B09 grass-to-dune shoulder"));
  coast.add(shoreSlope(firstDryEdge, 0.13, 0.45,
    0.558, 0.528, shore.dryBeach, "B09 dune-to-sand gentle shoulder"));

  // Match original sand top (0.525) to M1.3 water top (0.245) with a
  // low sloping wet-sand lip instead of a vertical cliff. The surf/foam
  // remains just offshore, now connected by a subtle shoreline gradient.
  // The last wet-sand cross-section must ALSO descend at the east tip:
  // otherwise its old .529 inner edge would stand proud of the now-thin
  // .265 sand surface, creating another floating tan triangle.
  coast.add(shoreSlope(water.slice(0, 7), -0.15, 0.27,
    0.529, 0.253, shore.wetBeach, "B09 wet-sand-to-water foreshore",
    (x)=>0.529-0.264*THREE.MathUtils.smoothstep(x,2.79,3.95)));

  coast.add(waveRibbon(
    [[-3.18, 4.69], [-2.42, 4.78], [-1.35, 4.72], [-0.23, 4.85],
      [0.81, 4.74], [1.81, 4.72], [2.76, 4.82], [3.52, 4.67],
      [4.00, 4.82], [4.26, 5.10]],
    0.075, 0.259, shore.foam,
  ));
  coast.add(waveRibbon(
    [[-2.78, 5.35], [-1.87, 5.42], [-0.81, 5.36],
      [0.25, 5.49], [1.25, 5.38], [2.15, 5.43],
      [2.92, 5.45], [3.55, 5.57]],
    0.046, 0.258, shore.foamSecondary,
  ));

  // A few handmade shell flecks offer scale without demanding external assets.
  const shellGeometry = new THREE.IcosahedronGeometry(0.055, 0);
  for (const [x, z] of [
    [-2.8, 3.92], [-1.91, 4.02], [-0.74, 3.87],
    [0.48, 4.06], [1.86, 3.96], [3.15, 4.02],
  ] as const) {
    const shell = new THREE.Mesh(shellGeometry, shore.shells);
    shell.position.set(x, 0.56, z);
    shell.scale.set(1.3, 0.55, 0.8);
    shell.castShadow = true;
    coast.add(shell);
  }

  return coast;
}

const trailPaint = {
  sunset: new THREE.MeshStandardMaterial({
    color: "#d4a16a", roughness: 1, metalness: 0, emissive: "#a16c42", emissiveIntensity: 0.08,
  }),
  turquoise: new THREE.MeshStandardMaterial({
    color: "#468f96", roughness: 1, metalness: 0, emissive: "#3c747a", emissiveIntensity: 0.08,
  }),
  light: new THREE.MeshStandardMaterial({ color: "#fff6de", roughness: 1 }),
};

// The travelers are recognizable by silhouette at the default orthographic
// camera distance (sun hat vs short-billed cap), not dependent on tiny faces.
const travellerPaint = {
  face: new THREE.MeshStandardMaterial({ color: "#f1d2a9", roughness: 1, flatShading: true }),
  eyes: new THREE.MeshStandardMaterial({ color: "#4c534b", roughness: 1 }),
  linen: new THREE.MeshStandardMaterial({ color: "#f7ebcf", roughness: 1, flatShading: true }),
  straw: new THREE.MeshStandardMaterial({ color: "#e5c78a", roughness: 1, flatShading: true }),
  rust: new THREE.MeshStandardMaterial({ color: "#ad6643", roughness: 1, flatShading: true }),
  travelBag: new THREE.MeshStandardMaterial({ color: "#806954", roughness: 1, flatShading: true }),
  navy: new THREE.MeshStandardMaterial({ color: "#45636b", roughness: 1, flatShading: true }),
};

type RouteBeacon = readonly [q: number, r: number, offsetX: number, offsetZ: number];

function routeStamp(
  group: THREE.Group,
  [q, r, offsetX, offsetZ]: RouteBeacon,
  material: THREE.Material,
): void {
  // Small elevated trail beacons, rather than flat ground dots. Pavement sits
  // higher than the old dots, and nearby roof/tree silhouettes occluded them.
  // Keeping the visible caps above paving also avoids z-fighting.
  const marker = new THREE.Group();
  marker.position.copy(tileSurfaceAt(q, r));
  marker.position.x += offsetX;
  marker.position.z += offsetZ;

  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.033, 0.048, 0.25, 8),
    trailPaint.light,
  );
  stem.position.y = 0.125;
  marker.add(stem);

  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.177, 0.177, 0.035, 16),
    trailPaint.light,
  );
  rim.position.y = 0.260;
  marker.add(rim);

  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.140, 0.140, 0.043, 16),
    material,
  );
  cap.position.y = 0.282;
  marker.add(cap);

  group.add(marker);
}

type TravellerStyle = "sunhat" | "sailor-cap";

function token(
  q: number, r: number,
  uniform: THREE.Material,
  style: TravellerStyle,
  name: string,
): THREE.Group {
  const peg = new THREE.Group();
  peg.name = name + " (static miniature character / no gameplay)";
  peg.position.copy(tileSurfaceAt(q, r));

  const add = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number, y: number, z: number,
  ): THREE.Mesh => {
    const part = new THREE.Mesh(geometry, material);
    part.position.set(x, y, z);
    part.castShadow = true;
    part.receiveShadow = true;
    peg.add(part);
    return part;
  };

  // Familiar board-game pawn base; the light center ring separates a token
  // from a same-colored route beacon at a glance.
  add(new THREE.CylinderGeometry(0.198, 0.205, 0.052, 14),
    uniform, 0, 0.037, 0);
  add(new THREE.CylinderGeometry(0.162, 0.162, 0.034, 14),
    travellerPaint.linen, 0, 0.079, 0);

  // Tunic, small arms, skin-toned head and a readable scarf collar.
  add(new THREE.CylinderGeometry(0.100, 0.141, 0.280, 10),
    uniform, 0, 0.224, 0);
  for (const x of [-0.138, 0.138]) {
    const arm = add(new THREE.IcosahedronGeometry(0.060, 0),
      uniform, x, 0.264, 0.010);
    arm.scale.set(0.72, 1.27, 0.85);
  }
  add(new THREE.CylinderGeometry(0.112, 0.108, 0.055, 10),
    travellerPaint.linen, 0, 0.371, 0);
  add(new THREE.IcosahedronGeometry(0.136, 1),
    travellerPaint.face, 0, 0.473, 0);

  // A simple face is secondary to the distinct headwear silhouettes.
  for (const x of [-0.049, 0.049]) {
    add(new THREE.IcosahedronGeometry(0.016, 0),
      travellerPaint.eyes, x, 0.485, 0.126);
  }

  if (style === "sunhat") {
    // Amber: wide straw sunhat, rust-red ribbon, visible canvas satchel.
    add(new THREE.CylinderGeometry(0.237, 0.237, 0.036, 14),
      travellerPaint.straw, 0, 0.616, 0);
    add(new THREE.CylinderGeometry(0.134, 0.158, 0.132, 12),
      travellerPaint.straw, 0, 0.687, 0);
    add(new THREE.CylinderGeometry(0.159, 0.160, 0.033, 12),
      travellerPaint.rust, 0, 0.648, 0);
    const satchel = add(new THREE.BoxGeometry(0.146, 0.192, 0.112),
      travellerPaint.travelBag, 0.168, 0.235, 0.080);
    satchel.rotation.z = -0.10;
    const strap = add(new THREE.BoxGeometry(0.022, 0.252, 0.025),
      travellerPaint.linen, 0.045, 0.259, 0.148);
    strap.rotation.z = 0.40;
  } else {
    // Teal: compact navy sailor-style cap, contrasting brim and travel pouch.
    add(new THREE.CylinderGeometry(0.157, 0.135, 0.121, 12),
      travellerPaint.navy, 0, 0.637, 0);
    add(new THREE.BoxGeometry(0.220, 0.032, 0.135),
      travellerPaint.navy, 0, 0.591, 0.116);
    add(new THREE.BoxGeometry(0.112, 0.026, 0.020),
      travellerPaint.linen, 0, 0.653, 0.138);
    add(new THREE.BoxGeometry(0.085, 0.152, 0.052),
      travellerPaint.linen, 0.016, 0.294, 0.128);
    const pouch = add(new THREE.BoxGeometry(0.140, 0.165, 0.102),
      travellerPaint.travelBag, 0.162, 0.215, 0.081);
    pouch.rotation.z = 0.15;
    const strap = add(new THREE.BoxGeometry(0.022, 0.248, 0.027),
      travellerPaint.linen, 0.055, 0.281, 0.142);
    strap.rotation.z = -0.46;
  }
  return peg;
}

export function createRoutePreview(): THREE.Group {
  const preview = new THREE.Group();
  preview.name = "Two decorative route hints / two static tokens (no gameplay)";

  // Two small, readable trails from town toward the shore. Off-center
  // placements favor open edges of the tiles rather than house/tree footprints.
  // They are decorative wayfinding only; not future gameplay graph edges.
  const amberTrail: readonly RouteBeacon[] = [
    [-2, 0, -0.30, 0.22],
    [-1, 0, -0.37, 0.26],
    [0, 0, -0.34, 0.26],
  ];
  const tealTrail: readonly RouteBeacon[] = [
    // The traveller stands on (0,-1); shift the beacon toward the free edge.
    [0, -1, 0.42, 0.30],
    [0, 0, 0.33, -0.19],
    // Center between the two shrubs on (1,1), not on either shrub.
    [1, 1, -0.02, 0.01],
  ];

  for (const beacon of amberTrail) routeStamp(preview, beacon, trailPaint.sunset);
  for (const beacon of tealTrail) routeStamp(preview, beacon, trailPaint.turquoise);

  // Route endpoints extend into the beach, without locking the board topology.
  for (const [x, z, material] of [
    [-0.85, 3.98, trailPaint.sunset],
    [2.30, 3.98, trailPaint.turquoise],
  ] as const) {
    const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.04, 12), material);
    marker.position.set(x, 0.555, z);
    preview.add(marker);
  }

  // Two miniature travellers, readable as different people even in silhouette.
  // Amber stands on the open front tile, away from the charcoal house's roof.
  preview.add(token(-1, 2, trailPaint.sunset, "sunhat", "Amber traveller"));
  preview.add(token(0, -1, trailPaint.turquoise, "sailor-cap", "Teal traveller"));

  return preview;
}
