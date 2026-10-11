const { test, expect, chromium } = require('@playwright/test');
const URL='https://nickhaney916-lang.github.io/Drive-Duel/';
test('real live feed updates automatically without Refresh click',async()=>{
  const browser=await chromium.launch();const p=await browser.newPage();
  const replies=[];
  p.on('response',async r=>{if(r.url().includes('/functions/v1/drive-duel-live-feed')){try{replies.push(await r.json());}catch{}}});
  try{
    await p.goto(URL);
    await p.getByRole('textbox',{name:'Enter your name',exact:true}).fill('Live Feed Test');
    await p.locator('#games .game').first().click();
    await expect.poll(()=>replies.filter(x=>x.ok&&x.data).length,{timeout:45000}).toBeGreaterThanOrEqual(2);
    await expect(p.locator('#feedStatus')).toHaveAttribute('data-verified','true');
    const data=replies.filter(x=>x.ok&&x.data).at(-1).data;
    await expect(p.locator('#awayScore')).toHaveText(String(data.awayScore));
    await expect(p.locator('#homeScore')).toHaveText(String(data.homeScore));
    await expect(p.locator('#gameStatus')).toHaveText(data.status);
    console.log('PASS: real backend live feed automatically refreshed twice; displayed score/status match its response. '+JSON.stringify({away:data.away,home:data.home,score:[data.awayScore,data.homeScore],status:data.status,clock:data.clock,possession:data.possession,lastPlay:data.lastPlay}));
    await p.screenshot({path:'test-results/real-live-feed.png',fullPage:true});
  }finally{await browser.close();}
});
test('confirmed drive ending automatically scores and opens next drive',async()=>{
  const browser=await chromium.launch();const c=await browser.newContext();const p=await c.newPage();
  const id='automatic-flow-test-'+Date.now();let ended=false,feedCalls=0;
  const headers={'access-control-allow-origin':'*','access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'authorization, apikey, content-type, x-client-info'};
  const fixture={id,name:'Auto Away at Auto Home',date:new Date().toISOString(),status:{type:{state:'in',detail:'Test drive'}},competitions:[{competitors:[{homeAway:'away',score:'0',team:{shortDisplayName:'Auto Away'}},{homeAway:'home',score:'0',team:{shortDisplayName:'Auto Home'}}]}]};
  await c.route('**/site.api.espn.com/**',r=>r.fulfill({headers,json:{events:[fixture]}}));
  await c.route('**/functions/v1/drive-duel-live-feed',r=>{if(r.request().method()!=='OPTIONS')feedCalls++;return r.fulfill({headers,json:{ok:true,data:{away:'Auto Away',home:'Auto Home',awayScore:0,homeScore:0,status:'Simulated live drive',state:'in',period:1,clock:ended?'10:00':'12:00',possession:ended?'Auto Home':'Auto Away',lastPlay:ended?'Punt. Previous drive confirmed complete.':'First down',driveId:ended?'fixture-drive-2':'fixture-drive-1',completedDrives:ended?[{id:'fixture-drive-1',result:'Punt',confirmed:true}]:[],fetchedAt:new Date().toISOString()}}});});
  try{
    await p.goto(URL);await p.getByRole('textbox',{name:'Enter your name',exact:true}).fill('Auto Flow Test');
    await p.getByRole('button',{name:/Auto Away.*Auto Home/}).click();
    await expect.poll(()=>p.evaluate(()=>currentDriveId)).toBeTruthy();
    await p.getByRole('button',{name:'Punt',exact:true}).click();await p.locator('#lockPick').click();
    await expect(p.locator('#lockPick')).toHaveText('✓ Offense Pick Locked');
    ended=true;
    await expect(p.locator('#possession'),{timeout:30000}).toHaveText('Auto Home');
    await expect(p.locator('#lastPlay')).toContainText('confirmed complete');
    const result=await p.evaluate(()=>({drive:driveNumber,scored:driveScored,score:players.find(x=>x.id===playerId)?.score,nextEnabled:!document.getElementById('nextDrive').disabled}));
    console.log('AUTOMATIC FLOW OBSERVATION: '+JSON.stringify({...result,automaticFeedCalls:feedCalls}));
    await p.screenshot({path:'test-results/automatic-drive-ending.png',fullPage:true});
    expect(result.score,'confirmed Punt must automatically award 10 points').toBe(10);
    expect(result.drive,'next drive must automatically open').toBe(2);
  }finally{await browser.close();}
});
