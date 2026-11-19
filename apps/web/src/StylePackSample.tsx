import { useMemo } from "react";
import type { ThemeName } from "@glintai/design-tokens";
import { parseProject } from "@glintai/scenescript";
import ProjectPreview from "./ProjectPreview";

/** A fixed, silent SceneScript sample rendered by the same Player as the editor. */
export default function StylePackSample({ theme }: { theme: ThemeName }) {
  const project = useMemo(() => parseProject({
    schemaVersion: 1, id: "style-sample", title: "风格样片", aspect: "16:9", fps: 30,
    knowledgeSources: [], theme,
    scenes: [{ id: "sample", kind: "title", title: "让复杂事情，变得清楚。", subtitle: "STYLE SAMPLE · 01", narration: { text: "风格样片", durationMs: 3000 } }],
  }), [theme]);
  return <ProjectPreview key={theme} project={project} initialFrame={20} />;
}
