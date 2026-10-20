import type { Scene } from "@glintai/scenescript";
import { BulletsSceneView } from "./BulletsScene";
import { CodeSceneView } from "./CodeScene";
import { ComparisonSceneView } from "./ComparisonScene";
import { DefinitionSceneView } from "./DefinitionScene";
import { DiagramSceneView } from "./DiagramScene";
import { HtmlSceneView } from "./HtmlScene";
import { ImageSceneView } from "./ImageScene";
import { QuoteSceneView } from "./QuoteScene";
import type { SceneColors } from "./ThreeScene";
import { DeferredThree } from "./DeferredThree";
import { TitleSceneView } from "./TitleScene";
import { ChartSceneView } from "./ChartScene";

export const SceneRouter: React.FC<{
  scene: Scene;
  colors: SceneColors;
}> = ({ scene, colors }) => {
  switch (scene.kind) {
    case "chart": return <ChartSceneView scene={scene} />;
    case "title":
      return <TitleSceneView scene={scene} />;
    case "bullets":
      return <BulletsSceneView scene={scene} />;
    case "definition":
      return <DefinitionSceneView scene={scene} />;
    case "quote":
      return <QuoteSceneView scene={scene} />;
    case "comparison":
      return <ComparisonSceneView scene={scene} />;
    case "code":
      return <CodeSceneView scene={scene} />;
    case "three":
      return <DeferredThree scene={scene} colors={colors} />;
    case "image":
      return <ImageSceneView scene={scene} />;
    case "diagram":
      return <DiagramSceneView scene={scene} />;
    case "html":
      return <HtmlSceneView scene={scene} />;
  }
};
