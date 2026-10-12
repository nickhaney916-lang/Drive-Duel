const {test,expect,chromium}=require('@playwright/test');
const APP_URL=process.env.TEST_URL||'http://127.0.0.1:8000';
test('real realtime subscribers receive simulated scoring without polling',async()=>{
 test.skip(process.env.RUN_REALTIME_LOAD_PROBE!=='1','Run with the explicit load-test flag');
 test.setTimeout(240000);const browsers=await Promise.all([chromium.launch(),chromium.launch()]);
 const pages=await Promise.all(browsers.map(b=>b.newPage()));
 const game='load-realtime-20261012',tag='RTLoad-'+(process.env.GITHUB_SHA||Date.now().toString()).slice(0,10),date=new Date().toISOString();
 const fixture={id:game,name:'Realtime Away at Realtime Home',date,status:{type:{state:'in'}},competitions:[{competitors:[{homeAway:'away',score:'0',team:{shortDisplayName:'Realtime Away'}},{homeAway:'home',score:'0',team:{shortDisplayName:'Realtime Home'}}]}]};
 try{
 for(const p of pages)await p.route('**/functions/v1/drive-duel-live-feed',route=>{
 const body=route.request().postDataJSON();return route.fulfill({json:body.operation==='schedule'?{ok:true,events:[fixture]}:{ok:true,scoringSafe:true,data:{away:'Realtime Away',home:'Realtime Home',awayScore:0,homeScore:0,state:'in',status:'Synthetic realtime game',period:1,clock:'10:00',possession:'Realtime Away',lastPlay:'Synthetic probe',fetchedAt:new Date().toISOString(),automatic:{pending:false}}}});
 });
 const [a,b]=pages;await a.goto(APP_URL);await a.locator('#playerName').fill(tag);await a.locator('#createNewGroup').click();await expect(a.locator('#groupConnected')).toBeVisible();
 const saved=await a.evaluate(()=>({room:roomId,code:roomCode}));
 console.log('REALTIME PROBE READY '+JSON.stringify({tag,...saved,game}));
 await b.goto(APP_URL+'?room='+saved.code);await b.locator('#playerName').fill(tag+'B');await b.locator('#joinRoom').click();await expect(b.locator('#groupConnected')).toBeVisible();
 for(const p of pages){await p.getByRole('button',{name:/Realtime Away.*Realtime Home/}).click();await expect.poll(()=>p.evaluate(()=>currentDriveId),{timeout:180000}).not.toBeNull();await expect(p.locator('#realtimeStatus'),{timeout:20000}).toContainText('CONNECTED');}
 for(const p of pages){await p.evaluate(()=>{clearInterval(roomPollTimer);clearInterval(refreshTimer);});await p.getByRole('button',{name:'Punt',exact:true}).click();await p.locator('#lockPick').click();await p.locator('#defenseTab').click();await p.getByRole('button',{name:'Force a punt',exact:true}).click();await p.locator('#lockPick').click();}
 console.log('REALTIME PROBE PICKS READY '+tag);
 for(const p of pages){await expect.poll(()=>p.evaluate(()=>playerGameScore(playerId)),{timeout:180000}).toBe(20);await expect.poll(()=>p.evaluate(()=>driveNumber)).toBe(2);}
 console.log('PASS REALTIME: actual database score and drive events reached both independent browsers with polling disabled; '+tag);
 }finally{await Promise.all(browsers.map(b=>b.close()));}
});