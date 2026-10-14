const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const script=path.join(__dirname,'prepare-local-app.cjs');
const key='local_test_key_12345678901234567890';
function run(url){return spawnSync(process.execPath,[script],{cwd:root,env:{...process.env,TEST_SUPABASE_URL:url,TEST_SUPABASE_ANON_KEY:key},encoding:'utf8'});}
test('refuses hosted Supabase URL',()=>{const r=run('https://qlwotqbqxpgkheitsboe.supabase.co');assert.notEqual(r.status,0);});
test('refuses absent local URL',()=>{const r=run('');assert.notEqual(r.status,0);});
test('generates isolated app without changing original',()=>{
 const original=fs.readFileSync(path.join(root,'index.html'),'utf8');
 const url='http://127.0.0.1:54321';
 const r=run(url);assert.equal(r.status,0,r.stderr);
 const output=fs.readFileSync(path.join(root,'test-results/local-app/index.html'),'utf8');
 assert.ok(output.includes('const SUPABASE_URL='+JSON.stringify(url)));
 assert.ok(output.includes('const SUPABASE_ANON_KEY='+JSON.stringify(key)));
 assert.ok(!output.includes('https://qlwotqbqxpgkheitsboe.supabase.co'));
 assert.equal(fs.readFileSync(path.join(root,'index.html'),'utf8'),original);
});
