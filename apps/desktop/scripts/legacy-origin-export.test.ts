import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host";
import { discoverLegacyPorts, exportLegacyOrigins, recoveryKey } from "./legacy-origin-export.mjs";
const puppeteer = createRequire(new URL("../../studio/package.json", import.meta.url))("puppeteer-core");
it("limits backups to authoring data and valid loopback metadata", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"glint-origin-unit-"));
  try {
    fs.writeFileSync(path.join(root,"0001.log"),"http://127.0.0.1:32844 http://127.0.0.1:80 http://127.0.0.1:99999 https://evil:9999");
    expect(discoverLegacyPorts(root)).toEqual([32844]);
    expect(recoveryKey("glint.projects")).toBe(true);
    expect(recoveryKey("glint.project-designs.v1:project-a")).toBe(true);
    expect(recoveryKey("glint:provider-api-key")).toBe(false);
    expect(recoveryKey("password")).toBe(false);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
it("exports distinct historical origins through a copied Chromium profile without modifying source or copying credentials", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"glint-origin-recovery-test-"));
  const profile=path.join(root,"profile"),out=path.join(root,"backup"),executablePath=findSystemBrowser();
  const servers: http.Server[]=[];let browser:any;
  try {
    const ports:number[]=[];
    for(let i=0;i<2;i++) {
      const server=http.createServer((_req,res)=>res.end("<!doctype html><title>Legacy fixture</title>"));servers.push(server);
      await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); ports.push((server.address() as {port:number}).port);
    }
    browser=await puppeteer.launch({executablePath,headless:true,userDataDir:profile});const page=await browser.newPage();
    for(const port of ports) {
      await page.goto(`http://127.0.0.1:${port}`);
      await page.evaluate((p:number)=>{localStorage.setItem("glint.workspace",JSON.stringify({title:`origin-${p}`}));localStorage.setItem("glint:provider-api-key","excluded-test-value");},port);
    }
    await browser.close();browser=undefined;
    for(const server of servers) {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
    const directory=path.join(profile,"Default/Local Storage/leveldb");
    const hashes=()=>Object.fromEntries(fs.readdirSync(directory).map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(directory,name))).digest('hex')]));
    const before=hashes();
    const result=await exportLegacyOrigins({profileDir:profile,outputDir:out,executablePath,ports});
    expect(result).toEqual(ports.map(port=>({port,keys:1,skipped:1})));
    expect(hashes()).toEqual(before);
    for(const port of ports) {
      const snapshot=JSON.parse(fs.readFileSync(path.join(out,`origin-${port}.json`),'utf8'));
      expect(snapshot.values).toEqual({"glint.workspace":JSON.stringify({title:`origin-${port}`})});
    }
    await expect(exportLegacyOrigins({profileDir:profile,outputDir:out,executablePath,ports})).rejects.toThrow("never overwritten");
    await expect(exportLegacyOrigins({profileDir:profile,outputDir:path.join(profile,'..misleading'),executablePath,ports})).rejects.toThrow("outside");
  } finally {
    await browser?.close();for(const server of servers){server.closeAllConnections();server.close();}
    fs.rmSync(root,{recursive:true,force:true});
  }
},60000);
