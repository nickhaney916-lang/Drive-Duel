const {test,expect,chromium}=require('@playwright/test');
const APP_URL=process.env.TEST_URL||'http://127.0.0.1:8000';
test('any player creates separate groups with unique codes and can resume the original group',async()=>{
 test.setTimeout(90000);
 const browsers=await Promise.all([chromium.launch(),chromium.launch()]);
 const a=await browsers[0].newPage(),b=await browsers[1].newPage();a.setDefaultTimeout(20000);b.setDefaultTimeout(20000);
 try{
 console.log('GROUP TEST: open first browser');await a.goto(APP_URL,{waitUntil:'domcontentloaded',timeout:30000});await a.locator('#playerName').fill('Group Creator');await a.locator('#createNewGroup').click();
 await expect(a.locator('#groupConnected')).toBeVisible();
 const first=await a.evaluate(()=>({id:roomId,code:roomCode,player:playerId}));
 expect(first.code).toMatch(/^[A-Z2-9]{6}$/);
 console.log('GROUP TEST: join original group');await b.goto(APP_URL+'?room='+first.code,{waitUntil:'domcontentloaded',timeout:30000});await b.locator('#playerName').fill('Original Group Friend');await b.locator('#joinRoom').click();
 await expect.poll(()=>b.evaluate(()=>roomId)).toBe(first.id);
 console.log('GROUP TEST: create separate group');await a.locator('#groupSwitch').click();await a.locator('#createNewGroupRoom').click();await expect.poll(()=>a.evaluate(()=>roomId)).not.toBe(first.id);
 const second=await a.evaluate(()=>({id:roomId,code:roomCode}));
 expect(second.code).not.toBe(first.code);
 await expect(a.locator('#playerList')).not.toContainText('Original Group Friend');
 await expect.poll(()=>b.evaluate(()=>roomId)).toBe(first.id);
 const denied=await b.evaluate(async r=>{await ensureAuth();const answer=await db.rpc('drive_duel_group_standings',{p_room_id:r});return answer.error?.message;},second.id);
 expect(denied).toContain('Group membership required');
 console.log('GROUP TEST: resume original group');await a.locator('#groupSwitch').click();await a.locator('#joinAnotherGroupRoom').click();
 await a.locator('#recentGroups').getByRole('button',{name:'Resume '+first.code,exact:true}).click();
 await expect.poll(()=>a.evaluate(()=>roomId)).toBe(first.id);
 expect(await a.evaluate(()=>playerId)).toBe(first.player);
 await expect(a.locator('#playerList')).toContainText('Original Group Friend');
 await a.reload({waitUntil:'domcontentloaded'});await expect.poll(()=>a.evaluate(()=>roomId)).toBe(first.id);await expect(a.locator('#home #leaderCards')).toBeVisible();await expect(a.locator('#leaderCardsGroup')).toHaveText('Group '+first.code);await expect(a.locator('#home')).toBeVisible();expect(await a.evaluate(()=>selectedGame)).toBeNull();
 }finally{await Promise.all(browsers.map(b=>b.close()));}
});