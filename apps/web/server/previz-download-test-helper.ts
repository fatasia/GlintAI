import type { Page } from "puppeteer-core";
/** Wait for the browser's completed download, not the UI's "download requested" state. */
export async function preparePrevizDownload(page: Page, directory: string) {
  const client = await page.browser().target().createCDPSession();
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: directory,
    eventsEnabled: true,
  });
  let guid = "";
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Previz download did not complete")), 10000);
    client.on("Browser.downloadWillBegin", (event) => {
      if (event.suggestedFilename.endsWith(".previz.json")) guid = event.guid;
    });
    client.on("Browser.downloadProgress", (event) => {
      if (event.guid !== guid) return;
      if (event.state === "completed") {
        clearTimeout(timer);
        resolve();
      } else if (event.state === "canceled") {
        clearTimeout(timer);
        reject(new Error("Previz download canceled"));
      }
    });
  });
  return { client, done };
}
