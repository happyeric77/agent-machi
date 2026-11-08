import * as THREE from "three";

// Blockout A: Scenic Walk's major VISUAL road geometry, not playable paths.
// Relative street relationships are based on Blueprint #15 and do not encode
// actual cadastral boundaries, surveyed locations or transport connections.
export const MAP_GROUND_Y = 0.59;

const tones = {
  grass: new THREE.MeshStandardMaterial({ color: "#aab9a0", roughness: 1, flatShading: true }),
  earth: new THREE.MeshStandardMaterial({ color: "#7b8575", roughness: 1, flatShading: true }),
  road: new THREE.MeshStandardMaterial({ color: "#c7bcaa", roughness: 1, side: THREE.DoubleSide }),
  route311: new THREE.MeshStandardMaterial({ color: "#b8aa93", roughness: 1, side: THREE.DoubleSide }),
  routeEdge: new THREE.MeshStandardMaterial({ color: "#e1d9c6", roughness: 1, side: THREE.DoubleSide }),
  trail: new THREE.MeshStandardMaterial({ color: "#d5cbb8", roughness: 1, side: THREE.DoubleSide }),
  railBed: new THREE.MeshStandardMaterial({ color: "#aaa998", roughness: 1, side: THREE.DoubleSide }),
  rail: new THREE.MeshStandardMaterial({ color: "#677378", roughness: 0.9, side: THREE.DoubleSide }),
  sleeper: new THREE.MeshStandardMaterial({ color: "#695b4f", roughness: 1 }),
  clearance: new THREE.MeshBasicMaterial({
    color: "#f0f5e7", opacity: 0.60, transparent: true, side: THREE.DoubleSide, depthWrite: false,
  }),
};

type Point = readonly [x: number, z: number];
type CrossSection = { a: [number, number, number]; b: [number, number, number] };

function landform(): THREE.Mesh {
  // One unbroken terrain top. The south/front edge is tucked under the
  // original M1.3 beach mesh, scaled horizontally for this larger layout.
  const boundary: readonly Point[] = [
    // Western B01/B03 parcel depth requires a wider miniature west
    // shoulder. The eastern boulevard and southern beach stay unmoved.
    [-7.65, -7.25], [-5.35, -8.10], [-2.30, -8.30],
    [1.06, -8.20], [4.25, -7.96], [6.74, -7.16],
    [6.93, -4.00], [6.86, -0.60], [6.79, 2.85],
    [6.55, 5.84], [5.54, 6.18], [2.38, 6.36],
    [-1.05, 6.42], [-4.12, 6.26], [-6.68, 6.00],
    [-7.88, 2.91], [-7.94, -0.62], [-7.99, -3.88],
    [-7.94, -5.86],
  ];
  const shape = new THREE.Shape();
  for (const [index, [x, z]] of boundary.entries()) {
    if (index === 0) shape.moveTo(x, -z);
    else shape.lineTo(x, -z);
  }
  shape.closePath();
  const startY = 0.04;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: MAP_GROUND_Y - startY, steps: 1, bevelEnabled: false,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, startY, 0);
  const ground = new THREE.Mesh(geometry, [tones.grass, tones.earth]);
  ground.name = "Continuous Kamakura blockout — one raised landscape";
  ground.castShadow = true;
  ground.receiveShadow = true;
  return ground;
}

function spline(points: readonly Point[]): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(
    points.map(([x, z]) => new THREE.Vector3(x, MAP_GROUND_Y, z)),
    false, "centripetal",
  );
}

function ribbon(
  curve: THREE.CatmullRomCurve3,
  width: number,
  elevation: number,
  material: THREE.Material,
  offset = 0,
): THREE.Mesh {
  // Continuous sampled ribbon, identical winding to the accepted #13 spike.
  // The same-material road intersections avoid the earlier transverse seam.
  const points = curve.getSpacedPoints(64);
  const sections: CrossSection[] = points.map((p, index): CrossSection => {
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    const dx = after.x - before.x;
    const dz = after.z - before.z;
    const magnitude = Math.hypot(dx, dz) || 1;
    const nx = -dz / magnitude;
    const nz = dx / magnitude;
    const x = p.x + nx * offset;
    const z = p.z + nz * offset;
    return {
      a: [x + nx * width / 2, elevation, z + nz * width / 2],
      b: [x - nx * width / 2, elevation, z - nz * width / 2],
    };
  });
  const vertices: number[] = [];
  for (let index = 0; index + 1 < sections.length; index += 1) {
    const near = sections[index];
    const far = sections[index + 1];
    vertices.push(
      ...near.a, ...far.a, ...near.b,
      ...near.b, ...far.a, ...far.b,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

function roads(): THREE.Group {
  const all = new THREE.Group();
  all.name = "Road axes: Onari / Wakamiya / Yuigahama 311 / coastal (schematic)";

  const main: readonly { name: string; width: number; nodes: readonly Point[] }[] = [
    { name: "Onari-dori west corridor", width: 0.83, nodes: [
      [-2.27, -5.81], [-2.39, -4.17], [-2.48, -2.48], [-2.31, -0.16],
    ] },
    { name: "Wakamiya-oji eastern boulevard", width: 1.08, nodes: [
      [3.66, -6.09], [3.77, -4.32], [3.72, -2.04],
      [3.72, 0.10], [3.66, 2.44], [3.71, 5.29],
    ] },
    { name: "Yuigahama-dori / Route 311 east–west", width: 0.94, nodes: [
      [-5.20, -0.10], [-3.63, -0.05], [-1.91, 0.05],
      [0.24, 0.06], [2.35, 0.03], [4.66, 0.05], [5.93, 0.11],
    ] },
    { name: "Coastal approach (stylized, no verified crossing)", width: 0.80, nodes: [
      [-5.78, 5.26], [-3.70, 5.33], [-1.12, 5.31],
      [1.54, 5.33], [4.12, 5.35], [5.74, 5.31],
    ] },
  ];
  // All named/main road ribbons have the SAME surface material. Elevation
  // increments of millimeters prevent flicker at their intersections.
  main.forEach(({ name, nodes, width }, index) => {
    const route = spline(nodes);
    const mesh = ribbon(route, width, MAP_GROUND_Y + 0.010 + index * 0.002,
      index === 2 ? tones.route311 : tones.road);
    mesh.name = name;
    all.add(mesh);
    if (index === 2) {
      // Route 311 gets a visible, distinct east–west cross-town hierarchy.
      // The shoulder lines are scenic only, not navigable game geometry.
      for (const side of [-1, 1]) {
        const outline = ribbon(route, 0.055, MAP_GROUND_Y + 0.027,
          tones.routeEdge, side * (width / 2 + 0.053));
        outline.name = "311 roadside edge — visual only";
        all.add(outline);
      }
    }
  });

  const local: readonly { name: string; nodes: readonly Point[] }[] = [
    { name: "Central scenic walking lane — STYLIZED", nodes: [
      // A subtle S-bend reveals the two B04 residential court entrances.
      // The route stays connected to Route 311 and the southern lanes.
      [-0.12, -4.86], [0.18, -3.94], [0.10, -3.20],
      [-0.08, -2.38], [0.19, -1.56], [0.12, 0.16],
      [0.28, 1.64], [0.15, 3.03], [0.17, 4.90],
    ] },
    { name: "West-to-central residential meander — STYLIZED", nodes: [
      [-4.17, 2.07], [-3.26, 1.83], [-1.96, 2.27],
      [-0.72, 2.67], [0.47, 2.94], [2.31, 3.11],
    ] },
    { name: "Station-west local passage — STYLIZED", nodes: [
      [-2.30, -4.68], [-1.41, -4.33], [-0.48, -4.61],
    ] },
  ];
  local.forEach(({ name, nodes }, index) => {
    const mesh = ribbon(spline(nodes), 0.51, MAP_GROUND_Y + 0.020 + index * 0.002, tones.trail);
    mesh.name = name;
    all.add(mesh);
  });

  return all;
}

function enodenStudy(): THREE.Group {
  const rail = new THREE.Group();
  rail.name = "Enoden-inspired western rail, not surveyed actual track";
  const course = spline([
    // Move the stylized Enoden outside the NEW planted back lane,
    // rather than crowding shop walls. This is NOT surveyed rail data.
    [-1.10, -7.04], [-3.32, -7.37], [-5.82, -7.18],
    [-6.85, -5.70], [-7.00, -4.50], [-7.05, -3.45],
    [-7.15, -1.62], [-7.23, 0.61], [-7.20, 2.57], [-6.83, 3.75],
  ]);
  rail.add(ribbon(course, 0.79, MAP_GROUND_Y + 0.014, tones.railBed));
  const sleeperGeometry = new THREE.BoxGeometry(0.76, 0.045, 0.12);
  for (let i = 0; i <= 35; i += 1) {
    const t = i / 35;
    const p = course.getPoint(t);
    const tangent = course.getTangent(t);
    const sleeper = new THREE.Mesh(sleeperGeometry, tones.sleeper);
    sleeper.position.set(p.x, MAP_GROUND_Y + 0.045, p.z);
    sleeper.rotation.y = Math.atan2(tangent.x, tangent.z);
    sleeper.castShadow = true;
    sleeper.receiveShadow = true;
    rail.add(sleeper);
  }
  for (const side of [-1, 1]) {
    rail.add(ribbon(course, 0.058, MAP_GROUND_Y + 0.078, tones.rail, side * 0.248));
  }
  return rail;
}

function clearanceRing(x: number, z: number, label: string): THREE.Group {
  const group = new THREE.Group();
  group.name = `Pawn clearance ${label} — visual only, not a graph node`;
  const groundRing = new THREE.Mesh(
    new THREE.RingGeometry(0.58, 0.62, 32),
    tones.clearance,
  );
  groundRing.rotation.x = -Math.PI / 2;
  groundRing.position.set(x, MAP_GROUND_Y + 0.045, z);
  groundRing.renderOrder = 3;
  group.add(groundRing);
  return group;
}

export function createMapBlockout(): THREE.Group {
  const blockout = new THREE.Group();
  blockout.name = "Full Kamakura Scenic Walk / Blockout A";
  blockout.add(landform());
  blockout.add(roads());
  blockout.add(enodenStudy());

  // These clearances must NOT become hard-coded gameplay movement nodes.
  blockout.add(clearanceRing(-0.05, -5.13, "A station plaza"));
  blockout.add(clearanceRing(0.72, 1.65, "B central turn"));
  blockout.add(clearanceRing(-0.12, 4.55, "C coast approach"));
  return blockout;
}

export function createZoneOverlay(): THREE.Group {
  const zones = new THREE.Group();
  zones.name = "Visual production zoning ST / B01–B09 — not gameplay nodes";
  // ST is station/plaza, NOT 'B00'. The 9 production blocks are only B01
  // through B09: west/center/east for the middle & southern bands, plus the
  // two northern shopping blocks and the shared southern coastal entrance.
  const cells = [
    { id: "ST", box: [-1.05, 2.90, -7.30, -4.64] },
    { id: "B01", box: [-6.55, -1.05, -5.78, -3.70] },
    { id: "B02", box: [2.90, 6.55, -5.78, -3.70] },
    { id: "B03", box: [-6.55, -1.05, -3.70, -0.15] },
    { id: "B04", box: [-1.05, 2.90, -3.70, -0.15] },
    { id: "B05", box: [2.90, 6.55, -3.70, -0.15] },
    { id: "B06", box: [-6.55, -1.05, 0.30, 4.86] },
    { id: "B07", box: [-1.05, 2.90, 0.30, 4.86] },
    { id: "B08", box: [2.90, 6.55, 0.30, 4.86] },
    { id: "B09", box: [-4.20, 4.20, 4.95, 5.86] },
  ] as const;
  const dashed = new THREE.LineDashedMaterial({
    color: "#b98472", dashSize: 0.15, gapSize: 0.10,
    transparent: true, opacity: 0.68, depthWrite: false,
  });
  const labelAnchors: Partial<Record<string, readonly [number, number]>> = {
    ST: [2.00, -5.24],
    B01: [-5.56, -4.26],
    B02: [5.35, -4.25],
    B03: [-2.15, -1.02],
    B04: [2.34, -1.10],
    B05: [5.28, -1.08],
    B06: [-5.28, 3.05],
    B07: [-0.61, 3.27],
    B08: [4.43, 3.62],
    B09: [0.52, 5.59],
  };

  cells.forEach(({ id, box: [x0, x1, z0, z1] }) => {
    const corners = [
      new THREE.Vector3(x0, MAP_GROUND_Y + 0.070, z0),
      new THREE.Vector3(x1, MAP_GROUND_Y + 0.070, z0),
      new THREE.Vector3(x1, MAP_GROUND_Y + 0.070, z1),
      new THREE.Vector3(x0, MAP_GROUND_Y + 0.070, z1),
    ];
    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(corners), dashed,
    );
    line.name = id + " design-only block boundary";
    line.computeLineDistances();
    zones.add(line);

    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Missing 2D context for zone debug label");
    ctx.fillStyle = "#fff9e9";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#ae8872";
    ctx.lineWidth = 7;
    ctx.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
    ctx.fillStyle = "#53665c";
    ctx.font = "bold 56px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(id, 128, 50);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Debug-only labels need to be readable in the camera even when houses
    // occupy a zone's geometric center. Anchor off-center on open frontage;
    // billboard text is depth-independent so roofs cannot hide B04/B07.
    const [labelX, labelZ] = labelAnchors[id] ?? [
      (x0 + x1) / 2, (z0 + z1) / 2,
    ];
    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture, transparent: true, depthTest: false,
        depthWrite: false, sizeAttenuation: true,
      }),
    );
    label.name = id + " readable zoning overlay (not game marker)";
    label.position.set(labelX, MAP_GROUND_Y + 0.23, labelZ);
    label.scale.set(0.85, 0.32, 1);
    label.renderOrder = 20;
    zones.add(label);
  });
  zones.visible = false;
  return zones;
}
