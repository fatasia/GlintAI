import type { CameraExport, PrevizDoc } from "./index";
import type { ActorPose } from "./pose";

export type ControlMode = "rgb" | "depth" | "normal" | "skeleton";

const RIG_SNIPPET = `
  d.poses.forEach(pose=>{
    const points=new Map(pose.joints.map(j=>[j.name,new THREE.Vector3(...j.position)]));
    pose.joints.forEach(j=>{
      const point=points.get(j.name), color=d.mode==='skeleton'?[1,1,1]:[0.9,0.45,0.2];
      const ball=new THREE.Mesh(new THREE.SphereGeometry(j.name==='head'?0.09:0.035,12,8),material(color));
      ball.position.copy(point);scene.add(ball);
      if(!j.parent)return;
      const parent=points.get(j.parent),delta=point.clone().sub(parent),length=delta.length();
      if(length<1e-8)return;
      const bone=new THREE.Mesh(new THREE.CylinderGeometry(0.025,0.025,length,8),material(color));
      bone.position.copy(parent).add(point).multiplyScalar(0.5);
      bone.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());scene.add(bone);
    });
  });
`;

/** Only validated numeric geometry is embedded; document titles and scripts are not. */
export function threePreviewHtml(
  doc: PrevizDoc,
  camera: CameraExport,
  near: number,
  far: number,
  mode: ControlMode,
  mannequins = false,
  poses: ActorPose[] = [],
): string {
  const data = JSON.stringify({
    stage: doc.stage,
    props: [...doc.props, ...(mannequins ? standingProxies(doc) : [])].map((p) => ({
      shape: p.shape,
      size: p.size,
      position: p.position,
      yawDeg: p.yawDeg,
    })),
    camera,
    near,
    far,
    mode,
    poses,
  }).replace(/</g, "\\u003c");
  return `<style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style><script>
window.__glintThree=function(THREE){
  const d=${data}, scene=new THREE.Scene();
  scene.background=new THREE.Color(0,0,0);
  const c=new THREE.PerspectiveCamera(d.camera.fovDeg,d.camera.aspect,d.near,d.far);
  c.position.fromArray(d.camera.position); c.up.fromArray(d.camera.up); c.lookAt(...d.camera.target);
  const vertex='varying vec3 vN; varying float vD; void main(){vec4 p=modelViewMatrix*vec4(position,1.0); vN=normalMatrix*normal; vD=-p.z; gl_Position=projectionMatrix*p;}';
  const fragment='uniform vec3 tint; uniform float nearZ; uniform float farZ; varying vec3 vN; varying float vD; void main(){'+
    (d.mode==='normal'?'gl_FragColor=vec4(normalize(vN)*0.5+0.5,1.0);':d.mode==='depth'?'float z=1.0-clamp((vD-nearZ)/(farZ-nearZ),0.0,1.0); gl_FragColor=vec4(vec3(z),1.0);':'gl_FragColor=vec4(tint,1.0);')+'}';
  function material(color){return new THREE.ShaderMaterial({vertexShader:vertex,fragmentShader:fragment,uniforms:{tint:{value:new THREE.Vector3(...color)},nearZ:{value:d.near},farZ:{value:d.far}},side:THREE.DoubleSide});}
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(d.stage.width,d.stage.depth),material([0.23,0.27,0.32]));
  floor.rotation.x=-Math.PI/2; if(d.mode!=="skeleton") scene.add(floor);
  const colors=[[0.9,0.35,0.18],[0.18,0.65,0.85],[0.65,0.8,0.25]];
  (d.mode==="skeleton"?[]:d.props).forEach((p,i)=>{
    const g=p.shape==='box'?new THREE.BoxGeometry(1,1,1):p.shape==='sphere'?new THREE.SphereGeometry(0.5,24,16):new THREE.CylinderGeometry(0.5,0.5,1,24);
    const m=new THREE.Mesh(g,material(colors[i%colors.length]));
    m.scale.fromArray(p.size); m.position.set(p.position[0],p.position[1]+p.size[1]/2,p.position[2]); m.rotation.y=p.yawDeg*Math.PI/180; scene.add(m);
  });
${RIG_SNIPPET}
  return {scene:scene,camera:c,seek:function(){}};
};
</script>`;
}

function standingProxies(doc: PrevizDoc): PrevizDoc["props"] {
  return doc.actors.flatMap((actor) => {
    if (actor.pose !== "stand") throw new Error("Only standing geometric mannequins are supported");
    const [x, y, z] = actor.position,
      h = actor.heightM,
      a = (actor.yawDeg * Math.PI) / 180;
    const part = (
      suffix: string,
      shape: "box" | "sphere" | "cylinder",
      position: [number, number, number],
      size: [number, number, number],
    ) => ({
      id: actor.id + suffix,
      name: "Geometry proxy",
      shape,
      position,
      size,
      yawDeg: actor.yawDeg,
    });
    return [
      part("-body", "cylinder", [x, y, z], [h * 0.28, h * 0.78, h * 0.18]),
      part("-head", "sphere", [x, y + h * 0.78, z], [h * 0.22, h * 0.22, h * 0.22]),
      part(
        "-front",
        "box",
        [x + Math.sin(a) * h * 0.12, y + h * 0.86, z + Math.cos(a) * h * 0.12],
        [h * 0.08, h * 0.05, h * 0.09],
      ),
    ];
  });
}
