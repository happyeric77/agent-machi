import * as THREE from "three";
import {
  createResidentialHouse, createResidentialTree, createResidentialShrub,
  type ResidenceVariant,
} from "./town";

// Reuse the original detailed M1.3 houses; no generic replacement cuboids.
// These parcels are visual relationships, not surveyed building coordinates.
const stone = new THREE.MeshStandardMaterial({color:"#b9b09c",roughness:1,flatShading:true});
const timber = new THREE.MeshStandardMaterial({color:"#92765b",roughness:1,flatShading:true});
const path = new THREE.MeshStandardMaterial({color:"#d2c9b7",roughness:1,flatShading:true});
const cube = new THREE.BoxGeometry(1,1,1);
function lowDetail(group: THREE.Group, m: THREE.Material, w:number,h:number,d:number,
 x:number,y:number,z:number):void {
  const part = new THREE.Mesh(cube,m);
  part.scale.set(w,h,d);part.position.set(x,y,z);
  part.castShadow=true;part.receiveShadow=true;group.add(part);
}
type Lot={zone:string;style:ResidenceVariant;x:number;z:number;yaw:number;scale:number};

// ST remains station/plaza (the old illustrated B00). Avoid A/B/C pawn pads,
// both named road ribbons, the Enoden ballast and the beach's clear entrance.
const homeLots:readonly Lot[]=[
  {zone:"B01 rear Onari",style:3,x:-5.26,z:-5.08,yaw:0.23,scale:0.83},
  {zone:"B04 north courtyard",style:1,x:-1.35,z:-3.60,yaw:0.33,scale:0.86},
  {zone:"B04 south setback",style:2,x:2.25,z:-1.25,yaw:0.15,scale:0.81},
  // Angle the original detailed entrance toward the eastern court gate.
  // Avoid the blank rear wall created by the former 2.97 rad rotation.
  {zone:"B04 Onari-side lane",style:1,x:-1.24,z:-1.55,yaw:1.06,scale:0.94},
  {zone:"B06 rail-side home",style:0,x:-4.67,z:0.93,yaw:0.09,scale:0.74},
  {zone:"B06 Onari-side lane",style:2,x:-3.40,z:1.02,yaw:0.16,scale:0.84},
  {zone:"B07 inner west",style:3,x:-1.45,z:1.20,yaw:0.12,scale:0.86},
  {zone:"B07 inner south",style:0,x:-1.45,z:4.02,yaw:-0.08,scale:0.85},
  {zone:"B07 central east",style:0,x:2.17,z:1.39,yaw:-0.10,scale:1.00},
  {zone:"B02 east gate back row",style:2,x:5.56,z:-6.12,yaw:0.06,scale:0.82},
  {zone:"B08 south Wakamiya home",style:3,x:5.38,z:4.08,yaw:-0.12,scale:0.82},
];

// The original four town.ts houses are preserved, including roof/window
// geometry. Added homes form staggered *blocks* with low rear-garden edges.
export function createScenicResidences(groundY:number):THREE.Group {
  const scenery=new THREE.Group();
  scenery.name="Blueprint-aligned B01/B04/B06/B07/B08 residential clusters";

  homeLots.forEach(({zone,style,x,z,yaw,scale},i)=>{
    const plot=new THREE.Group();
    plot.name=zone+" / residential garden and entrance";
    plot.position.set(x,groundY,z);plot.rotation.y=yaw;
    const home=createResidentialHouse(style);
    home.scale.setScalar(scale);plot.add(home);
    if(i%3!==1){
      lowDetail(plot,stone,1.06*scale,0.075,0.055,0,0.04,-0.59*scale);
      for(const side of [-1,1]){
        lowDetail(plot,timber,0.045,0.18,0.05,side*0.49*scale,0.09,-0.59*scale);
      }
    }
    // Decorative entry stones are NOT movement graph nodes.
    for(const zz of [0.49,0.68]){
      lowDetail(plot,path,0.22,0.023,0.16,0.05,0.025,zz*scale);
    }
    scenery.add(plot);
  });

  const trees:readonly [number,number,0|1][]=[
    [-6.05,-6.85,0],[-4.80,3.90,1],[2.50,-3.10,0],
    [-2.20,3.15,1],[4.73,0.98,0],[2.45,2.76,1],
  ];
  for(const [x,z,variant] of trees){
    const tree=createResidentialTree(variant);
    tree.position.set(x,groundY,z);tree.name="B.2 original-style planted tree";
    scenery.add(tree);
  }
  const shrubs:readonly [number,number][]=[
    [-4.20,-1.08],[-3.15,3.63],[-2.55,3.85],[0.88,-3.60],
    [2.60,0.91],[1.15,3.20],[6.15,-5.54],[5.87,1.15],
  ];
  for(const [x,z] of shrubs){
    const bush=createResidentialShrub();
    bush.position.set(x,groundY,z);bush.name="B.2 original-style planted shrub";
    scenery.add(bush);
  }

  // The B07 homes frame a small courtyard on a stylized inner lane.
  // No tall walls, road barriers or blockers on pawn clearance B or C.
  const court=new THREE.Group();
  court.name="B07 stepping-stone residential garden";
  court.position.set(-1.58,groundY,2.72);
  lowDetail(court,path,1.02,0.025,0.64,0,0.015,0);
  lowDetail(court,stone,1.07,0.085,0.085,0,0.047,-0.36);
  lowDetail(court,stone,0.075,0.085,0.68,-0.56,0.047,0);
  for(const [x,z] of [[-0.29,0.03],[0,-0.02],[0.28,0.04]] as const){
    lowDetail(court,stone,0.18,0.024,0.21,x,0.04,z);
  }
  for(const x of [-0.43,0.43]){
    lowDetail(court,timber,0.047,0.20,0.048,x,0.105,-0.36);
  }
  scenery.add(court);
  return scenery;
}
