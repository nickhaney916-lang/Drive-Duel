// Prepare a test-only copy of the application with an isolated local Supabase URL.
// Never modify the checked-in index.html or allow a hosted Supabase destination.
const fs=require('node:fs');
const path=require('node:path');
const url=process.env.TEST_SUPABASE_URL;
const key=process.env.TEST_SUPABASE_ANON_KEY;
const local=h=>['127.0.0.1','localhost','::1'].includes(h);
if(!url||!local(new URL(url).hostname)) throw Error('TEST_SUPABASE_URL must point to localhost');
if(!key||key.length<20) throw Error('Missing local TEST_SUPABASE_ANON_KEY');
const source=fs.readFileSync('index.html','utf8');
const urlRe=/const SUPABASE_URL='[^']+';/;
const keyRe=/const SUPABASE_ANON_KEY='[^']+';/;
if(!urlRe.test(source)||!keyRe.test(source)) throw Error('App configuration constants not found');
const escape=s=>JSON.stringify(s);
const output=source.replace(urlRe,'const SUPABASE_URL='+escape(url)+';').replace(keyRe,'const SUPABASE_ANON_KEY='+escape(key)+';');
if(output.includes('https://qlwotqbqxpgkheitsboe.supabase.co')) throw Error('Production URL still present in generated test app');
// Resolve local application assets through the repository root while overriding index.html.
const destination=path.join('test-results','local-app');
fs.mkdirSync(destination,{recursive:true});
fs.writeFileSync(path.join(destination,'index.html'),output);
for(const name of ['assets','scripts','styles','images']){
 const src=path.resolve(name), dst=path.join(destination,name);
 if(fs.existsSync(src)&&!fs.existsSync(dst)) fs.symlinkSync(src,dst,fs.statSync(src).isDirectory()?'dir':'file');
}
console.log('Prepared isolated test-only index.html at '+destination);
