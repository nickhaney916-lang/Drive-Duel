import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('index.html','utf8');
const script=[...html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(match=>match[1].trim()).at(-1)?.[1];
if(!script)throw Error('Drive Duel inline client is missing');
const between=(begin,end)=>{
 const start=script.indexOf(begin),finish=script.indexOf(end,start+begin.length);
 assert.ok(start>=0&&finish>start,'Missing expected code block '+begin);
 return script.slice(start,finish);
};

test('client JavaScript parses without external dependencies',()=>{
 assert.doesNotThrow(()=>new Function(script));
});

test('universal quick play has accessible controls',()=>{
 for(const id of ['inviteWelcome','joinInviteOneTap','globalConnection','practiceDialog','practiceChoices','practiceClose','practiceLock','practiceNext','pickToast','advancedPickDetails']){
  assert.ok(html.includes('id="'+id+'"'),'Missing '+id);
 }
 assert.match(html,/aria-modal="true"/);
 assert.match(html,/class="primaryPickGrid"/);
 assert.match(script,/const primaryPickOptions=\{/);
 assert.match(script,/offense:\['Touchdown','Field Goal','Punt','Turnover'\]/);
});

test('invitation contains room and selected game but does not leak other group game',()=>{
 const source=between('function invitationUrl(){','\nlet lockedTrackerRows');
 const make=new Function('roomCode','selectedGame','readGroupBookmark','league',source+'\nreturn invitationUrl');
 const link=make('ABCD23',{id:'4017'},()=>null,'nfl')();
 assert.equal(new URL(link).searchParams.get('room'),'ABCD23');
 assert.equal(new URL(link).searchParams.get('game'),'4017');
 const stale=make('ABCD23',null,()=>({code:'OLD',league:'nfl',game:{id:'9'}}),'nfl')();
 assert.equal(new URL(stale).searchParams.has('game'),false);
});

test('invitation joins the real room only after player presses join',()=>{
 const source=between('function showInviteLanding(){','function invitationUrl(){');
 assert.match(source,/joinInviteOneTap'\)\.addEventListener\('click'/);
 assert.match(source,/await joinRoom\(\)/);
 assert.match(source,/await enterInvitedGame\(\)/);
 assert.match(source,/lastEvents\.find\(e=>String\(e\.id\)===gameId\)/);
});

test('practice mode never writes multiplayer data or real points',()=>{
 const source=between('const practiceOutcomes=','function showInviteLanding(){');
 assert.doesNotMatch(source,/\.rpc\(|\.from\(|drive_duel_|markGameWithPick\(/);
 assert.match(source,/Real scores stay unchanged/);
});

test('successful pick confirmation follows server acceptance',()=>{
 const queue=between('async function saveNextPick(','\n$(\'cancelNextPick\').addEventListener');
 assert.ok(queue.indexOf('if(error)throw error;')<queue.indexOf("showPickToast('✓"));
 const current=between("$(\'lockPick\').addEventListener","$(\'nextDrive\').addEventListener");
 assert.match(current,/if\(currentDriveId===drive\)\{lockedTypes\[type\]=true;chosenPicks\[type\]=pick;showPickToast\('✓ '/);
 assert.match(queue,/showPickToast\('Pick not saved/);
 assert.match(current,/showPickToast\('Pick not saved/);
});

test('restores the same room and saved game instead of creating a new one',()=>{
 assert.match(script,/frontPageRestorePromise\.then\(async\(\)=>/);
 assert.match(script,/if\(!roomId\|\|selectedGame\|\|!saved\?\.game\|\|roomCode!==saved\.code\)return/);
 assert.match(script,/await openGame\(remembered\)/);
});
