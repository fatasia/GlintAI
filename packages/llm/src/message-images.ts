import type { ChatMessage } from "./types";

export function messageParts(message: ChatMessage, protocol: "openai" | "anthropic" | "responses" | "gemini"): unknown[] {
  const images=message.images??[];
  if(images.length>2||images.length&&message.role!=="user")throw new Error("Images require a user message and at most two attachments");
  for(const image of images)if(!["image/png","image/jpeg","image/webp"].includes(image.mimeType)||typeof image.data!=="string"||image.data.length>700000||image.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)||Buffer.from(image.data,"base64").toString("base64")!==image.data||!image.data.length)throw new Error("Invalid inline image attachment");
  if(protocol==="gemini")return[{text:message.content},...images.map(image=>({inlineData:{mimeType:image.mimeType,data:image.data}}))];
  if(protocol==="anthropic")return[{type:"text",text:message.content},...images.map(image=>({type:"image",source:{type:"base64",media_type:image.mimeType,data:image.data}}))];
  if(protocol==="responses")return[{type:message.role==="assistant"?"output_text":"input_text",text:message.content},...images.map(image=>({type:"input_image",image_url:`data:${image.mimeType};base64,${image.data}`}))];
  return[{type:"text",text:message.content},...images.map(image=>({type:"image_url",image_url:{url:`data:${image.mimeType};base64,${image.data}`}}))];
}
export function wireMessages(messages:ChatMessage[],protocol:"openai"|"anthropic"|"responses") {
  return messages.map(message=>message.images?.length?{role:message.role,content:messageParts(message,protocol)}:{role:message.role,content:message.content});
}
