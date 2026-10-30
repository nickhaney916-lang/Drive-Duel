const {test,expect,chromium}=require('@playwright/test');
const fs=require('node:fs');
const APP=process.env.TEST_URL||'http://127.0.0.1:8000';
const ROOM_ID='10000000-0000-0000-0000-000000000011';
const GAME_ID='901000001';
const ROOM_CODE='FAM123';
const now=()=>new Date().toISOString();

test('easy play: friend invitation, practice, two devices and no surprise CPU',async()=>{
 test.setTimeout(160000);
 fs.mkdirSync('test-results',{recursive:true});
 const browsers=await Promise.all([chromium.launch(),chromium.launch()]);
 const pages=[],contexts=[],players=[],gameMembers=[],rpcCalls=[];
 let providerMode='scores-only';
 const fixture={id:GAME_ID,name:'Replay Away at Replay Home',date:now(),
  status:{type:{state:'pre',detail:'Scheduled'}},
  competitions:[{competitors:[
   {homeAway:'away',score:'0',team:{shortDisplayName:'Replay Away',displayName:'Replay Away'}},
   {homeAway:'home',score:'0',team:{shortDisplayName:'Replay Home',displayName:'Replay Home'}}
  ]}]};
 try {
  for(let i=0;i<2;i++){
   const context=await browsers[i].newContext({viewport:{width:i?320:390,height:800}});
   contexts.push(context);
   const userId='20000000-0000-0000-0000-00000000001'+i;
   const playerId='30000000-0000-0000-0000-00000000001'+i;
   const user={id:userId,aud:'authenticated',role:'authenticated',
    app_metadata:{provider:'anonymous',providers:['anonymous']},
    user_metadata:{},created_at:now(),is_anonymous:true};
   const jwt=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+
      Buffer.from(JSON.stringify({sub:userId,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.mock-signature';
   await context.routeWebSocket('**/realtime/**',ws=>ws.close());
   await context.route('**/*.supabase.co/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    const method=request.method(),body=method==='POST'?(request.postDataJSON()||{}):{};
    const headers={'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS',
      'access-control-allow-headers':'authorization,apikey,content-type,x-client-info,prefer',
      'content-type':'application/json'};
    if(method==='OPTIONS')return route.fulfill({headers,body:'{}'});
    let answer;
    if(path==='/auth/v1/signup')answer={access_token:jwt,refresh_token:'mock-refresh-'+i,token_type:'bearer',expires_in:3600,user};
    else if(path==='/auth/v1/user')answer=user;
    else if(path.includes('/functions/v1/')){
     if(body.operation==='schedule')answer={ok:true,events:[fixture]};
     else answer={ok:true,scoringSafe:providerMode==='verified',data:{provider:'Mock fixture',away:'Replay Away',home:'Replay Home',
       awayScore:0,homeScore:0,state:'pre',status:'Scheduled',period:0,clock:'',
       possession:'',lastPlay:providerMode==='verified'?'Verified run for 8 yards':'',
       fetchedAt:now(),automatic:{pending:providerMode!=='verified'}}};
    }else if(path.endsWith('/rpc/create_drive_duel_room')||path.endsWith('/rpc/join_drive_duel_room')){
     rpcCalls.push({kind:path.split('/').at(-1),player:i});
     if(!players.some(p=>p.id===playerId))players.push({id:playerId,user_id:userId,room_id:ROOM_ID,
       player_name:body.p_player_name,is_cpu:false,score:0,created_at:now()});
     answer={room_id:ROOM_ID,player_id:playerId,room_code:ROOM_CODE,league:'nfl'};
    }else if(path.endsWith('/rpc/add_drive_duel_cpu')){
     rpcCalls.push({kind:'add_drive_duel_cpu',player:i});
     answer={ok:true};
    }else if(path.endsWith('/rpc/drive_duel_group_standings'))answer={games:[]};
    else if(path.endsWith('/players'))answer=players;
    else if(path.endsWith('/game_players')){
     if(method==='POST'){
      for(const row of Array.isArray(body)?body:[]){
       if(!gameMembers.some(p=>p.game_id===row.game_id&&p.player_id===row.player_id))gameMembers.push(row);
      }
      answer=[];
     }else answer=gameMembers.filter(m=>(!url.searchParams.get('game_id')||'eq.'+m.game_id===url.searchParams.get('game_id')));
    }else if(path.endsWith('/group_game_details'))answer=[];
    else if(path.endsWith('/queued_predictions')||path.endsWith('/predictions')||path.endsWith('/drives'))answer=[];
    else if(path.endsWith('/room_game_state'))answer=[];
    else if(path.includes('/rpc/drive_duel_')){
     rpcCalls.push({kind:path.split('/').at(-1),player:i});
     answer={ok:true};
    }else throw Error('Unexpected mock request: '+path);
    if(request.headers()['accept']?.includes('vnd.pgrst.object')&&Array.isArray(answer))answer=answer[0]||null;
    return route.fulfill({headers,json:answer});
   });
   pages.push(await context.newPage());
  }
  const [host,guest]=pages;
  await host.goto(APP,{waitUntil:'domcontentloaded'});
  await host.locator('#playerName').fill('Nick');
  await host.locator('#createNewGroup').click();
  await expect(host.locator('#groupConnected')).toBeVisible();
  await host.locator('#games .game').first().click();
  await expect(host.locator('#trackerTitle')).toContainText('Replay Away');
  await host.locator('#trackerShare').click();
  const invite=await host.locator('#roomLinkDisplay').inputValue();
  expect(new URL(invite).searchParams.get('room')).toBe(ROOM_CODE);
  expect(new URL(invite).searchParams.get('game')).toBe(GAME_ID);
  expect(rpcCalls.filter(x=>x.kind==='add_drive_duel_cpu')).toHaveLength(0);

  await guest.goto(invite,{waitUntil:'domcontentloaded'});
  await expect(guest.locator('#inviteWelcome')).toBeVisible();
  await expect(guest.locator('#joinInviteOneTap')).toBeVisible();
  await expect(guest.locator('#joinRoom')).toBeHidden();
  for(const width of [320,390,430]){
   await guest.setViewportSize({width,height:800});
   await expect(guest.locator('#joinInviteOneTap')).toBeInViewport();
   await guest.screenshot({path:'test-results/easy-play-invite-'+width+'.png'});
  }

  const previousWrites=rpcCalls.length;
  await guest.locator('#practiceStart').click();
  const dialog=guest.locator('#practiceDialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button',{name:'Touchdown'}).click();
  await dialog.locator('#practiceLock').click();
  await expect(dialog.locator('#practiceResult')).toContainText('Real scores stay unchanged');
  expect(rpcCalls.length).toBe(previousWrites);
  await guest.screenshot({path:'test-results/easy-play-practice.png'});
  await dialog.locator('#practiceClose').click();
  await expect(dialog).toBeHidden();

  await guest.locator('#playerName').fill('Dad');
  await guest.locator('#joinInviteOneTap').click();
  await expect.poll(()=>guest.evaluate(()=>roomCode),{timeout:20000}).toBe(ROOM_CODE);
  await expect.poll(()=>guest.evaluate(()=>selectedGame?.id),{timeout:30000}).toBe(GAME_ID);
  await expect(guest.locator('#trackerTitle')).toContainText('Replay Away');
  const joined=await guest.evaluate(()=>({roomId,playerId,game:selectedGame?.id}));
  expect(joined.roomId).toBe(ROOM_ID);
  expect(players.filter(p=>!p.is_cpu)).toHaveLength(2);
  expect(rpcCalls.filter(x=>x.kind==='add_drive_duel_cpu')).toHaveLength(0);
  // The live game tracker is always on the main screen, not hidden by streamlining.
  await expect(guest.locator('#liveTrackerDetails')).toHaveAttribute('open','');
  for(const id of ['gameStatus','awayScore','homeScore','clockInfo','downDistance','fieldPosition',
    'possessionField','possession','lastPlay','pickCountdown','headToHead','headToHeadStatus']){
   await expect(guest.locator('#'+id)).toBeVisible();
  }
  await expect(guest.locator('#headToHead')).toContainText('You');
  await expect(guest.locator('#headToHead')).toContainText('Nick');
  expect(await guest.locator('#alertSound').isChecked()).toBe(false);
  expect(await guest.locator('#alertVibration').isChecked()).toBe(false);
  // Verified possession determines both teams; field position and scores never do.
  const teamLabels=await guest.evaluate(()=>{
   const event=selectedGame.competitions[0].competitors;
   event[0].team.name='Away';event[0].team.color='13579B';
   event[0].team.logo='https://a.espncdn.com/i/teamlogos/nfl/500/away.png';
   event[1].team.name='Home';event[1].team.color='B45309';
   currentDriveId='team-test-drive';driveNumber=5;automaticReady=true;
   automaticPending=false;feedClosed=false;driveScored=false;
   predictionDeadline=Date.now()+20000;
   setVerifiedPossessionIdentity({possession:'Replay Away'},true);renderDualPickPanels();
   const away={
    offense:document.getElementById('dualOffenseTeamName').textContent,
    defense:document.getElementById('dualDefenseTeamName').textContent,
    logo:document.getElementById('dualOffenseLogo').src,
    color:document.getElementById('dualOffenseTeam').style.getPropertyValue('--team-accent'),
    number:driveNumber
   };
   // The identity resolver supports both exact full names and abbreviations.
   event[0].team.abbreviation='RA';event[1].team.abbreviation='RH';
   const abbreviation=confirmedPossessionSide('RH');
   const unknown=confirmedPossessionSide('Replay');
   const conflict=confirmedPossessionSide('Replay Home Panthers');
   currentDriveId='team-test-drive-2';driveNumber=6;
   setVerifiedPossessionIdentity({possession:'Replay Home'},true);renderDualPickPanels();
   const changed={offense:document.getElementById('dualOffenseTeamName').textContent,
    defense:document.getElementById('dualDefenseTeamName').textContent};
   setVerifiedPossessionIdentity({possession:'Replay Away'},false);
   automaticPending=true;renderDualPickPanels();
   const fallback={offense:document.getElementById('dualOffenseTeamName').textContent,
    defense:document.getElementById('dualDefenseTeamName').textContent};
   currentDriveId=null;automaticPending=true;feedClosed=true;automaticReady=false;
   driveTeamIdentity.clear();possessionIdentity=null;renderDualPickPanels();
   return {away,abbreviation,unknown,conflict,changed,fallback};
  });
  expect(teamLabels.away).toEqual({
   offense:'Away',defense:'Home',
   logo:'https://a.espncdn.com/i/teamlogos/nfl/500/away.png',
   color:'#13579B',number:5
  });
  expect(teamLabels.abbreviation).toBe('home');
  expect(teamLabels.unknown).toBeNull();
  expect(teamLabels.conflict).toBeNull();
  expect(teamLabels.changed).toEqual({offense:'Home',defense:'Away'});
  expect(teamLabels.fallback.offense).toContain('team TBD');
  expect(teamLabels.fallback.defense).toContain('team TBD');
  // Once a trusted play has been seen, losing play-by-play must not erase or invent that play.
  providerMode='verified';
  await guest.locator('#refresh').click();
  await expect(guest.locator('#lastPlay')).toContainText('Verified run for 8 yards');
  await expect(guest.locator('#feedStatus')).toContainText('verified drives');
  providerMode='scores-only';
  await guest.locator('#refresh').click();
  await expect(guest.locator('#feedStatus')).toContainText('automatic picks and scoring paused');
  await expect(guest.locator('#lastPlay')).toContainText('Last verified play');
  // Preferences require a deliberate opt-in and remain local to the device.
  await guest.locator('#alertSettings').evaluate(el=>{el.open=true});
  await guest.locator('#alertSound').check();
  expect(await guest.evaluate(()=>JSON.parse(localStorage.getItem('drive-duel-alerts-v1')).sound)).toBe(true);
  await guest.locator('#alertSound').uncheck();
  // Only one confirmation may remain when both picks are locked.
  await guest.evaluate(()=>{
   currentDriveId='mock-drive-3';driveNumber=3;
   automaticReady=true;automaticPending=true;feedClosed=true;driveScored=false;
   lockedTypes={offense:true,defense:true};
   chosenPicks={offense:'Field Goal',defense:'Hold to a field goal'};
   lockedTrackerNumber=3;
   lockedTrackerRows=[
    {player_id:playerId,is_locked:true,prediction_type:'offense',predicted_outcome:'Field Goal'},
    {player_id:playerId,is_locked:true,prediction_type:'defense',predicted_outcome:'Hold to a field goal'}
   ];
   renderAutomaticStatus();
   renderMyCurrentPicks();
   renderDualPickPanels();
  });
  await expect(guest.locator('#myCurrentPicks')).toBeVisible();
  await expect(guest.locator('#myPicksState')).toHaveText('✓ LOCKED');
  await expect(guest.locator('#myOffensePick')).toHaveText('Field Goal');
  await expect(guest.locator('#myDefensePick')).toHaveText('Hold to a field goal');
  await expect(guest.locator('#pickWindowBanner')).toBeHidden();
  await expect(guest.locator('#pickCountdown')).toBeHidden();
  await expect(guest.locator('#dualOffenseState')).toBeHidden();
  await expect(guest.locator('#dualDefenseState')).toBeHidden();
  await expect(guest.locator('#dualOffenseSave')).toBeHidden();
  await expect(guest.locator('#dualDefenseSave')).toBeHidden();
  await expect(guest.locator('#liveTrackerDetails')).toBeVisible();
  for(const width of [320,390,430]){
   await guest.setViewportSize({width,height:800});
   // Restore the synthetic state inside the same task as the assertions.
   // Realtime polling can legitimately return the mock fixture to waiting.
   const snapshot=await guest.evaluate(()=>{
    currentDriveId='mock-drive-3';driveNumber=3;driveScored=false;
    automaticReady=true;automaticPending=true;feedClosed=true;
    lockedTypes={offense:true,defense:true};
    chosenPicks={offense:'Field Goal',defense:'Hold to a field goal'};
    lockedTrackerNumber=3;
    lockedTrackerRows=[
     {player_id:playerId,is_locked:true,prediction_type:'offense',predicted_outcome:'Field Goal'},
     {player_id:playerId,is_locked:true,prediction_type:'defense',predicted_outcome:'Hold to a field goal'}
    ];
    renderAutomaticStatus();renderMyCurrentPicks();renderDualPickPanels();
    return {
     cardVisible:!document.querySelector('#myCurrentPicks').hidden,
     bannerHidden:document.querySelector('#pickWindowBanner').hidden,
     timerHidden:document.querySelector('#pickCountdown').hidden,
     header:document.querySelector('#myPicksState').textContent,
     offense:document.querySelector('#myOffensePick').textContent,
     defense:document.querySelector('#myDefensePick').textContent,
     trackerOpen:document.querySelector('#liveTrackerDetails').open
    };
   });
   expect(snapshot).toEqual({
    cardVisible:true,bannerHidden:true,timerHidden:true,header:'✓ LOCKED',
    offense:'Field Goal',defense:'Hold to a field goal',trackerOpen:true
   });
   await guest.screenshot({path:'test-results/one-lock-confirmation-'+width+'.png'});
  }
  // The next possession must restore the ordinary prediction/countdown state.
  await guest.evaluate(()=>{
   currentDriveId=null;lockedTypes={offense:false,defense:false};
   chosenPicks={offense:'',defense:''};
   lockedTrackerRows=[];lockedTrackerNumber=null;automaticPending=true;
   renderAutomaticStatus();renderMyCurrentPicks();renderDualPickPanels();
  });
  await expect(guest.locator('#myCurrentPicks')).toBeHidden();
  await expect(guest.locator('#pickWindowBanner')).toBeVisible();
  await expect(guest.locator('#pickCountdown')).toBeVisible();
  const windowState=await guest.evaluate(()=>{
   automaticReady=true;automaticPending=false;feedClosed=false;driveScored=false;
   currentDriveId='test-open-drive';predictionDeadline=Date.now()+13000;
   renderAutomaticStatus();
   const data={state:document.getElementById('pickCountdown').dataset.state,
     seconds:document.getElementById('pickCountdownNumber').textContent};
   automaticReady=false;automaticPending=true;feedClosed=true;currentDriveId=null;
   renderAutomaticStatus();return data;
  });
  expect(windowState.state).toBe('open');
  expect(windowState.seconds).toMatch(/^1[23]s$/);
  for(const width of [320,390,430]){
   await guest.setViewportSize({width,height:800});
   const choices=guest.locator('#dualOffenseChoices .allPickGrid');
   await expect(choices).toBeVisible();
   await expect(choices.locator('button')).toHaveCount(8);
   await expect(guest.locator('#dualDefenseChoices .allPickGrid button')).toHaveCount(8);
   await expect(guest.locator('.extraPicks')).toHaveCount(0);
   await expect(guest.locator('#advancedPickDetails')).toBeHidden();
   const typography=await guest.evaluate(()=>Array.from(document.querySelectorAll('#dualPickPanels .allPickGrid button')).map(button=>{
     const style=getComputedStyle(button);
     return {wordBreak:style.wordBreak,overflowWrap:style.overflowWrap,
       borderRadius:parseFloat(style.borderTopLeftRadius),width:button.clientWidth,
       scrollWidth:button.scrollWidth,fontsize:parseFloat(style.fontSize)};
   }));
   expect(typography).toHaveLength(16);
   for(const button of typography){
     expect(button.wordBreak).toBe('normal');
     expect(button.overflowWrap).toBe('normal');
     expect(button.borderRadius).toBeGreaterThanOrEqual(12);
     expect(button.scrollWidth).toBeLessThanOrEqual(button.width+2);
     expect(button.fontsize).toBeLessThanOrEqual(14);
   }
   const overflow=await guest.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
   expect(overflow,'No horizontal scrolling for primary game screen').toBeLessThanOrEqual(2);
   await guest.screenshot({path:'test-results/easy-play-game-'+width+'.png'});
  }
  await guest.reload({waitUntil:'domcontentloaded'});
  await expect.poll(()=>guest.evaluate(()=>roomCode),{timeout:30000}).toBe(ROOM_CODE);
  await expect.poll(()=>guest.evaluate(()=>selectedGame?.id),{timeout:30000}).toBe(GAME_ID);
  expect(players.filter(p=>!p.is_cpu)).toHaveLength(2);
  expect(rpcCalls.filter(x=>x.kind==='add_drive_duel_cpu')).toHaveLength(0);
  await guest.screenshot({path:'test-results/easy-play-reconnected.png'});
 }finally{
  await Promise.allSettled(contexts.map(c=>c.close()));
  await Promise.allSettled(browsers.map(b=>b.close()));
 }
});