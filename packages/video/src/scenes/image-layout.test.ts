import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { imageSceneLayout, shouldShowImageCaption, showcaseForegroundTransform } from "./image-layout";

const image = parseProject({ schemaVersion: 1, id: "showcase", title: "展示", aspect: "9:16", theme: "mint-clean", knowledgeSources: [], scenes: [{ id: "photo", kind: "image", src: "assets/photo.png", caption: "产品", narration: { text: "介绍", durationMs: 2000 } }] }).scenes[0]!;
if (image.kind !== "image") throw new Error("fixture");

it("preserves old image projects and only enables a backdrop explicitly", () => {
  expect(image.presentation).toBeUndefined();
  expect(imageSceneLayout(image, 1080, 1920).background).toBeUndefined();
  const showcase = { ...image, presentation: "showcase" as const };
  expect(imageSceneLayout(showcase, 1080, 1920).background).toBeDefined();
  expect(parseProject({ schemaVersion: 1, id: "demo", title: "展示", aspect: "1:1", theme: "mint-clean", knowledgeSources: [], scenes: [showcase] }).scenes[0]).toMatchObject({ presentation: "showcase", caption: "产品" });
});

it("only animates the optional showcase foreground on an editable push camera", () => {
  const still = { ...image, presentation: "showcase" as const };
  const moving = { ...still, camera: { type: "push" as const, intensity: 0.4 } };
  expect(showcaseForegroundTransform(still, 10, 60)).toBe("none");
  expect(showcaseForegroundTransform(moving, 0, 60)).not.toBe(showcaseForegroundTransform(moving, 59, 60));
  expect(showcaseForegroundTransform(moving, 100, 60)).toBe(showcaseForegroundTransform(moving, 59, 60));
  expect(showcaseForegroundTransform({ ...image, camera: moving.camera }, 20, 60)).toBe("none");
});

it("animates pull and lateral movement with smooth bounded and seekable endpoints", () => {
  const product = { ...image, presentation: "showcase" as const };
  for (const type of ["pull", "pan-left", "pan-right"] as const) {
    const scene = { ...product, camera: { type, intensity: 0.8 } };
    const at = (frame: number) => showcaseForegroundTransform(scene, frame, 61);
    expect(at(0)).not.toBe(at(60));
    expect(at(-1)).toBe(at(0)); expect(at(61)).toBe(at(60));
    expect(at(30)).toBe(at(30));
    expect(showcaseForegroundTransform({ ...scene, camera: { type, intensity: 0 } }, 0, 61)).toBe(showcaseForegroundTransform({ ...scene, camera: { type, intensity: 0 } }, 60, 61));
  }
  expect(showcaseForegroundTransform({ ...product, camera: { type: "pan-left", intensity: 1 } }, 0, 61)).toBe(showcaseForegroundTransform({ ...product, camera: { type: "pan-right", intensity: 1 } }, 60, 61));
});

it("hides only duplicate showcase copy, preserving different words and old image scenes", () => {
  const showcase = { ...image, presentation: "showcase" as const, caption: "  产品  ", narration: { ...image.narration, text: "产品", audioOffsetMs: 200 }, transition: { in: "fade" as const } };
  expect(shouldShowImageCaption(showcase)).toBe(false);
  expect(shouldShowImageCaption({ ...showcase, caption: "产品详情" })).toBe(true);
  expect(shouldShowImageCaption({ ...showcase, presentation: undefined })).toBe(true);
  const timed = { ...showcase, narration: { ...showcase.narration, segments: [{ text: "产品", words: [{ text: "产品", startMs: 0, endMs: 400 }] }] } };
  expect(shouldShowImageCaption(timed)).toBe(false);
  expect(shouldShowImageCaption({ ...timed, narration: { ...timed.narration, segments: [{ text: "其他", words: [{ text: "其他", startMs: 0, endMs: 400 }] }] } })).toBe(true);
  expect(shouldShowImageCaption({ ...showcase, caption: "" })).toBe(false);
});

it("fits slides without card borders, padding or cropped content in either aspect",()=>{
 for(const [width,height] of [[1920,1080],[1080,1920]]) {
  const styles=imageSceneLayout({...image,presentation:"slide"},width!,height!);
  expect(styles.frame).toMatchObject({left:0,top:0,width:"100%",height:"80%"});
  expect(styles.image).toMatchObject({objectFit:"contain"});expect(styles.image.border).toBeUndefined();
 }
});
