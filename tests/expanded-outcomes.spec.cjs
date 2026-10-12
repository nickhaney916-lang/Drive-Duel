const {test,expect}=require('@playwright/test');
test('simulated drive outcomes include uncommon endings and never guess unknown results',async()=>{
 const {outcomeFor,parseDriveSnapshot,conversionFor}=await import('../supabase/functions/drive-duel-live-feed/drive-parser.mjs');
 const cases=[['TD','Touchdown'],['FG','Field Goal'],['PUNT','Punt'],['PUNT TD','Punt'],['INT','Turnover'],['INT TD','Turnover'],['FUMBLE','Turnover'],['FUMBLE TD','Turnover'],['DOWNS','Stopped on downs'],['SAFETY','Safety'],['MISSED FG','Missed Field Goal'],['BLOCKED FG','Missed Field Goal'],['END OF HALF','End of half/game'],['END OF GAME','End of half/game']];
 for(const [result,outcome] of cases){
 expect(outcomeFor({result})).toBe(outcome);
 const plays=outcome==='Touchdown'?[{sequenceNumber:1,text:'Touchdown. Extra point is good.'}]:[];
 const snapshot=parseDriveSnapshot({header:{id:'sim',competitions:[{status:{type:{state:'in'}}}]},drives:{previous:[{id:'drive1',result,plays,start:{period:{number:1}}}],current:{id:'drive2',plays:[],start:{period:{number:2}}}}},'sim');
 expect(snapshot.completed[0].outcome).toBe(outcome);expect(snapshot.completed[0].confirmed).toBe(true);expect(snapshot.current.number).toBe(2);
 }
 expect(outcomeFor({result:'END OF QUARTER'})).toBeNull();expect(outcomeFor({result:'UNKNOWN'})).toBeNull();
 expect(conversionFor([{text:'Touchdown. Extra point no good.'}])).toBe(false);
 expect(conversionFor([{text:'Touchdown. Two-point conversion failed.'}])).toBe(false);
 expect(conversionFor([{text:'Touchdown. Two-point conversion is successful.'}])).toBe(true);
 expect(conversionFor([{text:'Touchdown reversed, no play. Extra point is good.'}])).toBeNull();
 const pending=parseDriveSnapshot({header:{id:'sim',competitions:[{status:{type:{state:'in'}}}]},drives:{previous:[{id:'td',result:'TD',plays:[{text:'Touchdown'}]}],current:null}},'sim');
 expect(pending.completed).toHaveLength(0);expect(pending.current.confirmed).toBe(false);
 expect(()=>parseDriveSnapshot({header:{id:'other'}},'sim')).toThrow();
});