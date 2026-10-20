/** Browser-enforced egress restrictions; executable scenes remain trusted local code. */
export function htmlPolicy(runtimeSources: string[] = []): string {
  const sources = runtimeSources.map((source) => {
    const url = new URL(
      source,
      typeof location === "undefined" ? "http://localhost/" : location.href,
    );
    if (!["http:", "https:"].includes(url.protocol) || /[;'"\s]/.test(url.href))
      throw new Error("Invalid runtime URL");
    return url.href;
  });
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${sources.join(" ")}`.trim(),
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
export function policyMeta(sources: string[] = []): string {
  return `<meta http-equiv="Content-Security-Policy" content="${htmlPolicy(sources).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
}
export function staticHtmlDocument(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8">${policyMeta()}<style>html,body{margin:0;height:100%}</style></head><body>${html}</body></html>`;
}

/** Dedicated trusted wrapper: its frame policy blocks child navigation without changing the host's CSP. */
export function isolatedHtmlFrame(
  child: string,
  generation: string,
  animated: boolean,
  runtimeSource?: string,
): string {
  const escape = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const policy = htmlPolicy(runtimeSource ? [runtimeSource] : []).replace(
    "frame-src 'none'",
    "frame-src 'self'",
  );
  const relay = `(function(){var GENERATION = ${JSON.stringify(generation).replace(/</g, "\\u003c")};window.addEventListener('message',function(event){var data=event.data,frame=document.getElementById('glint-document');if(!frame||!data||data.generation!==GENERATION)return;if(event.source===parent&&data.type==='glint:seek'){frame.contentWindow.postMessage(data,'*')}else if(event.source===frame.contentWindow&&['glint:ready','glint:seeked','glint:seek-error'].includes(data.type)){requestAnimationFrame(function(){requestAnimationFrame(function(){parent.postMessage(data,'*')})})}})})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escape(policy)}"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style><script>${relay}</script></head><body><iframe id="glint-document" sandbox="${animated ? "allow-scripts" : ""}" srcdoc="${escape(child)}"></iframe></body></html>`;
}
