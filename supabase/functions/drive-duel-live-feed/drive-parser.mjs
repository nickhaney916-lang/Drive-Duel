// Parse authoritative ESPN drive records. Never infer an outcome from a score delta.
export function outcomeFor(drive) {
  const result=String(drive.result||drive.displayResult||'').trim().toUpperCase();
  if (/^(TD|TOUCHDOWN)$/.test(result)) return 'Touchdown';
  if (/^(FG|FIELD GOAL)$/.test(result)) return 'Field Goal';
  if (/^PUNT(?: TD| TOUCHDOWN)?$/.test(result)) return 'Punt';
  if (/^(INT|INTERCEPTION|FUMBLE|TURNOVER)(?: TD| TOUCHDOWN)?$/.test(result)) return 'Turnover';
  if (/^(DOWNS|TURNOVER ON DOWNS)$/.test(result)) return 'Stopped on downs';
  if (/^(MISSED FG|MISSED FIELD GOAL|BLOCKED FG|BLOCKED FIELD GOAL)$/.test(result)) return 'Missed Field Goal';
  if (/^(END OF HALF|END OF GAME)$/.test(result)) return 'End of half/game';
  if (/^SAFETY$/.test(result)) return 'Safety';
  return null;
}
export function conversionFor(plays) {
  // ESPN commonly includes the PAT sentence in the touchdown play itself.
  for (const play of [...plays].reverse()) {
    const text=String(play.text||'');
    if (/no play|play overturned|touchdown reversed/i.test(text)) continue;
    const conversion=text.match(/(?:extra point|two[- ]point conversion|2[- ]point conversion|two[- ]point attempt|2[- ]point attempt|two[- ]point pass|two[- ]point rush)[\s\S]*/i)?.[0];
    if (conversion && /no good|not good|failed|fails|missed|unsuccessful|blocked/i.test(conversion)) return false;
    if (conversion && /is good|succeeds|successful|successfully|for two points|for 2 points/i.test(conversion)) return true;
    const type=String(play.type?.text||'');
    if (/extra point|two[- ]point|2[- ]point/i.test(type)) {
      if (/missed|failed|blocked|no good/i.test(type)) return false;
      if (/good|successful/i.test(type)) return true;
    }
  }
  return null;
}
export function parseDriveSnapshot(summary,eventId,now=new Date()) {
  if (String(summary.header?.id)!==String(eventId)) throw Error('Summary event identity mismatch');
  const competition=summary.header?.competitions?.[0];
  if (!competition) throw Error('Summary competition missing');
  const status=competition.status||summary.header.status||{};
  const state=status.type?.state||'unknown';
  const previous=summary.drives?.previous;
  const current=summary.drives?.current;
  if (!Array.isArray(previous)) {
    if(state==='pre') return {revision:0,state,current:null,completed:[],available:true};
    return {revision:0,state,current:null,completed:[],available:false};
  }
  const records=[...previous];
  if(current?.id&&!records.some(d=>String(d.id)===String(current.id)))records.push(current);
  const ids=new Set();let revision=0;
  const completed=[];let active=null;
  for(let i=0;i<records.length;i++) {
    const d=records[i],id=String(d.id||'');
    if(!id||ids.has(id))throw Error('Missing or duplicate source drive ID');
    ids.add(id);
    const plays=d.plays||[];
    for(const p of plays)revision=Math.max(revision,Number(p.sequenceNumber)||0);
    const outcome=outcomeFor(d);
    const conversion=outcome==='Touchdown'?conversionFor(plays):null;
    const isPrevious=previous.some(p=>String(p.id)===id);
    // A completed drive must appear in drive history, not merely a live scoring play.
    const confirmed=isPrevious&&outcome!==null&&(outcome!=='Touchdown'||conversion!==null);
    const offensivePlay=plays.find(p=>/rush|pass|sack|kneel|spike/i.test(p.type?.text||'')&&!/extra point|two.point|2.point|kickoff/i.test(p.type?.text||'')&&!/no play/i.test(p.text||''));
    const firstPlayAt=offensivePlay?.wallclock&&Number.isFinite(Date.parse(offensivePlay.wallclock))?new Date(offensivePlay.wallclock).toISOString():null;
    const row={source_id:id,number:i+1,quarter:Math.min(5,Math.max(1,Number(d.start?.period?.number)||1)),outcome,conversion_success:conversion,confirmed,terminal:outcome!==null,first_play_at:firstPlayAt,plays:Number(d.offensivePlays)||0,team:d.team?.displayName||''};
    if(confirmed)completed.push(row);
    if(!confirmed && (id===String(current?.id)||i===records.length-1))active=row;
  }
  if(state==='post'&&active&&!active.terminal)active={...active,terminal:true};
  return {revision,state,current:active,completed,available:true,fetched_at:now.toISOString()};
}
