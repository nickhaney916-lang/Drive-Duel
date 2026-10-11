const {test,expect,chromium}=require('@playwright/test');
const APP_URL=process.env.TEST_URL||'http://127.0.0.1:8000';
test('host sees a guest join before the guest locks any pick',async()=>{
 test.setTimeout(150000);
 const browsers=await Promise.all([chromium.launch(),chromium.launch()]);
 const pages=[], players=[], predictions=[], drives=[];
 const rid='10000000-0000-0000-0000-000000000001',game='901000001';
 let stage=1,applied=1,active='drive-1',scores=[0,0],version=0;const queues=[];let closeOnSubmit=false;
 const row=(n)=>({id:'drive-'+n,room_id:rid,game_id:game,drive_number:n,status:'in_progress',feed_drive_id:'espn-'+n,feed_closed:false,prediction_deadline:new Date(Date.now()+15000).toISOString()});
 drives.push(row(1));drives[0].feed_closed=true;
 function transition(){
  if(stage===applied)return;applied=stage;
  if(stage===2){scores=[0,0];drives[0].status='scored';drives[0].actual_outcome='Punt';drives[0].scored_at=new Date().toISOString();drives[0].feed_closed=true;drives.push(row(2));active='drive-2';for(const q of queues.filter(q=>!q.consumed_at)){q.consumed_at=new Date().toISOString();q.consumed_drive_id=active;predictions.push({drive_id:active,player_id:q.player_id,prediction_type:q.prediction_type,predicted_outcome:q.predicted_outcome,is_locked:true});}}
  if(stage===3){drives[1].feed_closed=true;drives[1].status='awaiting_result';}
  if(stage===4){scores=[10,0];drives[1].status='scored';drives[1].actual_outcome='Punt';drives[1].scored_at=new Date().toISOString();drives.push(row(3));active='drive-3';}
  if(stage===5){scores=[42,12];drives[2].status='scored';drives[2].actual_outcome='Punt';drives[2].scored_at=new Date().toISOString();drives[2].feed_closed=true;drives.push(row(4));active='drive-4';}
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
      if(i===0&&!predictions.length)predictions.push({drive_id:'drive-1',player_id:pid,prediction_type:'offense',predicted_outcome:'Punt',is_locked:true});answer={room_id:rid,player_id:pid,room_code:'AUTOT1',league:'nfl'};
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
    else if(path.endsWith('/drives')){answer=drives.filter(d=>(!url.searchParams.get('id')||'eq.'+d.id===url.searchParams.get('id'))&&(!url.searchParams.get('status')||'eq.'+d.status===url.searchParams.get('status')));if(path.endsWith('/drives')&&url.searchParams.get('status'))answer=answer.sort((a,b)=>b.drive_number-a.drive_number).slice(0,Number(url.searchParams.get('limit')||answer.length));}
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
  const [host,guest]=pages;
  await expect(host.locator('#liveRosterStatus'),{timeout:12000}).toContainText('2 players');
  await expect(host.locator('#liveRosterStatus')).toContainText('Auto Browser 2 joined');
  const guestId=await guest.evaluate(()=>playerId);
  const guestChip=host.locator('#trackerLockedRows [data-player="'+guestId+'"]');
  await expect(guestChip).toContainText('Auto Browser 2');
  await expect(guestChip).toContainText('Awaiting pick');
  await expect(guestChip).toContainText('0 pts');
  await expect(host.locator('#trackerLockedPicks')).toContainText('Punt');
  expect(predictions.filter(p=>p.player_id===guestId)).toHaveLength(0);
  await host.screenshot({path:'test-results/new-room-member-visible.png'});
  console.log('PASS: independent host/guest browsers; guest name, zero score and join notice appear before guest makes a pick.');
 }finally{await Promise.all(browsers.map(b=>b.close()));}
});
