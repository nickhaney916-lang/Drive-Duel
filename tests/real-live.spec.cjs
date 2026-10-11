const {test,expect,chromium}=require('@playwright/test');
const SITE='https://nickhaney916-lang.github.io/Drive-Duel/';
async function enter(p,name,game,invite){
 await p.goto(SITE+(invite?'?room='+invite:''));
 await p.getByRole('textbox',{name:'Enter your name',exact:true}).fill(name);
 if(invite){await p.getByRole('button',{name:'Enter group',exact:true}).click();await expect(p.getByText('Room details',{exact:true})).toBeVisible();}
 await p.locator('.game[data-id="'+game+'"]:visible').click({timeout:60000});
 await expect.poll(()=>p.evaluate(()=>Boolean(roomId&&selectedGame)),{timeout:30000}).toBe(true);
}
test('49ers prototype mobile create, invite, join and feed messages',async()=>{
 test.setTimeout(120000);const bs=await Promise.all([chromium.launch(),chromium.launch()]);const names=['Phone Host '+Date.now(),'Phone Guest '+Date.now()].map(n=>n.slice(0,24));
 try{
  const ps=await Promise.all(bs.map(b=>b.newPage({viewport:{width:390,height:844}})));
  await enter(ps[0],names[0],'401872992');const a=await ps[0].evaluate(()=>({room:roomId,player:playerId,code:roomCode,game:selectedGame.id}));
  expect(a.code).toMatch(/^[A-Z0-9]{6}$/);
  await expect.poll(()=>ps[0].evaluate(()=>players.some(p=>p.is_cpu)),{timeout:20000}).toBe(true);
  await expect(ps[0].locator('#trackerTitle')).toContainText('49ers');
  await ps[0].locator('#back').click();
  await expect(ps[0].locator('#roomLinkDisplay')).toHaveValue(SITE+'?room='+a.code);
  await enter(ps[1],names[1],'401872992',a.code);
  const b=await ps[1].evaluate(()=>({room:roomId,player:playerId,game:selectedGame.id}));
  expect(b.room).toBe(a.room);expect(b.player).not.toBe(a.player);expect(b.game).toBe(a.game);
  for(const p of ps){
   await expect(p.locator('#finalResultPanel')).toBeHidden();await expect(p.locator('#nextDrive')).toBeHidden();
   await expect(p.getByRole('button',{name:'Touchdown',exact:true})).toBeDisabled();
   expect(await p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  }
  await Promise.all(ps.map((p,i)=>p.screenshot({path:'test-results/49ers-phone-'+i+'.png',fullPage:true})));
  console.log('PASS_49ERS_PHONE',JSON.stringify({room:a.room,code:a.code,sameGame:b.game,distinctPlayers:true,cpu:true,noOverflow:true}));
 }finally{await Promise.all(bs.map(b=>b.close()));}
});
test('real live prediction windows and scoring with two browsers',async()=>{
 test.setTimeout(600000);const bs=await Promise.all([chromium.launch(),chromium.launch()]);const ps=[];const names=['Window A '+Date.now(),'Window B '+Date.now()];
 let code,room,ids=[],lockedDrives=new Set(),windowDrives=new Set(),scoredPick=false,positive=false;
 async function sample(p){return p.evaluate(async()=>{
  const [d,p,q]=await Promise.all([db.from('drives').select('*').eq('room_id',roomId),db.from('players').select('*').eq('room_id',roomId),db.from('predictions').select('*')]);
  if(d.error||p.error||q.error)throw Error((d.error||p.error||q.error).message);
  return {room:roomId,player:playerId,code:roomCode,current:currentDriveId,ready:automaticReady,deadline:predictionDeadline,closed:feedClosed,drives:d.data,players:p.data,picks:q.data,feed:document.getElementById('feedStatus').textContent,status:document.getElementById('driveStatus').textContent};
 });}
 try{
  for(let i=0;i<2;i++){const p=await bs[i].newPage({viewport:{width:390,height:844}});ps.push(p);await enter(p,names[i],'401872981',code);const s=await sample(p);room=s.room;code=s.code;ids.push(s.player);}
  console.log('WINDOW_ROOM',room,code);
  const start=Date.now();let logAt=0;
  while(Date.now()-start<480000){
   const samples=await Promise.all(ps.map(sample));
   for(let i=0;i<2;i++){
    const s=samples[i];if(s.current&&s.deadline>Date.now())windowDrives.add(s.current);
    if(s.ready&&!s.closed&&s.deadline>Date.now()+1500&&await ps[i].getByRole('button',{name:i?'Punt':'Touchdown',exact:true}).isEnabled()){
     if(!(await ps[i].locator('#lockPick').innerText()).includes('Locked')){
      await ps[i].getByRole('button',{name:i?'Punt':'Touchdown',exact:true}).click();await ps[i].locator('#lockPick').click();
      await expect(ps[i].locator('#lockPick')).toHaveText('✓ Offense Pick Locked');lockedDrives.add(s.current);console.log('REAL_WINDOW_LOCK',i,s.current);
     }
     if(s.deadline>Date.now()+1500){
      await ps[i].locator('#defenseTab').click();
      const pick=ps[i].getByRole('button',{name:i?'Hold to a field goal':'Force a turnover',exact:true});
      if(await pick.isEnabled()&&!(await ps[i].locator('#lockPick').innerText()).includes('Locked')){await pick.click();await ps[i].locator('#lockPick').click();await expect(ps[i].locator('#lockPick')).toHaveText('✓ Defense Pick Locked');}
      await ps[i].locator('#offenseTab').click();
     }
    }
   }
   const a=await sample(ps[0]);scoredPick=a.drives.some(d=>d.status==='scored'&&a.picks.some(q=>q.drive_id===d.id&&ids.includes(q.player_id)));
   positive=a.players.some(p=>ids.includes(p.id)&&p.score>0);
   if(Date.now()-logAt>15000){logAt=Date.now();console.log('WINDOW_SAMPLE',JSON.stringify({elapsed:Math.round((Date.now()-start)/1000),current:a.current,status:a.status,ready:a.ready,deadline:a.deadline,locked:[...lockedDrives],drives:a.drives.map(d=>({id:d.id,source:d.feed_drive_id,status:d.status,outcome:d.actual_outcome})),scores:a.players.map(p=>({id:p.id,score:p.score}))}));}
   if(scoredPick)break;await ps[0].waitForTimeout(1000);
  }
  const a=await sample(ps[0]);console.log('WINDOW_OBSERVATION',JSON.stringify({room,windows:windowDrives.size,locked:lockedDrives.size,scoredPick,positive}));
  expect(lockedDrives.size,'a real prediction window must allow locking').toBeGreaterThan(0);
  expect(scoredPick,'a locked real prediction must reach automatic scoring').toBe(true);
  const map={'Force a punt':'Punt','Force a turnover':'Turnover','Stop on downs':'Stopped on downs','Hold to a field goal':'Field Goal','Allow a touchdown':'Touchdown','Other':'Other'};
  for(const id of ids){
   const points=a.picks.filter(p=>p.player_id===id).reduce((n,p)=>{const d=a.drives.find(d=>d.id===p.drive_id);if(d?.status!=='scored')return n;const outcome=p.prediction_type==='defense'?map[p.predicted_outcome]:p.predicted_outcome;return n+(outcome===d.actual_outcome?10+(d.actual_outcome==='Touchdown'&&d.conversion_success?2:0):0);},0);
   expect(a.players.find(p=>p.id===id).score).toBe(points);
  }
  await Promise.all(ps.map((p,i)=>p.screenshot({path:'test-results/live-window-'+i+'.png',fullPage:true})));
  console.log('PASS_LIVE_WINDOW',JSON.stringify({room,locked:lockedDrives.size,scoredPick,positive}));
 }finally{await Promise.all(bs.map(b=>b.close()));}
});