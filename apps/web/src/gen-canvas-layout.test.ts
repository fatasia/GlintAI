import {expect,it} from "vitest";
import {readGenerationLayout} from "./gen-canvas-layout";
it("preserves generation node positions",()=>{
 expect(readGenerationLayout(null)).toEqual({});
 expect(readGenerationLayout('{"image-abc-1":{"x":-20,"y":30}}')).toEqual({"image-abc-1":{x:-20,y:30}});
});
it.each(['{','[]','null','{"__proto__":{"x":0,"y":0}}','{"node":{"x":"1","y":2}}','{"node":{"x":100001,"y":0}}','{"node":{"x":0,"y":0,"z":1}}'])('rejects corrupted layout %s',raw=>expect(()=>readGenerationLayout(raw)).toThrow());
