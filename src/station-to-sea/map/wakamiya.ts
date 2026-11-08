import * as THREE from "three";
import { createResidentialTree } from "../town";

// B.3a visual layer only: Wakamiya's boulevard remains the accepted
// width-1.08 road. These are outside-road scenic verges, NOT playable
// graph segments, official surveyed geometry, or collision blockers.
type XZ = readonly [x: number, z: number];
const mats = {
  // Deliberately stronger warm-stone / dark planted rhythm than Onari's
  // beige ribbon. These must be legible in BOTH close Explore and Overview.
  walkway: new THREE.MeshStandardMaterial({color:"#a38d73",roughness:1,side:THREE.DoubleSide}),
  curb: new THREE.MeshStandardMaterial({color:"#efe0c2",roughness:1,side:THREE.DoubleSide}),
  leaf: new THREE.MeshStandardMaterial({color:"#75927e",roughness:1,flatShading:true}),
  paver: new THREE.MeshStandardMaterial({color:"#d7c2a2",roughness:1,flatShading:true}),
  planted: new THREE.MeshStandardMaterial({color:"#7f9279",roughness:1,flatShading:true}),
  stone: new THREE.MeshStandardMaterial({color:"#b5aa94",roughness:1,flatShading:true}),
  timber: new THREE.MeshStandardMaterial({color:"#74604e",roughness:1,flatShading:true}),
};
const cube = new THREE.BoxGeometry(1,1,1);
function block(parent:THREE.Group,material:THREE.Material,
  width:number,height:number,depth:number,x:number,y:number,z:number):void {
  const mesh = new THREE.Mesh(cube,material);
  mesh.position.set(x,y,z);
  mesh.scale.set(width,height,depth);
  mesh.castShadow=true;
  mesh.receiveShadow=true;
  parent.add(mesh);
}

function ribbon(nodes:readonly XZ[],side:-1|1,offset:number,
  width:number,y:number,mat:THREE.Material):THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(
    nodes.map(([x,z])=>new THREE.Vector3(x,y,z)),false,"centripetal");
  const sampled=curve.getSpacedPoints(28);
  const halves=sampled.map((point,i)=>{
    const a=sampled[Math.max(0,i-1)];
    const b=sampled[Math.min(sampled.length-1,i+1)];
    const dx=b.x-a.x,dz=b.z-a.z,length=Math.hypot(dx,dz)||1;
    // For increasing z, this normal points toward eastern +X.
    const nx=dz/length,nz=-dx/length;
    const x=point.x+nx*side*offset,z=point.z+nz*side*offset;
    return {
      left:[x+nx*width/2,y,z+nz*width/2],
      right:[x-nx*width/2,y,z-nz*width/2],
    };
  });
  const positions:number[]=[];
  for(let i=0;i+1<halves.length;i++){
    const a=halves[i],b=halves[i+1];
    positions.push(...a.left,...b.left,...a.right,...a.right,...b.left,...b.right);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
  geometry.computeVertexNormals();
  const mesh=new THREE.Mesh(geometry,mat);
  mesh.receiveShadow=true;
  return mesh;
}

// Interrupt both sidewalks around Route 311/Geba and at the EXISTING
// B08 Torii. No section crosses the named public road or torii posts.
const sections:readonly (readonly XZ[])[]=[
  [[3.67,-5.43],[3.76,-4.35],[3.72,-2.15],[3.72,-0.66]],
  [[3.70,0.76],[3.66,1.65],[3.69,2.74]],
  [[3.70,4.29],[3.71,5.06]],
];
function boulevard(groundY:number):THREE.Group {
  const group=new THREE.Group();
  group.name="B.3a Wakamiya broad avenue: warm east shopwalk and west low curb";

  sections.forEach((nodes,index)=>{
    for(const side of [-1,1] as const){
      // The north-west side is almost flush with the owner-accepted
      // B04 east-court garden rail (x ~3.06). Do NOT install a wide
      // promenade across those private lots. A thin stone lip is enough.
      if(index===0 && side===-1){
        const slim=ribbon(nodes,-1,0.578,0.050,groundY+0.044,mats.curb);
        slim.name="Wakamiya north-west rail-side curb (B04 fence clearance)";
        group.add(slim);
        continue;
      }

      // The public road half-width is 0.54. Promenade inner distance is
      // 0.77 - 0.28/2 = 0.63, leaving its open 0.09 shoulder.
      // The EAST band joins (but rises above) the EXISTING B.2 shopfront
      // apron; it is NOT an extra independent, blank parallel road.
      const walk=ribbon(nodes,side,0.770,0.280,
        groundY+0.044,mats.walkway);
      walk.name=`Wakamiya segment ${index}, side ${side} broad warm shopwalk`;
      group.add(walk);

      // Crisp pale road lip makes the central carriageway visible even
      // at full miniature Overview. No mesh goes across 311 or the torii.
      const edge=ribbon(nodes,side,0.584,0.052,
        groundY+0.047,mats.curb);
      edge.name=`Wakamiya segment ${index}, side ${side} pale low curb`;
      group.add(edge);

      // A planted-colored continuous thread helps make this EASTERN
      // promenade recognizable without multiplying building instances.
      // It sits on the safe outside-of-road portion of the sidewalk.
      const spine=ribbon(nodes,side,0.665,0.050,
        groundY+0.050,mats.planted);
      spine.name=`Wakamiya segment ${index}, side ${side} verge planting band`;
      group.add(spine);
    }
  });
  return group;
}

function storefrontRhythm(groundY:number):THREE.Group {
  const frontage=new THREE.Group();
  frontage.name="B02/B05/B08 shared East shopfront arrival rhythm";
  // Connect the ACCEPTED tea/coffee/craft doorways to the new promenade
  // visually. All pads are low, outside Wakamiya's road x <= ~4.26.
  // Never add another house or a sign claiming a real business.
  for(const z of [-4.94,-3.33,-1.71,2.38]){
    block(frontage,mats.paver,0.36,0.026,0.34,
      4.52,groundY+0.054,z);
    block(frontage,mats.timber,0.060,0.018,0.34,
      4.36,groundY+0.072,z);
  }
  // Just TWO original-quality, deliberately smaller M1 tree silhouettes
  // establish shop-gap rhythm, rather than more tiny featureless shrub
  // stamps. The shop gaps have ~0.60m scenic width; ~0.22-radius crowns
  // sit between roofs and doorways, away from the B04 west-side fence.
  for(const [z,variant,scale] of [
    [-4.12,0,0.65],[-2.51,1,0.67],
  ] as const){
    block(frontage,mats.stone,0.29,0.08,0.29,
      4.82,groundY+0.041,z);
    const tree=createResidentialTree(variant);
    tree.name="B.3a reused original low-poly Wakamiya street tree";
    tree.position.set(4.82,groundY+0.082,z);
    tree.scale.setScalar(scale);
    frontage.add(tree);
  }
  return frontage;
}

function crossingAndTorii(groundY:number):THREE.Group {
  const group=new THREE.Group();
  group.name="Wakamiya / 311 four pause corners and open torii approach";

  // Four substantial, symmetrical but low LANDSCAPE corners anchor the
  // Route 311 cross-axis even at Overview. Nothing crosses the 311 road:
  // nearest corners stop at z ±~0.61 outside its visual shoulder.
  for(const [x,z] of [
    [2.87,-0.86],[4.55,-0.86],
    [2.87,0.91],[4.55,0.91],
  ] as const){
    block(group,mats.stone,0.46,0.045,0.45,
      x,groundY+0.031,z);
    block(group,mats.paver,0.33,0.019,0.30,
      x,groundY+0.063,z);
    // Do not place obstructing shrub columns at B04-side corners.
    block(group,mats.planted,0.33,0.026,0.090,
      x,groundY+0.078,z+(z<0 ? -0.16 : 0.16));
  }

  // Torii original posts stay near x=3.01/4.39,z=3.53. Existing pair
  // of compact garden lanterns remains OUTSIDE them at x=2.72/4.69.
  // The veranda ribbons above STOP at 2.74 and resume after 4.29,
  // framing rather than painting across the Ichi-no-Torii opening.
  for(const x of [2.72,4.69]){
    block(group,mats.stone,0.32,0.070,0.42,
      x,groundY+0.040,3.54);
    block(group,mats.leaf,0.24,0.14,0.29,
      x,groundY+0.149,3.54);
    block(group,mats.timber,0.055,0.34,0.055,
      x,groundY+0.27,3.54);
    block(group,mats.paver,0.16,0.050,0.16,
      x,groundY+0.46,3.54);
  }
  return group;
}

type ShopKind = "tea" | "coffee" | "craft";

// All original storefronts point their LOCAL +Z front at world -X
// (the broad east-side Wakamiya road). The fixed Explore camera looks
// from world +X/+Z instead, exposing each LOCAL -Z rear and LOCAL +X
// side. Add true *attached, rotated* shop details to those two walls,
// while preserving the existing original front door / noren / main sign.
const facade = {
  timber: new THREE.MeshStandardMaterial({color:"#745b49",roughness:1,flatShading:true}),
  glass: new THREE.MeshStandardMaterial({color:"#93b7b2",roughness:1,flatShading:true}),
  paper: new THREE.MeshStandardMaterial({color:"#f0e6d0",roughness:1,flatShading:true}),
  roof: new THREE.MeshStandardMaterial({color:"#596f6c",roughness:1,flatShading:true}),
  clay: new THREE.MeshStandardMaterial({color:"#a17d6c",roughness:1,flatShading:true}),
};
function shopKind(name:string):ShopKind|null {
  if(name.includes("Tea house")) return "tea";
  if(name.includes("Kissaten cafe")) return "coffee";
  if(name.includes("Zakka craft shop")) return "craft";
  return null;
}
function shopSideSign(kind:ShopKind):THREE.Mesh {
  // A tiny generic category blade sign, not a claim about a real Kamakura
  // business. Visible along local +X where the Explore camera actually is.
  const category = {
    tea:["茶屋","#53786d"],
    coffee:["喫茶","#85634f"],
    craft:["雑貨","#586980"],
  } as const;
  const [label,color]=category[kind];
  const canvas=document.createElement("canvas");
  canvas.width=256;
  canvas.height=168;
  const ctx=canvas.getContext("2d");
  if(!ctx) throw new Error("Wakamiya flank sign needs Canvas 2D context");
  ctx.fillStyle="#f8efdd";
  ctx.fillRect(0,0,256,168);
  ctx.strokeStyle=color;
  ctx.lineWidth=8;
  ctx.strokeRect(7,7,242,154);
  ctx.textAlign="center";
  ctx.textBaseline="middle";
  ctx.fillStyle=color;
  ctx.font='bold 77px "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';
  ctx.fillText(label,128,86);
  const texture=new THREE.CanvasTexture(canvas);
  texture.colorSpace=THREE.SRGBColorSpace;
  const sign=new THREE.Mesh(
    new THREE.PlaneGeometry(0.31,0.22),
    new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide}),
  );
  // Plane normal +Z is turned to +X, towards the diagonal fixed camera.
  sign.rotation.y=Math.PI/2;
  sign.position.set(0.781,0.814,0.17);
  sign.name="B.3a camera-facing generic Wakamiya side shop sign";
  return sign;
}
function attachVisibleShopFacades(shop:THREE.Group,kind:ShopKind):void {
  // The original detailed prefab wall spans x +/-0.56, z +/-0.425.
  // Everything here is small *surface trim*, not a new building volume.
  const decor=new THREE.Group();
  decor.name="B.3a Wakamiya visible flank/rear commercial facade";
  const awning=kind==="coffee"?facade.clay:facade.roof;

  // CAMERA-VISIBLE +X SIDE: two framed glazed machiya panels and an
  // extended timber eave give the gable a proper retail edge.
  for(const z of [-0.22,0.19]){
    block(decor,facade.timber,0.040,0.38,0.305,
      0.581,0.49,z);
    block(decor,facade.glass,0.022,0.294,0.233,
      0.608,0.49,z);
    block(decor,facade.paper,0.030,0.025,0.260,
      0.625,0.49,z);
    block(decor,facade.timber,0.028,0.322,0.023,
      0.630,0.49,z);
  }
  // Slender lintel below roof does not cover the original gabled roof.
  block(decor,facade.timber,0.080,0.062,0.97,
    0.609,0.727,0);
  block(decor,awning,0.16,0.065,1.10,
    0.677,0.778,0.025);
  block(decor,facade.timber,0.058,0.040,1.14,
    0.761,0.748,0.025);

  // CAMERA-VISIBLE -Z REAR: a credible shop rear wall with shoji panes,
  // not a tall empty plaster slab. Keep roofline, main sign and noren.
  for(const x of [-0.30,0.30]){
    block(decor,facade.timber,0.302,0.344,0.036,
      x,0.492,-0.447);
    block(decor,facade.glass,0.234,0.274,0.020,
      x,0.493,-0.468);
    block(decor,facade.paper,0.024,0.285,0.032,
      x,0.493,-0.488);
    block(decor,facade.paper,0.248,0.024,0.030,
      x,0.493,-0.489);
  }
  block(decor,awning,1.20,0.050,0.145,
    0,0.733,-0.488);
  block(decor,facade.timber,1.20,0.045,0.057,
    0,0.702,-0.53);

  decor.add(shopSideSign(kind));
  shop.add(decor);
}

// Target ONLY the existing east shop archetypes from the two accepted
// source scene groups: B.1 'B05 Wakamiya' plus B.2 'B02', 'B02/B05',
// and 'B08'. Their parent groups already own authentic door/window/noren
// geometry. We do NOT modify B.1 west shops or B04 residences.
export function decorateWakamiyaShopfronts(district:THREE.Group):void {
  for(const object of district.children){
    if(!(object instanceof THREE.Group)) continue;
    if(!/^(?:B02|B05|B08)/.test(object.name)) continue;
    const kind=shopKind(object.name);
    if(!kind) continue;
    // Preserve stable asset locations/yaw/scale. A decorator is added
    // in original SHOP local coordinates, so it follows each original
    // transform and never repositions the actual shop.
    if(object.children.some(child=>child.name==="B.3a Wakamiya visible flank/rear commercial facade"))continue;
    attachVisibleShopFacades(object,kind);
  }
}

export function createWakamiyaAvenueFinish(groundY:number):THREE.Group {
  const result=new THREE.Group();
  result.name="Blockout B.3a visual-only Wakamiya street hierarchy";
  result.add(boulevard(groundY));
  result.add(storefrontRhythm(groundY));
  result.add(crossingAndTorii(groundY));
  return result;
}
