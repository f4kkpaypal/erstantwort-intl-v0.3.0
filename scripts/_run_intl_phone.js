const fs=require("fs");
const path=require("path");
const root=path.join(__dirname,"..");
for (const line of fs.readFileSync(path.join(root,".env"),"utf8").split(/\n/)) {
  const t=line.trim(); if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i=t.indexOf("="); const k=t.slice(0,i).trim(); const v=t.slice(i+1).trim();
  if (!process.env[k]) process.env[k]=v;
}
process.env.PRODUCT_MODE="intl";
process.env.HOST=process.env.HOST||"127.0.0.1";
process.env.INTL_PORT=process.env.INTL_PORT||"8791";
process.chdir(root);
require("../engine/intlServer").startIntl().then(({config})=>{
  console.log("started channel="+config.CHANNEL_MODE+" demo_ui="+config.DEMO_UI_NO_AUTH);
}).catch(err=>{ console.error(err); process.exit(1); });
