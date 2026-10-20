import * as THREE from "three";
import type { ThreeScene as ThreeSceneType } from "@glintai/scenescript";
import { ThreeCanvas } from "@remotion/three";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { FadeIn } from "../components/FadeIn";
import { GltfModel } from "./GltfModel";
import { fittedCameraDistance } from "./gltf";

export interface SceneColors {
  accent: string;
  accent2: string;
  text: string;
}

const geometryFor = (model: ThreeSceneType["model"]): React.ReactNode => {
  switch (model) {
    case "torus-knot":
      return <torusKnotGeometry args={[1.02, 0.32, 256, 40]} />;
    case "icosahedron":
      return <icosahedronGeometry args={[1.5, 0]} />;
    case "sphere":
      return <sphereGeometry args={[1.5, 96, 96]} />;
  }
};

/**
 * 3D scene driven by @remotion/three. Rotation is a pure function of the
 * frame number. Pixel repeatability is checked by the render regression fixture.
 */
export const ThreeSceneView: React.FC<{
  scene: ThreeSceneType;
  colors: SceneColors;
}> = ({ scene, colors }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;

  return (
    <AbsoluteFill>
      <ThreeCanvas
        width={width}
        height={height}
        style={{ position: "absolute", inset: 0 }}
        camera={{ position: [0, 0, scene.model === "gltf" ? fittedCameraDistance(width / height) : 5.6], fov: 40 }}
        // Keep the last manual draw available to still capture between paints.
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
      >
        <ambientLight intensity={0.35} />
        <directionalLight position={[4, 6, 6]} intensity={1.7} color={colors.text} />
        <directionalLight position={[-6, -2, -4]} intensity={2.4} color={colors.accent2} />
        <directionalLight position={[2, -5, 3]} intensity={0.8} color={colors.accent} />
        {scene.model === "gltf" ? (
          <GltfModel key={scene.src} src={scene.src} frame={frame} fps={fps} />
        ) : <group rotation={[t * 0.32, t * 0.52, 0]}>
          <mesh>
            {geometryFor(scene.model)}
            <meshStandardMaterial
              color={colors.accent}
              metalness={0.82}
              roughness={0.18}
              emissive={new THREE.Color(colors.accent2)}
              emissiveIntensity={0.08}
              flatShading={scene.model === "icosahedron"}
            />
          </mesh>
        </group>}
      </ThreeCanvas>
      {scene.caption ? (
        <FadeIn
          delay={10}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 300,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              fontFamily: "var(--glint-font-mono)",
              fontSize: 26,
              letterSpacing: "0.1em",
              color: "var(--glint-color-text-muted)",
              background:
                "color-mix(in srgb, var(--glint-color-surface) 72%, transparent)",
              border:
                "1px solid color-mix(in srgb, var(--glint-color-text) 12%, transparent)",
              borderRadius: 999,
              padding: "12px 30px",
            }}
          >
            {scene.caption}
          </span>
        </FadeIn>
      ) : null}
    </AbsoluteFill>
  );
};
