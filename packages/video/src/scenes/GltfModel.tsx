import { useLayoutEffect, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GltfAssetPath } from "@glintai/scenescript";
import { cancelRender, continueRender, delayRender, staticFile } from "remotion";
import {
  attachGltfDecoders, createGltfMixer, disposeGltf, fitGltf, loadLocalGltf, seekGltfAnimation,
} from "./gltf";

export const GltfModel: React.FC<{ src: string; frame: number; fps: number }> = ({ src, frame, fps }) => {
  // KTX2Loader.detectSupport inspects the renderer's compressed-texture support.
  const gl = useThree((state) => state.gl);
  const rootScene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const [loaded, setLoaded] = useState<{
    src: string; gltf: GLTF; mixer: ReturnType<typeof createGltfMixer>; fit: ReturnType<typeof fitGltf>;
  } | null>(null);
  const pending = useRef<{ handle: number; failed: boolean } | null>(null);

  useLayoutEffect(() => {
    const handle = delayRender(`Loading local glTF: ${src}`, { timeoutInMilliseconds: 30_000 });
    const gate = { handle, failed: false };
    pending.current = gate;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      gate.failed = true;
      cancelRender(new Error(`glTF load timed out after 30s: ${src}`));
    }, 30_000);
    let active = true;
    let dispose: (() => void) | undefined;
    void (async () => {
      try {
        GltfAssetPath.parse(src);
        // Decoder init runs inside this delayRender window and only for models
        // whose document actually requires DRACO/KTX2.
        const gltf = await loadLocalGltf(staticFile(src), controller.signal, {
          setupDecoders: (loader, needs) => attachGltfDecoders(loader, needs, gl, undefined, staticFile),
        });
        if (!active || gate.failed) { disposeGltf(gltf); return; }
        const mixer = createGltfMixer(gltf);
        dispose = () => { mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene); disposeGltf(gltf); };
        const fit = fitGltf(gltf.scene);
        setLoaded({ src, gltf, mixer, fit });
      } catch (error) {
        dispose?.();
        dispose = undefined;
        if (active && !gate.failed) {
          gate.failed = true;
          cancelRender(new Error(`Cannot load model ${src}: ${error instanceof Error ? error.message : String(error)}`));
        }
      } finally { clearTimeout(timer); }
    })();
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
      dispose?.();
      if (pending.current === gate) {
        pending.current = null;
        if (!gate.failed) continueRender(handle);
      }
    };
  }, [src, gl]);

  useLayoutEffect(() => {
    if (!loaded || loaded.src !== src) return;
    const gate = pending.current;
    try {
      seekGltfAnimation(loaded.mixer, frame, fps);
      if (gate !== null && !gate.failed) {
        // ThreeCanvas uses frameloop="never" during export. Its frame effect
        // has already drawn the empty scene before this async model commits;
        // loading state alone does not schedule another draw at the same frame.
        gl.render(rootScene, camera);
        gl.getContext().finish();
        continueRender(gate.handle);
        pending.current = null;
      }
    } catch (error) {
      if (gate) gate.failed = true;
      cancelRender(new Error(`Cannot draw model ${src}: ${String(error)}`));
    }
  }, [loaded, frame, fps, gl, rootScene, camera, src]);

  return loaded?.src === src ? (
    <group scale={loaded.fit.scale} position={loaded.fit.position} dispose={null}>
      <primitive object={loaded.gltf.scene} dispose={null} />
    </group>
  ) : null;
};
