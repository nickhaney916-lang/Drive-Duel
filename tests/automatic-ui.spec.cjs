const {test,expect,chromium}=require('@playwright/test');
const URL=process.env.TEST_URL||'http://127.0.0.1:8000';
test('two browsers follow automatic punt, touchdown conversion and skipped drive',async()=>{
 test.setTimeout(150000);
 const browsers=await Promise.all([chromium.launch(),chromium.launch()]);
 const pages=[], players=[], predictions=[], drives=[];
 const rid='10000000-0000-0000-0000-000000000001',game='901000001';
 let stage=1,applied=1,active='drive-1',scores=[0,0];
 const row=(n)=>({id:'drive-'+n,room_id:rid,game_id:game,drive_number:n,status:'in_progress',feed_drive_id:'espn-'+n,feed_closed:false,prediction_deadline:new Date(Date.now()+15000).toISOString()});
 drives.push(row(1));
 function transition(){
  if(stage===applied)return;applied=stage;
  if(stage===2){scores=[20,0];drives[0].status='scored';drives[0].feed_closed=true;drives.push(row(2));active='drive-2';}
  if(stage===3){drives[1].feed_closed=true;drives[1].status='awaiting_result';}
  if(stage===4){scores=[32,12];drives[1].status='scored';drives.push(row(3));active='drive-3';}
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
      const drive=drives.find(d=>d.id===body.p_drive_id);
      if(drive.feed_closed||Date.now()>=Date.parse(drive.prediction_deadline))return route.fulfill({status:400,headers,json:{message:'Prediction window closed'}});
      predictions.push({drive_id:body.p_drive_id,player_id:pid,prediction_type:body.p_prediction_type,predicted_outcome:body.p_predicted_outcome,is_locked:true});
      answer={ok:true};
    }else if(path.endsWith('/players'))answer=players.map((p,j)=>({...p,score:scores[j]}));
    else if(path.endsWith('/predictions'))answer=predictions.filter(p=>'eq.'+p.drive_id===url.searchParams.get('drive_id'));
    else if(path.endsWith('/room_game_state'))answer=[{room_id:rid,game_id:game,active_drive_id:active,pending_reason:null}];
    else if(path.endsWith('/drives'))answer=drives.filter(d=>!url.searchParams.get('id')||'eq.'+d.id===url.searchParams.get('id'));
    else throw Error('Unexpected backend request: '+path);
    if(req.headers()['accept']?.includes('vnd.pgrst.object')&&Array.isArray(answer))answer=answer[0];
    return route.fulfill({headers,json:answer});
   });
   const p=await c.newPage();pages.push(p);
   await p.goto(URL+(i?'?room=AUTOT1':''));
   await p.getByRole('textbox',{name:'Enter your name',exact:true}).fill('Auto Browser '+(i+1));
   if(i){await p.getByRole('button',{name:'Enter group',exact:true}).click();await expect(p.getByText('Room details',{exact:true})).toBeVisible();}
   await p.getByRole('button',{name:/Replay Away.*Replay Home/}).click();
   await expect.poll(()=>p.evaluate(()=>currentDriveId)).toBe('drive-1');
  }
  const [a,b]=pages;
  expect(await a.evaluate(()=>playerId)).not.toBe(await b.evaluate(()=>playerId));
  await a.getByRole('button',{name:'Punt',exact:true}).click();await a.locator('#lockPick').click();await expect(a.locator('#lockPick')).toHaveText('✓ Offense Pick Locked');
  await a.locator('#defenseTab').click();await a.getByRole('button',{name:'Force a punt',exact:true}).click();await a.locator('#lockPick').click();await expect(a.locator('#lockPick')).toHaveText('✓ Defense Pick Locked');
  await b.getByRole('button',{name:'Turnover',exact:true}).click();await b.locator('#lockPick').click();await expect(b.locator('#lockPick')).toHaveText('✓ Offense Pick Locked');
  stage=2;
  for(const p of pages){await expect.poll(()=>p.evaluate(()=>driveNumber),{timeout:25000}).toBe(2);await expect(p.locator('#trackerPlayerSummary')).toContainText('20 pts');await p.getByRole('button',{name:'Touchdown',exact:true}).click();await p.locator('#lockPick').click();await expect(p.locator('#lockPick')).toHaveText('✓ Offense Pick Locked');}
  stage=3;
  await expect(a.locator('#driveStatus'),{timeout:25000}).toContainText('confirming the result and conversion');
  await expect(a.locator('#trackerPlayerSummary')).toContainText('20 pts');
  for(const p of pages)await expect(p.getByRole('button',{name:'Punt',exact:true})).toBeDisabled();
  stage=4;
  for(const p of pages){await expect.poll(()=>p.evaluate(()=>driveNumber),{timeout:25000}).toBe(3);await expect(p.locator('#trackerPlayerSummary')).toContainText('32 pts');await expect(p.locator('#trackerPlayerSummary')).toContainText('12 pts');}
  await a.getByRole('button',{name:'Punt',exact:true}).click();await a.locator('#lockPick').click();await expect(a.locator('#lockPick')).toHaveText('✓ Offense Pick Locked');
  stage=5;
  for(const p of pages){await expect.poll(()=>p.evaluate(()=>driveNumber),{timeout:25000}).toBe(4);await expect(p.locator('#trackerPlayerSummary')).toContainText('42 pts');await expect(p.locator('#trackerPlayerSummary')).toContainText('12 pts');await expect(p.locator('#finalResultPanel')).toBeHidden();await expect(p.locator('#nextDrive')).toBeHidden();}
  await Promise.all(pages.map((p,i)=>p.screenshot({path:'test-results/automatic-browser-'+i+'.png',fullPage:true})));
  console.log('PASS: two isolated browser processes; automatic punt/next drive; TD waits for conversion; +2 bonus; skipped pick stays zero; manual controls hidden. Replay transport mocked; backend SQL tested separately.');
 }finally{await Promise.all(browsers.map(b=>b.close()));}
});
test('real server returns verified drive history and no phantom drive for final game',async()=>{
 test.setTimeout(60000);
 const browser=await chromium.launch();const p=await browser.newPage();
 try{
  await p.goto(URL);
  await expect.poll(()=>p.evaluate(()=>Boolean(db)),{timeout:20000}).toBe(true);
  const r=await p.evaluate(async()=>{
   await ensureAuth();
   const created=await db.rpc('create_drive_duel_room',{p_room_code:Math.random().toString(36).slice(2,8).toUpperCase().padEnd(6,'X'),p_league:'nfl',p_player_name:'Server Smoke'});
   if(created.error)throw created.error;
   const reply=await db.functions.invoke('drive-duel-live-feed',{body:{eventId:'401772943',league:'nfl',date:'2025-10-30',awayName:'Ravens',homeName:'Dolphins',roomId:created.data.room_id}});
   return {error:reply.error?.message,data:reply.data};
  });
  expect(r.error).toBeUndefined();expect(r.data.ok).toBe(true);expect(r.data.scoringSafe).toBe(true);
  expect(r.data.data.drive.completed).toBe(22);expect(r.data.data.automatic.active_drive_id).toBeNull();
  console.log('PASS: real authenticated edge function + database; 22 ESPN drive records; final game does not create a new drive.');
 }finally{await browser.close();}
});