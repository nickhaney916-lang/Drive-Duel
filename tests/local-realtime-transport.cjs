// Integration test for actual local Supabase Postgres Changes delivery.
// It deliberately does not test Drive Duel scoring RPCs or production databases.
const {createClient}=require('@supabase/supabase-js');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const url=process.env.TEST_SUPABASE_URL;
const anon=process.env.TEST_SUPABASE_ANON_KEY;
const service=process.env.TEST_SUPABASE_SERVICE_KEY;
if(!url||!['127.0.0.1','localhost','::1'].includes(new URL(url).hostname)) throw Error('Refusing nonlocal Supabase');
if(!anon||!service) throw Error('Local credentials required');
const admin=createClient(url,service,{auth:{persistSession:false}});
const a=createClient(url,anon,{auth:{persistSession:false}});
const b=createClient(url,anon,{auth:{persistSession:false}});
const room='probe-'+randomUUID();
const channels=[];
const subscriptionTimeoutMs=20000;
const deliveryTimeoutMs=30000;
const realtimeDebug={a:[],b:[]};
function subscribe(client, label){
 return new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(Error('Supabase Realtime subscription timed out')),subscriptionTimeoutMs);
  const events=[];
  const channel=client.channel('probe-'+randomUUID())
   .on('postgres_changes',{event:'UPDATE',schema:'public',table:'realtime_probe',filter:`room_code=eq.${room}`},payload=>{
    if(payload.new.room_code===room){events.push(payload.new);console.log('Realtime event',label,JSON.stringify(payload.new));}
   }).subscribe(status=>{realtimeDebug[label].push(status);console.log('Realtime status',label,status);if(status==='SUBSCRIBED'){clearTimeout(timeout);resolve({events,channel});}if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'){clearTimeout(timeout);reject(Error(status));}});
  channels.push(channel);
 });
}
async function waitFor(fn,ms=deliveryTimeoutMs){const start=Date.now();while(Date.now()-start<ms){if(fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Realtime event delivery timeout');}
(async()=>{
 try{
  const [first,second]=await Promise.all([subscribe(a,'a'),subscribe(b,'b')]);
  const insert=await admin.from('realtime_probe').insert({room_code:room,revision:0,score:0}).select('id').single();
  if(insert.error)throw insert.error;
  // Give Realtime a moment to attach the database change stream after subscription.
  await new Promise(r=>setTimeout(r,1000));
  // Anonymous subscribers must not be allowed to modify authoritative scores.
  const unauthorized=await a.from('realtime_probe')
    .update({score:999,revision:99})
    .eq('id',insert.data.id)
    .select('id');
  assert.equal(unauthorized.data?.length ?? 0,0,'Anonymous score write unexpectedly succeeded');
  if(unauthorized.error && !['42501','PGRST301'].includes(unauthorized.error.code)) throw unauthorized.error;
  const before=await admin.from('realtime_probe').select('score,revision').eq('id',insert.data.id).single();
  if(before.error)throw before.error;
  assert.equal(before.data.score,0);
  assert.equal(before.data.revision,0);
  const change=await admin.from('realtime_probe').update({revision:1,score:10}).eq('id',insert.data.id).select('id,room_code,revision,score').single();
  if(change.error)throw change.error;
  assert.equal(change.data.room_code,room);
  assert.equal(change.data.revision,1);
  console.log('Authoritative database update confirmed',JSON.stringify(change.data));
  try{
    await waitFor(()=>first.events.some(e=>e.revision===1&&e.score===10)&&second.events.some(e=>e.revision===1&&e.score===10));
  }catch(error){
    console.error('Realtime delivery diagnostic',JSON.stringify({
      firstEvents:first.events,secondEvents:second.events,statuses:realtimeDebug,
      room,expectedRevision:1
    }));
    throw error;
  }
  // Revision guard rejects stale updates even if the score payload differs.
  const duplicate=await admin.from('realtime_probe').update({revision:2,score:20}).eq('id',insert.data.id).eq('revision',0).select('id');
  if(duplicate.error)throw duplicate.error;
  assert.equal(duplicate.data.length,0,'Stale revision unexpectedly accepted');
  const persistedOnce=await admin.from('realtime_probe').select('score,revision').eq('id',insert.data.id).single();
  if(persistedOnce.error)throw persistedOnce.error;
  assert.equal(persistedOnce.data.score,10);
  assert.equal(persistedOnce.data.revision,1);
  assert.equal(first.events.filter(e=>e.revision===1&&e.score===10).length,1,
    'First subscriber received a duplicate score event');
  assert.equal(second.events.filter(e=>e.revision===1&&e.score===10).length,1,
    'Second subscriber received a duplicate score event');
  assert.equal(first.events.at(-1).score,10);
  assert.equal(second.events.at(-1).score,10);
  const persisted=await admin.from('realtime_probe').select('score,revision').eq('id',insert.data.id).single();
  if(persisted.error)throw persisted.error;
  assert.equal(persisted.data.score,10);
  assert.equal(persisted.data.revision,1);
  console.log('PASS: real local Supabase Postgres Changes delivered the same score to two clients');
 }finally{
  await Promise.all(channels.map(c=>c.unsubscribe()));
  await Promise.all([a,b,admin].map(c=>c.removeAllChannels()));
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
