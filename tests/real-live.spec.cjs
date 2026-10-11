const {test,expect,chromium}=require('@playwright/test');
test('real live game across two independent browsers',async()=>{
 test.setTimeout(540000);
 const browsers=await Promise.all([chromium.launch(),chromium.launch()]);
 const pages=[];let joinedId,room,code;const seen=new Set();let locked=false,first=null,advanced=false,rejoined=false;
 async function sample(p){return p.evaluate(async()=>{
  const [ds,ps,qs]=await Promise.all([db.from('drives').select('*').eq('room_id',roomId).eq('game_id',selectedGame.id),db.from('players').select('*').eq('room_id',roomId),db.from('predictions').select('*')]);
  if(ds.error||ps.error||qs.error)throw Error((ds.error||ps.error||qs.error).message);
  return {room:roomId,player:playerId,code:roomCode,current:currentDriveId,number:driveNumber,ready:automaticReady,closed:driveClosed,deadline:predictionDeadline,drives:ds.data,players:ps.data,picks:qs.data,feed:document.getElementById('feedStatus').textContent,status:document.getElementById('driveStatus').textContent};
 });}
 async function enter(p,name,invite){
  await p.goto('https://nickhaney916-lang.github.io/Drive-Duel/'+(invite?'?room='+invite:''));
  await p.getByRole('textbox',{name:'Enter your name',exact:true}).fill(name);
  if(invite){await p.getByRole('button',{name:'Enter group',exact:true}).click();await expect(p.getByText('Room details',{exact:true})).toBeVisible();}
  await p.locator('.game[data-id="401872981"]').click({timeout:60000});
  await expect.poll(()=>p.evaluate(()=>Boolean(roomId&&automaticReady)),{timeout:45000}).toBe(true);
 }
 try{
  for(let i=0;i<2;i++){
   const c=await browsers[i].newContext({viewport:{width:i?390:1280,height:900}});
   const p=await c.newPage();pages.push(p);await enter(p,'Live Browser '+(i+1),i?code:null);
   const s=await sample(p);if(!i){room=s.room;code=s.code;first=s.current;}else{joinedId=s.player;expect(s.room).toBe(room);}
  }
  expect((await sample(pages[0])).player).not.toBe(joinedId);
  console.log('LIVE_ROOM',room,'GAME','401872981');
  const start=Date.now();let lastLog=0;
  while(Date.now()-start<420000){
   for(const p of pages)await expect(p.locator('#finalResultPanel')).toBeHidden();
   const a=await sample(pages[0]),b=await sample(pages[1]);
   if(a.current)seen.add(a.current);if(a.current&&a.current!==first)advanced=true;
   if(!locked&&a.ready&&!a.closed&&Date.parse(a.deadline)>Date.now()+2000&&await pages[0].getByRole('button',{name:'Punt',exact:true}).isEnabled()){
    await pages[0].getByRole('button',{name:'Punt',exact:true}).click();await pages[0].locator('#lockPick').click();
    await expect(pages[0].locator('#lockPick')).toHaveText('✓ Offense Pick Locked');
    locked=true;console.log('REAL_PICK_LOCKED',a.current);
   }
   if(advanced&&!rejoined){await enter(pages[1],'Live Browser 2',code);expect((await sample(pages[1])).player).toBe(joinedId);rejoined=true;console.log('REAL_REJOIN_PRESERVED_ID');}
   if(Date.now()-lastLog>15000){lastLog=Date.now();console.log('LIVE_SAMPLE',JSON.stringify({elapsed:Math.round((Date.now()-start)/1000),a:a.current,b:b.current,ready:a.ready,status:a.status,drives:a.drives.map(d=>({id:d.id,source:d.feed_drive_id,status:d.status,outcome:d.actual_outcome})),scores:a.players.map(p=>({id:p.id,cpu:p.is_cpu,score:p.score}))}));}
   if(advanced&&rejoined&&a.drives.some(d=>d.status==='scored')&&a.current===b.current)break;
   await pages[0].waitForTimeout(2000);
  }
  const a=await sample(pages[0]),b=await sample(pages[1]);expect(advanced,'observe an actual next possession').toBe(true);expect(a.drives.some(d=>d.status==='scored'),'observe actual completed drive scoring').toBe(true);
  await expect.poll(()=>pages[1].evaluate(()=>currentDriveId),{timeout:25000}).toBe(a.current);
  expect(a.picks.filter(p=>p.player_id===joinedId)).toHaveLength(0);expect(a.players.find(p=>p.id===joinedId).score).toBe(0);
  const map={'Force a punt':'Punt','Force a turnover':'Turnover','Stop on downs':'Stopped on downs','Hold to a field goal':'Field Goal','Allow a touchdown':'Touchdown','Other':'Other'};
  for(const player of a.players){
   const expected=a.picks.filter(p=>p.player_id===player.id).reduce((n,p)=>{
    const d=a.drives.find(d=>d.id===p.drive_id);if(!d||d.status!=='scored')return n;
    const result=p.prediction_type==='defense'?map[p.predicted_outcome]:p.predicted_outcome;
    return n+(result===d.actual_outcome?10+(d.actual_outcome==='Touchdown'&&d.conversion_success?2:0):0);
   },0);expect(player.score).toBe(expected);
  }
  await Promise.all(pages.map((p,i)=>p.screenshot({path:'test-results/real-live-browser-'+i+'.png',fullPage:true})));
  console.log('PASS_REAL_LIVE',JSON.stringify({room,possessions:seen.size,locked,rejoined,scored:a.drives.filter(d=>d.status==='scored').length,sameDrive:a.current===b.current,skippedPlayerScore:0}));
 }finally{await Promise.all(browsers.map(b=>b.close()));}
});