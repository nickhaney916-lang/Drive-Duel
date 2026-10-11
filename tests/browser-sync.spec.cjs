const { test, expect, chromium } = require('@playwright/test');
test('two independent browsers synchronize three drives', async () => {
  test.setTimeout(180000);
  const browsers = await Promise.all([chromium.launch(), chromium.launch()]);
  const contexts = await Promise.all(browsers.map((b,i)=>b.newContext({viewport:{width:i?390:1280,height:900}})));
  const pages = await Promise.all(contexts.map(c=>c.newPage()));
  const gameId='sync-ui-'+Date.now();
  const fixture={id:gameId,name:'Sync Away at Sync Home',date:new Date().toISOString(),status:{type:{state:'in',detail:'Test drive'}},competitions:[{competitors:[{homeAway:'away',score:'0',team:{shortDisplayName:'Sync Away'}},{homeAway:'home',score:'0',team:{shortDisplayName:'Sync Home'}}]}]};
  for(const c of contexts){
    await c.route('**/site.api.espn.com/**',r=>r.fulfill({json:{events:[fixture]}}));
    await c.route('**/functions/v1/drive-duel-live-feed',r=>r.fulfill({json:{ok:true,data:{away:'Sync Away',home:'Sync Home',awayScore:0,homeScore:0,status:'Simulated test drive',state:'in',period:1,clock:'12:00',fetchedAt:new Date().toISOString()}}}));
  }
  const [a,b]=pages, url='https://nickhaney916-lang.github.io/Drive-Duel/';
  const snapshot=p=>p.evaluate(()=>({playerId,roomId,driveId:currentDriveId,drive:driveNumber,scored:driveScored,picks:{...chosenPicks},locked:{...lockedTypes},scores:players.filter(p=>!p.is_cpu).map(p=>({id:p.id,score:p.score})).sort((x,y)=>x.id.localeCompare(y.id))}));
  const open=async p=>{await p.getByRole('button',{name:/Sync Away.*Sync Home/}).click();await expect.poll(async()=> (await snapshot(p)).driveId).toBeTruthy();};
  try {
    await a.goto(url);
    await a.getByRole('textbox',{name:'Enter your name',exact:true}).fill('Browser A');
    await open(a);
    const code=await a.evaluate(()=>roomCode);
    await b.goto(url+'?room='+code);
    await b.getByRole('textbox',{name:'Enter your name',exact:true}).fill('Browser B');
    await b.getByRole('button',{name:'Enter group',exact:true}).click();
    await expect(b.getByText('Room details',{exact:true})).toBeVisible();
    await open(b);
    await expect.poll(async()=> (await snapshot(a)).scores.length).toBe(2);
    const firstA=await snapshot(a),firstB=await snapshot(b);
    expect(firstA.playerId).not.toBe(firstB.playerId);
    expect(firstA.roomId).toBe(firstB.roomId);
    console.log('PASS: distinct browser processes, separate storage and separate player IDs; room '+code);
    for(let n=1;n<=3;n++){
      await expect.poll(async()=> (await snapshot(a)).drive).toBe(n);
      await expect.poll(async()=> (await snapshot(b)).drive).toBe(n);
      expect((await snapshot(a)).driveId).toBe((await snapshot(b)).driveId);
      await a.getByRole('button',{name:'Punt',exact:true}).click();
      await a.locator('#lockPick').click();
      await expect(a.locator('#lockPick')).toHaveText('✓ Offense Pick Locked');
      if(n!==2){
        await b.getByRole('button',{name:n===3?'Punt':'Turnover',exact:true}).click();
        await b.locator('#lockPick').click();
        await expect(b.locator('#lockPick')).toHaveText('✓ Offense Pick Locked');
        expect((await snapshot(b)).picks.offense).toBe(n===3?'Punt':'Turnover');
      }else{
        expect((await snapshot(b)).locked.offense).toBe(false);
      }
      await expect(a.getByRole('button',{name:'Touchdown',exact:true})).toBeDisabled();
      for(const p of pages)await p.locator('#actualOutcome').selectOption('Punt');
      const clicked=await Promise.allSettled(pages.map(p=>p.locator('#scoreDrive').click({timeout:5000})));
      expect(clicked.some(x=>x.status==='fulfilled')).toBe(true);
      for(const p of pages)await expect.poll(async()=> (await snapshot(p)).scored).toBe(true);
      const expectedA=n*10,expectedB=n===3?10:0;
      for(const p of pages){
        await expect.poll(async()=>{const s=await snapshot(p);return s.scores.find(x=>x.id===firstA.playerId)?.score;}).toBe(expectedA);
        await expect.poll(async()=>{const s=await snapshot(p);return s.scores.find(x=>x.id===firstB.playerId)?.score;}).toBe(expectedB);
        await expect(p.getByRole('button',{name:'Touchdown',exact:true})).toBeDisabled();
      }
      expect((await snapshot(a)).scores).toEqual((await snapshot(b)).scores);
      console.log('PASS round '+n+': shared drive, independent picks, synchronized scores '+expectedA+'/'+expectedB+', no duplicate award'+(n===2?', skipped pick earns zero':''));
      await Promise.all(pages.map((p,i)=>p.screenshot({path:'test-results/round-'+n+'-browser-'+i+'.png',fullPage:true})));
      if(n<3){
        await a.getByRole('button',{name:'Next drive',exact:true}).click();
        await expect.poll(async()=> (await snapshot(b)).drive).toBe(n+1);
      }
    }
    await b.reload();
    await b.getByRole('textbox',{name:'Enter your name',exact:true}).fill('Browser B');
    await b.getByRole('button',{name:'Enter group',exact:true}).click();
    await expect(b.getByText('Room details',{exact:true})).toBeVisible();
    await open(b);
    await expect.poll(async()=> (await snapshot(b)).drive).toBe(3);
    expect((await snapshot(b)).playerId).toBe(firstB.playerId);
    await expect.poll(async()=> (await snapshot(b)).scores).toEqual((await snapshot(a)).scores);
    console.log('PASS: refresh/rejoin restores same player, latest shared drive and scores');
  } finally {
    await Promise.all(browsers.map(x=>x.close()));
  }
});
