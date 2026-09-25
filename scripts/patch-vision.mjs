import fs from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
const require=createRequire(new URL('../profile/package.json',import.meta.url));
const dir=dirname(require.resolve('@anionex/dsh-vision-toolkit'))+'/';
const compat=`// Local adapter for DSH 0.1.7: persist the legacy plugin's live settings separately.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SettingsConflictError } from '@deepseek-ai/dsh-settings';
const states=new WeakMap();
export function visionSettings(ctx) {
 if(states.has(ctx)) return states.get(ctx);
 const namespaces=new Map();
 const service={writable:true,
 register(ns,schema,{base,validate}) {
   const directory=join(process.env.DSH_HOME,'plugin-settings');mkdirSync(directory,{recursive:true,mode:0o700});
   const file=join(directory,ns+'.json');let saved;try{saved=JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
   let value=schema(saved?.value??base);validate(value);let revision=saved?.revision??0;const watchers=new Set();
   const handle={get:()=>value,watch:fn=>{watchers.add(fn);return()=>watchers.delete(fn);},update:patch=>replace({...value,...patch})};
   async function replace(next,expected){if(expected!==undefined&&expected!==revision)throw new SettingsConflictError(ns,expected,revision);next=schema(next);validate(next);const previous=value;const temp=file+'.tmp';writeFileSync(temp,JSON.stringify({value:next,revision:revision+1}),{mode:0o600});renameSync(temp,file);value=next;revision++;for(const fn of watchers)await fn(next,previous);}
   namespaces.set(ns,{describe:()=>({ns,schema:schema.toJSON(),value,revision,base,applies:'live',autoGenerate:false}),replace});return handle;
 },describe:()=>[...namespaces.values()].map(s=>s.describe()),replace:(ns,value,revision)=>namespaces.get(ns).replace(value,revision)};
 states.set(ctx,service);return service;
}
`;
fs.writeFileSync(dir+'settings-compat-local.js',compat);
for(const f of ['index.js','web.js']){let s=fs.readFileSync(dir+f,'utf8');if(s.includes("import { visionSettings }"))continue;s="import { visionSettings } from './settings-compat-local.js';\n"+s;s=s.replaceAll('this.ctx.settings','visionSettings(this.ctx)').replaceAll('ctx.settings','visionSettings(ctx)');fs.writeFileSync(dir+f,s);}
console.log('Patched vision settings API in two plugin modules.');
