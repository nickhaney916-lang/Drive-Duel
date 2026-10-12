const {test,expect,chromium}=require('@playwright/test');
const fs=require('node:fs');
const APP_URL=process.env.TEST_URL||'http://127.0.0.1:8000';
test.use({trace:'off'});
test('100 independent player sessions across 78 groups update scores automatically',async()=>{
 test.skip(process.env.RUN_LARGE_LOAD_TEST!=='1','Run with the explicit load-test flag');
 test.setTimeout(360000);
 const start=Date.now(),browsers=await Promise.all([chromium.launch(),chromium.launch()]),pages=[],contexts=[];
 const uuid=(prefix,n)=>prefix+'0000000-0000-0000-0000-'+String(n).padStart(12,'0');
 const game='load-game-100',now=new Date().toISOString();
 const groups=Array.from({length:78},(_,g)=>({id:uuid('1',g+1),code:'L'+String(g+1).padStart(5,'0'),players:[],drives:[{id:'g'+g+'-d1',room_id:uuid('1',g+1),game_id:game,drive_number:1,status:'in_progress',feed_closed:false,prediction_deadline:new Date(Date.now()+300000).toISOString()}],predictions:[],phase:1}));
 const assigned=Array.from({length:100},(_,i)=>i<23?0:i-22);
 const uid=i=>uuid('2',i+1),pid=i=>uuid('3',i+1);
 for(let i=0;i<100;i++)groups[assigned[i]].players.push({id:pid(i),user_id:uid(i),room_id:groups[assigned[i]].id,player_name:'Sim '+String(i+1).padStart(3,'0'),is_cpu:false,score:0,created_at:now});
 let requests=0,errors=0,cpuCalls=0;
 const fixture={id:game,name:'Load Away at Load Home',date:now,status:{type:{state:'in'}},competitions:[{competitors:[{homeAway:'away',score:'0',team:{shortDisplayName:'Load Away'}},{homeAway:'home',score:'0',team:{shortDisplayName:'Load Home'}}]}]};
 const map={'Force a punt':'Punt','Force a turnover':'Turnover','Allow a touchdown':'Touchdown'};
 const score=(p,d)=>p.is_locked&&(p.prediction_type==='offense'?p.predicted_outcome:map[p.predicted_outcome])===d.actual_outcome?10+(d.actual_outcome==='Touchdown'&&d.conversion_success?2:0):0;
 function settle(number,outcome,conversion){
  for(const group of groups){
   const d=group.drives.find(d=>d.drive_number===number);if(d.status==='scored')continue;
   d.status='scored';d.feed_closed=true;d.actual_outcome=outcome;d.conversion_success=conversion;d.scored_at=new Date().toISOString();
   for(const p of group.players)p.score+=group.predictions.filter(q=>q.drive_id===d.id&&q.player_id===p.id).reduce((n,q)=>n+score(q,d),0);
   group.drives.push({id:'g'+groups.indexOf(group)+'-d'+(number+1),room_id:group.id,game_id:game,drive_number:number+1,status:'in_progress',feed_closed:false,prediction_deadline:new Date(Date.now()+300000).toISOString()});
   group.phase=number+1;
  }
 }
 const parallel=async(items,limit,fn)=>{let index=0;await Promise.all(Array.from({length:limit},async()=>{while(index<items.length){const i=index++;await fn(items[i],i);}}));};
 try{
  // Cache the same production client script once for all 100 browser contexts.
  const api=await browsers[0].newContext(),request=api.request;
  const source=await request.get('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',{timeout:30000});expect(source.ok()).toBe(true);const sdk=await source.text();await api.close();
  await parallel(Array.from({length:100},(_,i)=>i),8,async i=>{
   const group=groups[assigned[i]],c=await browsers[i%2].newContext({viewport:{width:i%5===0?390:1280,height:900}});contexts[i]=c;
   await c.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js@2',r=>r.fulfill({contentType:'application/javascript',body:sdk}));
   await c.routeWebSocket('**/realtime/**',ws=>ws.close()); // Explicitly exercise automatic polling fallback under load.
   const user={id:uid(i),aud:'authenticated',role:'authenticated',app_metadata:{provider:'anonymous',providers:['anonymous']},user_metadata:{},identities:[],created_at:now,is_anonymous:true};
   const jwt=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:uid(i),role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.test';
   await c.route('**/*.supabase.co/**',async route=>{
    requests++;const req=route.request(),url=new URL(req.url()),path=url.pathname,body=req.method()==='POST'?req.postDataJSON():{};
    const headers={'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'authorization,apikey,content-type,x-client-info','content-type':'application/json'};
    if(req.method()==='OPTIONS')return route.fulfill({headers,json:{}});
    let answer;
    if(path==='/auth/v1/signup')answer={access_token:jwt,refresh_token:'refresh-'+i,token_type:'bearer',expires_in:3600,user};
    else if(path==='/auth/v1/user')answer=user;
    else if(path.includes('/functions/v1/'))answer=body.operation==='schedule'?{ok:true,events:[fixture]}:{ok:true,scoringSafe:true,data:{away:'Load Away',home:'Load Home',awayScore:group.phase>=3?7:0,homeScore:0,state:'in',status:'Simulated live',period:1,clock:'10:00',possession:group.phase%2?'Load Away':'Load Home',lastPlay:'Load test possession '+group.phase,fetchedAt:new Date().toISOString(),automatic:{pending:false}}};
    else if(path.endsWith('/rpc/join_drive_duel_room')){if(body.p_room_code!==group.code){errors++;return route.fulfill({status:403,headers,json:{message:'Wrong group'}});}answer={room_id:group.id,player_id:pid(i),room_code:group.code,league:'nfl',already_joined:true};}
    else if(path.endsWith('/rpc/add_drive_duel_cpu')){cpuCalls++;if(!group.players.some(p=>p.is_cpu))group.players.push({id:'cpu-'+group.code,room_id:group.id,player_name:'Computer',is_cpu:true,score:0,created_at:now});answer={ok:true};}
    else if(path.endsWith('/rpc/drive_duel_lock_prediction')){
     const d=group.drives.find(d=>d.id===body.p_drive_id),existing=group.predictions.find(p=>p.drive_id===d?.id&&p.player_id===pid(i)&&p.prediction_type===body.p_prediction_type);
     if(!d||d.feed_closed||d.status!=='in_progress')return route.fulfill({status:400,headers,json:{message:'Prediction window closed'}});
     if(existing&&existing.predicted_outcome!==body.p_predicted_outcome)return route.fulfill({status:400,headers,json:{message:'Pick already locked'}});
     if(!existing)group.predictions.push({drive_id:d.id,player_id:pid(i),prediction_type:body.p_prediction_type,predicted_outcome:body.p_predicted_outcome,is_locked:true});answer={ok:true};
    }else if(path.endsWith('/players'))answer=group.players;
    else if(path.endsWith('/queued_predictions')||path.endsWith('/group_game_details'))answer=[];
    else if(path.endsWith('/game_players'))answer=req.method()==='POST'?[]:group.players.map(p=>({player_id:p.id}));
    else if(path.endsWith('/room_game_state'))answer=[{room_id:group.id,game_id:game,active_drive_id:group.drives.at(-1).id,latest_source_number:group.drives.length,game_state:'in',pending_reason:null}];
    else if(path.endsWith('/drives')){answer=group.drives.filter(d=>(!url.searchParams.get('id')||'eq.'+d.id===url.searchParams.get('id'))&&(!url.searchParams.get('status')||'eq.'+d.status===url.searchParams.get('status')));if(url.searchParams.get('status'))answer.sort((a,b)=>b.drive_number-a.drive_number);}
    else if(path.endsWith('/predictions'))answer=group.predictions.filter(p=>'eq.'+p.drive_id===url.searchParams.get('drive_id'));
    else if(path.endsWith('/rpc/drive_duel_group_standings')){if(body.p_room_id!==group.id)return route.fulfill({status:403,headers,json:{message:'Group membership required'}});answer={games:[{game_id:game,name:fixture.name,kickoff:now,state:'in',pending:false,players:group.players.map(p=>({player_id:p.id,name:p.player_name,is_cpu:p.is_cpu,user_id:p.user_id,points:p.score}))}]};}
    else{errors++;throw Error('Unexpected request '+path);}
    if(req.headers()['accept']?.includes('vnd.pgrst.object')&&Array.isArray(answer))answer=answer[0];
    return route.fulfill({headers,json:answer});
   });
   const p=await c.newPage();pages[i]=p;p.on('pageerror',e=>console.log('LOAD PAGE ERROR '+i+' '+e.message));p.on('crash',()=>console.log('LOAD PAGE CRASH '+i));await p.goto(APP_URL+'?room='+group.code,{waitUntil:'domcontentloaded'});
   await p.locator('#playerName').fill(group.players.find(p=>p.id===pid(i)).player_name);await p.locator('#joinRoom').click();await expect(p.locator('#groupConnected')).toBeVisible();
   await p.getByRole('button',{name:/Load Away.*Load Home/}).click();try{await expect.poll(()=>p.evaluate(()=>currentDriveId),{timeout:40000}).toBe('g'+assigned[i]+'-d1');}catch(e){console.log('LOAD START FAILURE '+JSON.stringify(await p.evaluate(()=>({selected:selectedGame,room:roomId,current:currentDriveId,busy:autoSyncBusy,feedBusy:feedRefreshBusy,classes:document.body.className,note:$('pickNote').textContent,feed:$('feedStatus').textContent,group:$('roomInfo').textContent}))));throw e;}
   await p.evaluate(()=>{window.__loadSavedGame=selectedGame;selectedGame=null;clearInterval(roomPollTimer);clearInterval(refreshTimer);});
   if(i%20===0)console.log('LOAD: opened '+(i+1)+' of 100 sessions');
  });
  expect(pages).toHaveLength(100);expect(groups).toHaveLength(78);
  await parallel(pages,12,p=>p.evaluate(()=>{selectedGame=window.__loadSavedGame;watchRoom();refreshTimer=setInterval(()=>refreshGame(),5000);renderChoices();}));
  expect(groups.filter(g=>g.players.some(p=>p.is_cpu))).toHaveLength(77);
  await parallel(pages,12,async(p,i)=>{
   await p.getByRole('button',{name:i%3===0?'Touchdown':'Punt',exact:true}).click();await p.locator('#lockPick').click();
   await p.locator('#defenseTab').click();await p.getByRole('button',{name:i%3===0?'Allow a touchdown':'Force a punt',exact:true}).click();await p.locator('#lockPick').click();
   await expect(p.locator('#pickControls')).toBeHidden();
  });
  const waitScores=async(drive,extra)=>{
   const began=Date.now();let snapshots;
   await expect.poll(async()=>{snapshots=await Promise.all(pages.map(p=>p.evaluate(()=>({drive:driveNumber,points:playerGameScore(playerId),room:roomId,players:players.map(p=>p.id)}))));return snapshots.every((s,i)=>s.drive===drive&&s.points===(i%3===0?0:20)+extra);},{timeout:40000,intervals:[1000]}).toBe(true);
   for(let i=0;i<100;i++){expect(snapshots[i].room).toBe(groups[assigned[i]].id);expect(snapshots[i].players.every(id=>groups[assigned[i]].players.some(p=>p.id===id))).toBe(true);}
   return Date.now()-began;
  };
  settle(1,'Punt',null);const puntRefreshMs=await waitScores(2,0);
  const humanTotal=()=>groups.flatMap(g=>g.players).filter(p=>!p.is_cpu).reduce((n,p)=>n+p.score,0);
  expect(humanTotal()).toBe(1320);settle(1,'Punt',null);expect(humanTotal()).toBe(1320);
  await parallel(pages,12,async p=>{
   await p.getByRole('button',{name:'Touchdown',exact:true}).click();await p.locator('#lockPick').click();await p.locator('#defenseTab').click();await p.getByRole('button',{name:'Allow a touchdown',exact:true}).click();await p.locator('#lockPick').click();
  });
  for(const g of groups){g.drives[1].feed_closed=true;g.drives[1].status='awaiting_result';}
  await new Promise(r=>setTimeout(r,4000));expect(humanTotal()).toBe(1320); // Conversion pending cannot award points.
  settle(2,'Touchdown',true);const tdRefreshMs=await waitScores(3,24);
  expect(humanTotal()).toBe(3720);settle(2,'Touchdown',true);expect(humanTotal()).toBe(3720);
  await parallel(pages.slice(0,10),5,async(p,i)=>{
   const before=await p.evaluate(()=>playerId);await contexts[i].setOffline(true);await contexts[i].setOffline(false);await p.reload({waitUntil:'domcontentloaded'});
   await expect(p.locator('#groupConnected')).toBeVisible();expect(await p.evaluate(()=>playerId)).toBe(before);
   await p.getByRole('button',{name:/Load Away.*Load Home/}).click();await expect.poll(()=>p.evaluate(()=>playerGameScore(playerId))).toBe((i%3===0?0:20)+24);
  });
  for(const i of [0,1,99])expect(await pages[i].evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await pages[0].screenshot({path:'test-results/load-largest-group-mobile.png',fullPage:true});
  await pages[99].screenshot({path:'test-results/load-solo-group.png',fullPage:true});
  const report={sessions:100,groups:78,cpuOpponents:77,puntPoints:1320,finalPoints:3720,requests,unexpectedRequests:errors,puntRefreshMs,tdRefreshMs,reconnectedSessions:10,elapsedMs:Date.now()-start,transport:'mocked API; production UI and automatic polling timers'};
  fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/load-100-report.json',JSON.stringify(report,null,2));console.log('LOAD REPORT '+JSON.stringify(report));expect(errors).toBe(0);
 }finally{await Promise.all(browsers.map(b=>b.close()));}
});