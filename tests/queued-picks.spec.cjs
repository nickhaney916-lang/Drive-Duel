const {test,expect,chromium}=require('@playwright/test');
const APP_URL=process.env.TEST_URL||'http://127.0.0.1:8000';
test('two independent browsers queue, edit, cancel and auto-lock one possession',async()=>{
 test.setTimeout(150000);
 const browsers=await Promise.all([chromium.launch(),chromium.launch()]);
 const pages=[], players=[], predictions=[], drives=[];
 const rid='10000000-0000-0000-0000-000000000001',game='901000001';
 let stage=1,applied=1,active='drive-1',scores=[0,0],version=0;const queues=[];let closeOnSubmit=false;
 const row=(n)=>({id:'drive-'+n,room_id:rid,game_id:game,drive_number:n,status:'in_progress',feed_drive_id:'espn-'+n,feed_closed:false,prediction_deadline:new Date(Date.now()+15000).toISOString()});
 drives.push(row(1));drives[0].feed_closed=true;
 function transition(){
  if(stage===applied)return;applied=stage;
  if(stage===2){scores=[0,0];drives[0].status='scored';drives[0].feed_closed=true;drives.push(row(2));active='drive-2';for(const q of queues.filter(q=>!q.consumed_at)){q.consumed_at=new Date().toISOString();q.consumed_drive_id=active;predictions.push({drive_id:active,player_id:q.player_id,prediction_type:q.prediction_type,predicted_outcome:q.predicted_outcome,is_locked:true});}}
  if(stage===3){drives[1].feed_closed=true;drives[1].status='awaiting_result';}
  if(stage===4){scores=[10,0];drives[1].status='scored';drives.push(row(3));active='drive-3';}
  if(stage===5){scores=[42,12];drives[2].status='scored';drives[2].feed_closed=true;drives.push(row(4));active='drive-4';}
 }
 const fixture={id:game,name:'Replay Away at Replay Home',date:new Date().toISOString(),status:{type:{state:'in',detail:'Replay'}},competitions:[{competitors:[{homeAway:'away',score:'0',team:{shortDisplayName:'Replay Away'}},{homeAway:'home',score:'0',team:{shortDisplayName:'Replay Home'}}]}]};
 try{
  for(let i=0;i<2;i++){
   const c=await browsers[i].newContext({viewport:{width:i?390:1280,height:900}});
   const uid='20000000-0000-0000-0000-00000000000'+(i+1),pid='30000000-0000-0000-0000-00000000000'+(i+1);
   const user={id:uid,aud:'authenticated',role:'authenticated',app_metadata:{provider:'anonymous',providers:['anonymous']},user_metadata:{},identities:[],created_at:new Date().toISOString(),is_anonymous:true};
   const jwt=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:uid,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.test-signature';
   await c.routeWebSocket('**/realtime/**',ws=>ws.close());
   await c.route('**/*.supabase.co/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname,body=req.method()==='POST'?req.postDataJSON():{};
    const headers={'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'authorization,apikey,content-type,x-client-info','content-type':'application/json'};
    if(req.method()==='OPTIONS')return route.fulfill({headers,body:'{}'});
    let answer;
    if(path==='/auth/v1/signup')answer={access_token:jwt,refresh_token:'mock-refresh-'+i,token_type:'bearer',expires_in:3600,user};
    else if(path==='/auth/v1/user')answer=user;
    else if(path.includes('/functions/v1/')){
      if(body.operation==='schedule')answer={ok:true,events:[fixture]};
      else{transition();answer={ok:true,scoringSafe:true,data:{away:'Replay Away',home:'Replay Home',awayScore:stage>=4?7:stage>=3?6:0,homeScore:0,state:'in',status:'Replay live',period:1,clock:'10:00',possession:stage===1?'Replay Away':'Replay Home',lastPlay:stage===3?'Touchdown, conversion pending':'Verified replay',fetchedAt:new Date().toISOString(),automatic:{pending:false}}};}
    }else if(path.endsWith('/rpc/create_drive_duel_room')||path.endsWith('/rpc/join_drive_duel_room')){
      if(!players.some(p=>p.id===pid))players.push({id:pid,room_id:rid,player_name:body.p_player_name,user_id:uid,is_cpu:false,score:0,created_at:new Date().toISOString()});
      answer={room_id:rid,player_id:pid,room_code:'AUTOT1',league:'nfl'};
    }else if(path.endsWith('/rpc/add_drive_duel_cpu'))answer={ok:true};
    else if(path.endsWith('/rpc/drive_duel_lock_prediction')){
      const drive=drives.find(d=>d.id===body.p_drive_id);if(closeOnSubmit){drive.feed_closed=true;closeOnSubmit=false;}
      if(drive.feed_closed||Date.now()>=Date.parse(drive.prediction_deadline))return route.fulfill({status:400,headers,json:{message:'Prediction window closed'}});
      predictions.push({drive_id:body.p_drive_id,player_id:pid,prediction_type:body.p_prediction_type,predicted_outcome:body.p_predicted_outcome,is_locked:true});
      answer={ok:true};
    }else if(path.endsWith('/players'))answer=players.map((p,j)=>({...p,score:scores[j]}));
    else if(path.endsWith('/queued_predictions'))answer=queues.filter(q=>q.player_id===pid);
    else if(path.endsWith('/rpc/drive_duel_queue_pick')){
      const idx=queues.findIndex(q=>q.player_id===pid&&q.prediction_type===body.p_prediction_type),q=queues[idx];
      if(body.p_expected_version&&(q?.version!==body.p_expected_version||q.consumed_at))return route.fulfill({status:400,headers,json:{message:'This queued pick has already locked'}});
      if(body.p_cancel){queues.splice(idx,1);answer={ok:true,cancelled:true};}
      else{const saved={id:'queue-'+pid,room_id:rid,game_id:game,player_id:pid,prediction_type:body.p_prediction_type,predicted_outcome:body.p_predicted_outcome,version:'version-'+(++version),after_source_number:stage===1?1:2,consumed_at:null};if(idx>=0)queues[idx]=saved;else queues.push(saved);answer={ok:true};}
    }
    else if(path.endsWith('/predictions'))answer=predictions.filter(p=>'eq.'+p.drive_id===url.searchParams.get('drive_id'));
    else if(path.endsWith('/room_game_state'))answer=[{room_id:rid,game_id:game,active_drive_id:active,pending_reason:null,latest_source_number:drives.length,game_state:'in'}];
    else if(path.endsWith('/drives'))answer=drives.filter(d=>!url.searchParams.get('id')||'eq.'+d.id===url.searchParams.get('id'));
    else throw Error('Unexpected backend request: '+path);
    if(req.headers()['accept']?.includes('vnd.pgrst.object')&&Array.isArray(answer))answer=answer[0];
    return route.fulfill({headers,json:answer});
   });
   const p=await c.newPage();pages.push(p);
   await p.goto(APP_URL+(i?'?room=AUTOT1':''));
   await p.getByRole('textbox',{name:'Enter your name',exact:true}).fill('Auto Browser '+(i+1));
   if(i){await p.getByRole('button',{name:'Enter group',exact:true}).click();await expect(p.getByText('Room details',{exact:true})).toBeVisible();}
   await p.getByRole('button',{name:/Replay Away.*Replay Home/}).click();
   await expect.poll(()=>p.evaluate(()=>currentDriveId)).toBe('drive-1');
  }
  const [a,b]=pages;await expect(a.locator('#predictionPanel')).toHaveCount(1);await expect(a.locator('#nextPossessionPanel')).toHaveCount(0);await expect(a.locator('#pickTarget')).toHaveAttribute('data-target','next');
  await a.getByRole('button',{name:'Punt',exact:true}).click();
  await a.locator('#lockPick').click();await expect(a.locator('#queueStatus')).toContainText('QUEUED · Punt');
  await expect(b.locator('#queueStatus')).not.toContainText('QUEUED');
  await a.getByRole('button',{name:'Touchdown',exact:true}).click();
  await a.locator('#lockPick').click();await expect(a.locator('#queueStatus')).toContainText('QUEUED · Touchdown');
  await a.locator('#cancelNextPick').click();await expect(a.locator('#cancelNextPick')).toBeHidden();
  await a.getByRole('button',{name:'Punt',exact:true}).click();await a.locator('#lockPick').click();
  await expect(a.locator('#queueStatus')).toContainText('QUEUED · Punt');
  stage=2;
  for(const p of pages)await expect.poll(()=>p.evaluate(()=>driveNumber),{timeout:25000}).toBe(2);
  await expect(a.locator('#pickTarget')).toHaveAttribute('data-target','current');await expect(a.locator('#trackerLockedPicks')).toContainText('Auto Browser 1 (you)');await expect(a.locator('#trackerLockedPicks')).toContainText('Punt');await expect(b.locator('#trackerLockedPicks')).toContainText('Auto Browser 1');
  await expect(a.locator('#lockPick')).toHaveText('✓ Offense Pick Locked');await expect(a.locator('#cancelNextPick')).toBeHidden();
  await expect(a.getByRole('button',{name:'Punt',exact:true})).toBeDisabled();
  await expect(b.locator('#pickWindowBanner')).toHaveAttribute('data-state','open');
  await b.getByRole('button',{name:'Touchdown',exact:true}).click();await b.locator('#lockPick').click();await expect(b.locator('#lockPick')).toHaveText('✓ Offense Pick Locked');await expect(b.locator('#trackerLockedPicks')).toContainText('Auto Browser 2 (you)');await expect(a.locator('#trackerLockedPicks'),{timeout:15000}).toContainText('Touchdown');
  stage=3;for(const p of pages){await expect(p.locator('#pickTarget'),{timeout:25000}).toHaveAttribute('data-target','next');await expect(p.locator('#trackerLockedPicks')).toContainText('Punt');await expect(p.locator('#trackerLockedPicks')).toContainText('Touchdown');}
  stage=4;
  for(const p of pages){await expect.poll(()=>p.evaluate(()=>driveNumber),{timeout:25000}).toBe(3);await expect(p.locator('#trackerPlayerSummary')).toContainText('10 pts');}
  await expect(a.locator('#lockPick')).toBeDisabled();await expect(a.locator('#lockPick')).toHaveText('🔒 Lock my pick');
  expect(predictions.filter(p=>p.drive_id==='drive-3')).toHaveLength(0);await expect(a.locator('#trackerLockedPicks')).toBeHidden();
  // Mobile queue and sticky tracker remain usable while scrolling.
  closeOnSubmit=true;
  await b.getByRole('button',{name:'Punt',exact:true}).click();await b.locator('#lockPick').click();
  await expect(b.locator('#pickTarget')).toHaveAttribute('data-target','next');await expect(b.locator('#queueStatus')).toContainText('QUEUED · Punt');
  expect(predictions.filter(p=>p.drive_id==='drive-3')).toHaveLength(0);
  await b.locator('#picks').scrollIntoViewIfNeeded();await expect(b.locator('#liveGameTracker')).toBeVisible();
  expect(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await Promise.all(pages.map((p,i)=>p.screenshot({path:'test-results/queue-browser-'+i+'.png',fullPage:true})));
  console.log('PASS: two independent browser processes; queue edit/cancel, privacy, auto-lock, 30-second fallback, one-time use and mobile layout.');
 }finally{await Promise.all(browsers.map(b=>b.close()));}
});

test('real pregame queue survives reload and remains private to its owner',async()=>{
 test.setTimeout(120000);
 const browsers=await Promise.all([chromium.launch(),chromium.launch()]);
 const a=await browsers[0].newPage(),b=await browsers[1].newPage();
 try{
  await Promise.all([a.goto(APP_URL),b.goto(APP_URL)]);
  await expect.poll(()=>a.evaluate(()=>lastEvents.some(e=>e.status?.type?.state==='pre'&&Date.parse(e.date)>Date.now()+3600000)),{timeout:40000}).toBe(true);
  const saved=await a.evaluate(async()=>{
   await ensureAuth();const event=lastEvents.find(e=>e.status?.type?.state==='pre'&&Date.parse(e.date)>Date.now()+3600000),ts=teams(event);
   const room=await db.rpc('create_drive_duel_room',{p_room_code:makeCode(),p_league:'nfl',p_player_name:'Queue Browser Owner'});if(room.error)throw room.error;
   let feed,lastDetails;
   for(let attempt=0;attempt<3;attempt++){
    feed=await db.functions.invoke('drive-duel-live-feed',{body:{eventId:event.id,league:'nfl',date:event.date,awayName:ts.away.team.shortDisplayName,homeName:ts.home.team.shortDisplayName,roomId:room.data.room_id}});
    if(!feed.error&&feed.data?.scoringSafe)break;
    let details=feed.data?.note||feed.error?.message;
    if(feed.error?.context){try{details=await feed.error.context.clone().text()}catch{}}
    lastDetails=details;
    if(attempt<2)await new Promise(r=>setTimeout(r,1500));
   }
   if(feed.error||!feed.data?.scoringSafe)throw Error(event.id+': '+(lastDetails||feed.error?.message||feed.data?.note));
   const args={p_room_id:room.data.room_id,p_game_id:event.id,p_prediction_type:'offense',p_predicted_outcome:'Punt'};
   const queued=await db.rpc('drive_duel_queue_pick',args);if(queued.error)throw queued.error;
   return {room:room.data,args,version:queued.data.version};
  });
  const other=await b.evaluate(async s=>{
   await ensureAuth();const joined=await db.rpc('join_drive_duel_room',{p_room_code:s.room.room_code,p_player_name:'Queue Browser Opponent'});if(joined.error)throw joined.error;
   const rows=await db.from('queued_predictions').select('*').eq('room_id',s.room.room_id);if(rows.error)throw rows.error;return rows.data;
  },saved);
  expect(other).toEqual([]);
  await a.reload();
  const result=await a.evaluate(async s=>{
   await ensureAuth();const rows=await db.from('queued_predictions').select('*').eq('room_id',s.room.room_id);if(rows.error)throw rows.error;
   if(rows.data.length!==1||rows.data[0].predicted_outcome!=='Punt')throw Error('Saved queue did not persist');
   const edited=await db.rpc('drive_duel_queue_pick',{...s.args,p_predicted_outcome:'Touchdown',p_expected_version:s.version});if(edited.error)throw edited.error;
   const cancelled=await db.rpc('drive_duel_queue_pick',{...s.args,p_predicted_outcome:null,p_expected_version:edited.data.version,p_cancel:true});if(cancelled.error)throw cancelled.error;
   return cancelled.data;
  },saved);
  expect(result.cancelled).toBe(true);
  console.log('PASS: two real authenticated browsers; ESPN pregame verification, persistent queue save/edit/cancel and opponent privacy.');
 }finally{await Promise.all(browsers.map(b=>b.close()));}
});
