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
     else answer={ok:true,scoringSafe:false,data:{provider:'Mock fixture',away:'Replay Away',home:'Replay Home',
       awayScore:0,homeScore:0,state:'pre',status:'Scheduled',period:0,clock:'',
       possession:'',lastPlay:'',fetchedAt:now(),automatic:{pending:true}}};
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
  await expect(guest.locator('#headToHead')).toContainText('Dad');
  await expect(guest.locator('#headToHead')).toContainText('Nick');
  expect(await guest.locator('#alertSound').isChecked()).toBe(false);
  expect(await guest.locator('#alertVibration').isChecked()).toBe(false);
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
   const choices=guest.locator('.primaryPickGrid').first();
   await expect(choices).toBeVisible();
   const overflow=await guest.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
   expect(overflow,'No horizontal scrolling for primary game screen').toBeLessThanOrEqual(2);
   await guest.screenshot({path:'test-results/easy-play-game-'+width+'.png'});
  }
 }finally{
  await Promise.allSettled(contexts.map(c=>c.close()));
  await Promise.allSettled(browsers.map(b=>b.close()));
 }
});