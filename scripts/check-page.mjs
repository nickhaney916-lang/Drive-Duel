// Guard against a broken main page, including a missing async on loadGames.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const html=await readFile('index.html','utf8');
const inline=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(Boolean);
if(!inline.length)throw Error('No inline application script found');
const dir=await mkdtemp(join(tmpdir(),'drive-duel-check-'));
try {
 for(let i=0;i<inline.length;i++){
  const file=join(dir,'inline-'+i+'.js');
  await writeFile(file,inline[i]);
  const check=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if(check.status!==0)throw Error('Inline script '+i+' has syntax errors:\n'+check.stderr);
 }
 if(!/async function loadGames\s*\(/.test(html))throw Error('loadGames must be async');
 for(const id of ['games','trackerView','myCurrentPicks','dualOffenseChoices','dualDefenseChoices']){
  if(!html.includes('id="'+id+'"'))throw Error('Missing essential UI element: '+id);
 }
 // Protect the core one-tap and confirmation flow against accidental regression.
 for(const [label,pattern] of [
  ['one-tap choice save',/target\.addEventListener\('click',[\s\S]*?\$\('lockPick'\)\.click\(\)/],
  ['server-side locked pick',/db\.rpc\('drive_duel_lock_prediction'/],
  ['server-side queued pick',/db\.rpc\('drive_duel_queue_pick'/],
  ['saved pick shown above game',/id="myCurrentPicks"/],
  ['queue refresh failure not treated as save failure',/Queued pick saved; refresh pending:/],
  ['locked picks can be reopened',/View locked picks/]
 ]) if(!pattern.test(html))throw Error('Gameplay regression: missing '+label);
 console.log('Drive Duel markup and inline JavaScript syntax: PASS');
}finally{await rm(dir,{recursive:true,force:true});}
