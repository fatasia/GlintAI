/** Exercise the real disclosure rather than force-showing hidden editor DOM. */
export async function openRestoredProject(page: any) {
  await page.waitForSelector('.glint-editor');
  if (await page.$eval('.glint-editor', (editor: Element) => !editor.getClientRects().length))
    await page.locator('.home-resume').click();
  await page.waitForSelector('.glint-editor', {visible:true});
}
export async function openInspector(page: any) {
  await openRestoredProject(page);
  await page.waitForSelector('.glint-editor button[aria-controls="glint-inspector"]');
  if (await page.$eval('.glint-editor button[aria-controls="glint-inspector"]', (button: Element) => button.getAttribute("aria-expanded") !== "true"))
    await page.locator('.glint-editor button[aria-controls="glint-inspector"]').click();
  await page.waitForSelector('#glint-inspector[data-open="true"]', {visible:true});
}
export async function openHomeTool(page: any, tool: "create" | "reference") {
  await page.locator('.home-more > summary').click();
  await page.locator(`.home-more button::-p-text(${tool === "create" ? "更多创作选项" : "从参考片开始"})`).click();
  await page.waitForSelector('#workspace-tools', {visible:true});
}
export async function openWorkspaceMenu(page: any, label: string) {
  await openRestoredProject(page);
  await page.locator('.workspace-more > summary').click();
  await page.locator(`.workspace-more button::-p-text(${label})`).click();
}
