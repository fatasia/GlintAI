import { afterEach,expect,it,vi } from "vitest";
import { createLlmProvider } from "./configuration";
import { wireMessages } from "./message-images";
afterEach(()=>vi.unstubAllGlobals());
const image={mimeType:"image/png" as const,data:"YWJj"};
it.each(["openai","anthropic","responses","gemini"] as const)("encodes an explicit reference image for %s without leaking internal attachment fields",async protocol=>{
 const fetch=vi.fn(async()=>Response.json({choices:[{message:{content:"OK"}}],content:[{type:"text",text:"OK"}],output:[{content:[{type:"output_text",text:"OK"}]}],candidates:[{content:{parts:[{text:"OK"}]}}]}));vi.stubGlobal("fetch",fetch);
 const provider=createLlmProvider({baseUrl:"https://model.test/v1",apiKey:"unit-only",model:"vision",protocol});
 expect((await provider.chat({messages:[{role:"user",content:"Describe layout",images:[image]}]})).text).toBe("OK");
 const body=JSON.parse((fetch.mock.calls[0] as unknown as [string,RequestInit])[1].body as string);
 expect(JSON.stringify(body)).not.toContain('"images"');
 const parts=protocol==="gemini"?body.contents[0].parts:protocol==="responses"?body.input[0].content:body.messages[0].content;
 expect(parts).toHaveLength(2);
 if(protocol==="openai")expect(parts[1]).toEqual({type:"image_url",image_url:{url:"data:image/png;base64,YWJj"}});
 if(protocol==="anthropic")expect(parts[1].source).toEqual({type:"base64",media_type:"image/png",data:"YWJj"});
 if(protocol==="gemini")expect(parts[1].inlineData).toEqual(image);
 if(protocol==="responses")expect(parts[1]).toEqual({type:"input_image",image_url:"data:image/png;base64,YWJj"});
});
it("keeps text-only messages identical and rejects remote, noncanonical or assistant attachments",()=>{
 expect(wireMessages([{role:"user",content:"text"}],"openai")).toEqual([{role:"user",content:"text"}]);
 for(const data of ["https://remote.test/private.png","","YWJj=","YQ=B"])
  expect(()=>wireMessages([{role:"user",content:"text",images:[{...image,data}]}],"openai")).toThrow();
 expect(()=>wireMessages([{role:"assistant",content:"text",images:[image]}],"openai")).toThrow();
});
