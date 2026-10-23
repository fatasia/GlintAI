import { Composition, type AnyZodObject } from "remotion";
import { buildTimeline, nleDurationMs, parseNleProject, parseProject } from "@glintai/scenescript";
import { GlintVideo, NleComposition, SAMPLE_PROJECT, sizeByAspect, type GlintProps } from "@glintai/video";
import { SeekVerification, type SeekProps } from "./SeekVerification";

const DEFAULT_PROPS: GlintProps = { project: SAMPLE_PROJECT };
const SAMPLE_NLE = parseNleProject({
  schemaVersion: 1, id: "nle-sample", title: "NLE", fps: 30, width: 1920, height: 1080,
  tracks: [{ id: "v1", kind: "overlay", name: "文字", clips: [{ id: "title", kind: "text", text: "Glint 剪辑台", startMs: 0, durationMs: 3000, fontSize: 96 }] }],
});

export const Root: React.FC = () => {
  return (
    <>
    <Composition<AnyZodObject, GlintProps>
      id="Glint"
      component={GlintVideo}
      defaultProps={DEFAULT_PROPS}
      calculateMetadata={({ props }) => {
        const project = parseProject(props.project);
        const timeline = buildTimeline(project);
        const fps = project.fps ?? 30;
        return {
          durationInFrames: Math.max(
            1,
            Math.round((timeline.totalMs / 1000) * fps),
          ),
          fps,
          ...sizeByAspect[project.aspect],
        };
      }}
      durationInFrames={300}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition<AnyZodObject, { project: import("@glintai/scenescript").NleProject }>
      id="GlintNle"
      component={NleComposition}
      defaultProps={{ project: SAMPLE_NLE }}
      calculateMetadata={({ props }) => {
        const project = parseNleProject(props.project);
        return { durationInFrames: Math.max(1, Math.round(nleDurationMs(project) / 1000 * project.fps)), fps: project.fps, width: project.width, height: project.height };
      }}
      durationInFrames={90} fps={30} width={1920} height={1080} />
    <Composition<AnyZodObject, SeekProps> id="GlintSeekVerification" component={SeekVerification}
      defaultProps={{ project: SAMPLE_PROJECT, frameMap: [0] }}
      calculateMetadata={({props})=>({durationInFrames:Math.max(1,props.frameMap.length),fps:parseProject(props.project).fps ?? 30,...sizeByAspect[parseProject(props.project).aspect]})}
      durationInFrames={1} fps={30} width={1920} height={1080}/>
    </>
  );
};
