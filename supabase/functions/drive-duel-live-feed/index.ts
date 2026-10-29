import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { parseDriveSnapshot } from "./drive-parser.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });
const timeoutFetch = async (url: string, ms = 3500) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal, headers: { "accept": "application/json", "user-agent": "DriveDuel/1.0" } });
  } finally { clearTimeout(timer); }
};
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
function findEvent(data: any, id: string, awayName: string, homeName: string) {
  const events = data?.events ?? data?.content?.events ?? [];
  return events.find((e: any) => String(e.id) === id) ??
    events.find((e: any) => {
      const cs = e.competitions?.[0]?.competitors ?? [];
      const a = cs.find((c: any) => c.homeAway === "away") ?? cs[1];
      const h = cs.find((c: any) => c.homeAway === "home") ?? cs[0];
      return norm(a?.team?.displayName ?? a?.team?.name).includes(norm(awayName)) &&
        norm(h?.team?.displayName ?? h?.team?.name).includes(norm(homeName));
    });
}
function normalize(event: any, provider: string) {
  const comp = event.competitions?.[0] ?? {};
  const cs = comp.competitors ?? [];
  const away = cs.find((c: any) => c.homeAway === "away") ?? cs[1] ?? {};
  const home = cs.find((c: any) => c.homeAway === "home") ?? cs[0] ?? {};
  const status = event.status ?? {};
  const situation = comp.situation ?? {};
  const possessionId = String(situation.possession ?? "");
  const possessionTeam = cs.find((c: any) => String(c.id) === possessionId || String(c.team?.id) === possessionId);
  return {
    provider,
    eventId: String(event.id ?? ""),
    name: event.name ?? "",
    away: away.team?.displayName ?? away.team?.shortDisplayName ?? "Away",
    home: home.team?.displayName ?? home.team?.shortDisplayName ?? "Home",
    awayScore: Number(away.score ?? 0),
    homeScore: Number(home.score ?? 0),
    state: status.type?.state ?? "unknown",
    status: status.type?.detail ?? status.type?.shortDetail ?? status.type?.description ?? "Status unavailable",
    period: Number(status.period ?? 0),
    clock: status.displayClock ?? "",
    possession: possessionTeam?.team?.displayName ?? situation.possessionText ?? "",
    downDistance: situation.downDistanceText ?? "",
    fieldPosition: situation.yardLine ?? situation.possessionText ?? "",
    lastPlay: comp.notes?.[0]?.headline ?? "",
    startDate: event.date ?? null,
    fetchedAt: new Date().toISOString(),
  };
}
function nflAlias(s: unknown) {
  const n = norm(s);
  const aliases: Record<string,string> = {
    arizona:"ari",cardinals:"ari",arizonacardinals:"ari",
    atlanta:"atl",falcons:"atl",atlantafalcons:"atl",
    baltimore:"bal",ravens:"bal",baltimoreravens:"bal",
    buffalo:"buf",bills:"buf",buffalobills:"buf",
    carolina:"car",panthers:"car",carolinapanthers:"car",
    chicago:"chi",bears:"chi",chicagobears:"chi",
    cincinnati:"cin",bengals:"cin",cincinnatibengals:"cin",
    cleveland:"cle",browns:"cle",clevelandbrowns:"cle",
    dallas:"dal",cowboys:"dal",dallascowboys:"dal",
    denver:"den",broncos:"den",denverbroncos:"den",
    detroit:"det",lions:"det",detroitlions:"det",
    greenbay:"gb",packers:"gb",greenbaypackers:"gb",
    houston:"hou",texans:"hou",houstontexans:"hou",
    indianapolis:"ind",colts:"ind",indianapoliscolts:"ind",
    jacksonville:"jax",jaguars:"jax",jacksonvillejaguars:"jax",
    kansascity:"kc",chiefs:"kc",kansascitychiefs:"kc",
    lasvegas:"lv",raiders:"lv",lasvegasraiders:"lv",
    chargers:"lac",losangeleschargers:"lac",
    rams:"lar",losangelesrams:"lar",
    miami:"mia",dolphins:"mia",miamidolphins:"mia",
    minnesota:"min",vikings:"min",minnesotavikings:"min",
    newengland:"ne",patriots:"ne",newenglandpatriots:"ne",
    neworleans:"no",saints:"no",neworleanssaints:"no",
    giants:"nyg",newyorkgiants:"nyg",
    jets:"nyj",newyorkjets:"nyj",
    philadelphia:"phi",eagles:"phi",philadelphiaeagles:"phi",
    pittsburgh:"pit",steelers:"pit",pittsburghsteelers:"pit",
    sanfrancisco:"sf","49ers":"sf",sanfrancisco49ers:"sf",
    seattle:"sea",seahawks:"sea",seattleseahawks:"sea",
    tampabay:"tb",buccaneers:"tb",bucs:"tb",tampabaybuccaneers:"tb",
    tennessee:"ten",titans:"ten",tennesseetitans:"ten",
    washington:"was",commanders:"was",washingtoncommanders:"was"
  };
  return aliases[n] ?? n;
}
function findNflStaticGame(payload: any, awayName: string, homeName: string) {
  const seen = new Set<any>(), candidates: any[] = [];
  const walk = (value: any, depth: number) => {
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const v of value) walk(v,depth+1); return; }
    const home=value.home??value.homeTeam??value.h, away=value.away??value.awayTeam??value.v??value.visitor;
    if(home&&away)candidates.push(value);
    for(const v of Object.values(value))if(typeof v==="object")walk(v,depth+1);
  };
  walk(payload,0);
  const code=(x:any)=>nflAlias(typeof x==="string"?x:x?.abbr??x?.abbreviation??x?.teamAbbr??x?.name??x?.teamName??x?.displayName);
  return candidates.find(g=>code(g.away??g.awayTeam??g.v??g.visitor)===nflAlias(awayName)&&code(g.home??g.homeTeam??g.h)===nflAlias(homeName));
}
function normalizeNflStatic(g: any, awayName: string, homeName: string) {
  const a=g.away??g.awayTeam??g.v??g.visitor, h=g.home??g.homeTeam??g.h;
  const score=(t:any)=>Number(t?.score??t?.pts??t?.points??t?.Score??0);
  const teamName=(t:any,fallback:string)=>String(t?.abbr??t?.abbreviation??t?.teamAbbr??t?.name??t?.teamName??t?.displayName??fallback);
  const status=String(g?.status??g?.gameStatus??g?.phase??"Scoreboard update");
  return {provider:"NFL live scores (backup)",eventId:String(g?.eid??g?.id??g?.gameId??""),name:awayName+" at "+homeName,
    away:awayName,home:homeName,awayScore:score(a),homeScore:score(h),state:/final|complete/i.test(status)?"post":/progress|live|in progress|q[1-4]|halftime/i.test(status)?"in":"unknown",
    status,period:Number(g?.quarter??g?.qtr??g?.period??0),clock:String(g?.clock??g?.time??""),possession:"",downDistance:"",fieldPosition:"",lastPlay:"",
    startDate:g?.date??g?.startTime??null,fetchedAt:new Date().toISOString(),partial:true};
}

// Independent, scores-only backup. Its free tier can return partial schedules;
// it MUST NOT drive possession locks, scoring, or server-side drive advancement.
const sportsDbBase="https://www.thesportsdb.com/api/v1/json/123/";
function sportsDbState(value: any) {
 const status=String(value?.strStatus||value?.strProgress||"NS");
 return /^(FT|AOT)$|final|finished/i.test(status)?"post":/^(Q[1-4]|OT|HT)$|in play|halftime/i.test(status)?"in":"pre";
}
function nflSportsDb(e: any) {
 return !!e && (String(e.strLeague)==="NFL" || String(e.idLeague)==="4391");
}
function nflSportsDbMatch(e: any, away: string, home: string) {
 return nflSportsDb(e) && nflAlias(e.strAwayTeam)===nflAlias(away) && nflAlias(e.strHomeTeam)===nflAlias(home);
}
function sportsDbDate(e: any) {
 const input=String(e.strTimestamp||((e.dateEvent||"")+"T"+(e.strTime||"00:00:00")));
 return /^\d{4}-\d{2}-\d{2}T/.test(input)?(/[zZ]|[+-]\d{2}:?\d{2}$/.test(input)?input:input+"Z"):null;
}
function sportsDbScheduleEvent(e: any) {
 if(!nflSportsDb(e)||!e.idEvent||!e.strHomeTeam||!e.strAwayTeam)return null;
 const date=sportsDbDate(e);if(!date)return null;
 const status=String(e.strStatus||e.strProgress||"Scheduled");
 return {id:"tsdb-"+e.idEvent,name:e.strAwayTeam+" at "+e.strHomeTeam,date,source:"TheSportsDB",partial:true,
  status:{type:{state:sportsDbState(e),detail:status}},
  competitions:[{competitors:[
   {homeAway:"away",team:{displayName:e.strAwayTeam,shortDisplayName:e.strAwayTeam},score:e.intAwayScore??"—"},
   {homeAway:"home",team:{displayName:e.strHomeTeam,shortDisplayName:e.strHomeTeam},score:e.intHomeScore??"—"}
  ]}]};
}
function sportsDbScore(e: any, body: any) {
 if(!nflSportsDbMatch(e,body.awayName,body.homeName))return null;
 const state=sportsDbState(e);
 const away=e.intAwayScore==null?null:Number(e.intAwayScore),home=e.intHomeScore==null?null:Number(e.intHomeScore);
 if(state!=="pre"&&(!Number.isFinite(away)||!Number.isFinite(home)))return null;
 return {provider:"TheSportsDB (independent backup)",eventId:String(body.eventId),name:e.strAwayTeam+" at "+e.strHomeTeam,
  away:body.awayName,home:body.homeName,awayScore:away??"—",homeScore:home??"—",
  state,status:String(e.strStatus||e.strProgress||"Scoreboard update"),period:Number((String(e.strStatus||"").match(/Q([1-4])/)||[])[1]||0),
  clock:"",possession:"",downDistance:"",fieldPosition:"",lastPlay:"",
  startDate:sportsDbDate(e),fetchedAt:new Date().toISOString(),partial:true,
  automatic:{pending:true,reason:"Independent score data does not include verified possession history."}};
}
async function sportsDbByDay(date: string) {
 const day=date.slice(0,4)+"-"+date.slice(4,6)+"-"+date.slice(6);
 const response=await timeoutFetch(sportsDbBase+"eventsday.php?d="+day+"&l=NFL",6500);
 if(!response.ok)throw Error("Independent scoreboard HTTP "+response.status);
 const data=await response.json();
 return (Array.isArray(data.events)?data.events:[]).filter(nflSportsDb);
}
async function independentNflResult(body: any, date: string, attempts: string[]) {
 try {
  const id=String(body.eventId);
  let game=null;
  if(/^tsdb-\d+$/.test(id)){
   const response=await timeoutFetch(sportsDbBase+"lookupevent.php?id="+encodeURIComponent(id.slice(5)),6500);
   if(!response.ok)throw Error("Independent game HTTP "+response.status);
   const data=await response.json();
   game=(Array.isArray(data.events)?data.events:[]).find((e:any)=>nflSportsDbMatch(e,body.awayName,body.homeName));
  }else{
   game=(await sportsDbByDay(date)).find((e:any)=>nflSportsDbMatch(e,body.awayName,body.homeName));
  }
  const result=sportsDbScore(game,body);
  const eventDay=String(game?.dateEvent||result?.startDate||"").slice(0,10);
  if(result && eventDay===date.slice(0,4)+"-"+date.slice(4,6)+"-"+date.slice(6))
   return json({ok:true,data:result,attempts,scoringSafe:false,note:"Independent scoreboard available; verified drive history unavailable."});
  attempts.push("TheSportsDB: matching dated game or score unavailable");
 }catch(error){attempts.push("TheSportsDB: "+(error instanceof Error?error.message:"request unavailable"))}
 return null;
}

const apiURL = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function member(req: Request, roomId: string) {
  const authorization=req.headers.get("Authorization")||"";
  const headers={apikey:anonKey,Authorization:authorization};
  const userReply=await fetch(apiURL+"/auth/v1/user",{headers});
  if(!userReply.ok)throw Error("Sign in required");
  const user=await userReply.json();
  const response=await fetch(apiURL+"/rest/v1/room_members?select=id&room_id=eq."+encodeURIComponent(roomId)+"&user_id=eq."+encodeURIComponent(user.id),{headers});
  if(!response.ok||(await response.json()).length===0)throw Error("Room membership required");
}
async function enrich(result: any, body: any, req: Request, attempts: string[]) {
  result.automatic={pending:true,reason:"Waiting for verified drive history."};
  try {
    const sport=body.league==="college"?"college-football":"nfl";
    if(!/^\d+$/.test(String(body.eventId)))throw Error("Invalid ESPN event ID");
    const response=await timeoutFetch("https://site.api.espn.com/apis/site/v2/sports/football/"+sport+"/summary?event="+encodeURIComponent(body.eventId),6500);
    if(!response.ok)throw Error("Drive summary HTTP "+response.status);
    if(Number(response.headers.get("age")||0)>30&&result.state==="in")throw Error("Drive summary is stale");
    const summary=await response.json();
    const comp=summary.header?.competitions?.[0];
    const cs=comp?.competitors||[];
    const a=cs.find((x:any)=>x.homeAway==="away"),h=cs.find((x:any)=>x.homeAway==="home");
    if(String(summary.header?.id)!==String(body.eventId)||!a||!h||
      !norm(a.team?.displayName).includes(norm(body.awayName))||!norm(h.team?.displayName).includes(norm(body.homeName)))throw Error("Drive identity mismatch");
    // ESPN omits scores before kickoff. Treat those as zero only when both
    // independently fetched sources confirm the game has not started.
    const pregame=result.state==="pre"&&comp?.status?.type?.state==="pre";
    const summaryScore=(team:any)=>team.score==null&&pregame?0:Number(team.score);
    if(summaryScore(a)!==result.awayScore||summaryScore(h)!==result.homeScore)throw Error("Scoreboard and drive summary disagree");
    const snapshot=parseDriveSnapshot(summary,String(body.eventId));
    if(!snapshot.available)throw Error("Drive history unavailable");
    const current=summary.drives?.current;
    const last=current?.plays?.at(-1)||summary.drives?.previous?.at(-1)?.plays?.at(-1);
    if(last){result.lastPlay=last.text||result.lastPlay;result.period=last.period?.number||result.period;result.clock=last.clock?.displayValue||result.clock;}
    if(snapshot.current?.team)result.possession=snapshot.current.team;
    if(last?.end){result.downDistance=last.end.down?last.end.down+" & "+last.end.distance:result.downDistance;result.fieldPosition=last.end.possessionText||last.end.yardLine||result.fieldPosition;}
    result.drive={sourceId:snapshot.current?.source_id||null,completed:snapshot.completed.length};
    if(body.roomId){
      await member(req,String(body.roomId));
      const apply=await fetch(apiURL+"/rest/v1/rpc/drive_duel_apply_feed",{
        method:"POST",headers:{apikey:serviceKey,Authorization:"Bearer "+serviceKey,"Content-Type":"application/json"},
        body:JSON.stringify({p_room_id:body.roomId,p_game_id:String(body.eventId),p_snapshot:snapshot,p_away_score:result.awayScore,p_home_score:result.homeScore})
      });
      if(!apply.ok)throw Error("Could not synchronize verified drive results");
      result.automatic=await apply.json();
    }
    return json({ok:true,data:result,attempts,scoringSafe:true,note:"Verified drive history controls scoring and shared advancement."});
  }catch(error){
    const reason=error instanceof Error?error.message:"Drive history unavailable";
    result.automatic={pending:true,reason};
    return json({ok:true,data:result,attempts,scoringSafe:false,note:reason});
  }
}
async function schedule(body:any){
 const sport=body.league==="college"?"college-football":"nfl";
 const keys=body.dates;
 if(!Array.isArray(keys)||keys.length>8||!keys.length||keys.some((k:any)=>!/^\d{8}$/.test(k)))return json({error:"Invalid schedule dates"},400);
 const suffix=sport==="college-football"?"&groups=80&limit=100":"";
 // ESPN rejects date ranges on this endpoint; fetch each requested day independently.
 const days=await Promise.all([...new Set(keys)].map(async date=>{
  for(const host of ["site.api.espn.com","site.web.api.espn.com"]){
   try{
    const r=await timeoutFetch("https://"+host+"/apis/site/v2/sports/football/"+sport+"/scoreboard?dates="+date+suffix,6500);
    if(r.ok){const data=await r.json();if(Array.isArray(data.events))return {date,events:data.events,ok:true};}
   }catch{}
  }
  return {date,events:[],ok:false};
 }));
 const failed=days.filter(d=>!d.ok);
 let independent: any[]=[];
 if(sport==="nfl"&&failed.length){
  const backups=await Promise.all(failed.map(async d=>{
   try{return (await sportsDbByDay(d.date)).map(sportsDbScheduleEvent).filter(Boolean)}
   catch{return []}
  }));
  independent=backups.flat();
 }
 const seen=new Set();
 const events=[...days.flatMap(d=>d.events),...independent].filter(e=>{if(seen.has(String(e.id)))return false;seen.add(String(e.id));return true;});
 if(days.some(d=>d.ok)||independent.length)return json({ok:true,events,partial:failed.length>0,
  sourceLabel:independent.length?"ESPN + independent NFL backup":"ESPN",
  unavailableDates:failed.filter(d=>!independent.some(e=>String(e.date).startsWith(d.date.slice(0,4)+"-"+d.date.slice(4,6)+"-"+d.date.slice(6)))).map(d=>d.date)});
 return json({ok:false,error:"Football schedule providers temporarily unavailable"},503);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  try {
    const body = await req.json();
    if(body.operation==="schedule")return schedule(body);
    const eventId = String(body.eventId ?? "");
    const league = body.league === "college" ? "college" : "nfl";
    const awayName = String(body.awayName ?? "");
    const homeName = String(body.homeName ?? "");
    if (!eventId || !awayName || !homeName) return json({ error: "eventId, awayName and homeName are required." }, 400);
    const sport = league === "college" ? "college-football" : "nfl";
    const date = body.date ? new Date(body.date) : new Date();
    if (Number.isNaN(date.getTime())) return json({ error: "Invalid game date." }, 400);
    // ESPN's football scoreboard uses the US game day; ISO kickoff timestamps
    // for evening games often fall on the following UTC day.
    const utcDay = String(date.getUTCFullYear()) + String(date.getUTCMonth()+1).padStart(2,"0") + String(date.getUTCDate()).padStart(2,"0");
    const dateOnly = typeof body.date==="string" && /^\\d{4}-\\d{2}-\\d{2}$/.test(body.date);
    const parts = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
    const part=(type:string)=>parts.find(p=>p.type===type)?.value??"";
    const dates = dateOnly?utcDay:part("year")+part("month")+part("day");
    const collegeArgs = league === "college" ? "&groups=80&limit=100" : "";
    if(league==="nfl" && /^tsdb-\d+$/.test(eventId)){
      const backup=await independentNflResult(body,dates,[]);
      return backup??json({ok:false,scoringSafe:false,error:"Independent game is unavailable or has no verified score."},503);
    }
    const candidates = [
      { provider: "ESPN", url: "https://site.api.espn.com/apis/site/v2/sports/football/" + sport + "/scoreboard?dates=" + dates + collegeArgs },
      { provider: "ESPN Backup", url: "https://site.web.api.espn.com/apis/site/v2/sports/football/" + sport + "/scoreboard?region=us&lang=en&contentorigin=espn&dates=" + dates + collegeArgs },
    ];
    if(dates!==utcDay)candidates.push({provider:"ESPN UTC-day fallback",url:"https://site.api.espn.com/apis/site/v2/sports/football/"+sport+"/scoreboard?dates="+utcDay+collegeArgs});
    const attempts: string[] = [];
    for (const source of candidates) {
      try {
        const response = await timeoutFetch(source.url);
        if (!response.ok) { attempts.push(source.provider + ": HTTP " + response.status); continue; }
        const payload = await response.json();
        const event = findEvent(payload, eventId, awayName, homeName);
        if (!event) { attempts.push(source.provider + ": matchup not found"); continue; }
        const result = normalize(event, source.provider);
        const sameGame = norm(result.away).includes(norm(awayName)) && norm(result.home).includes(norm(homeName));
        if (!sameGame) { attempts.push(source.provider + ": matchup identity mismatch"); continue; }
        return await enrich(result,body,req,attempts);
      } catch (error) {
        attempts.push(source.provider + ": " + (error instanceof Error && error.name === "AbortError" ? "timeout" : "request/parse failure"));
      }
    }
    if (league === "nfl") {
      try {
        const response = await timeoutFetch("https://static.nfl.com/liveupdate/scores/scores.json", 3500);
        if (!response.ok) attempts.push("NFL live scores: HTTP " + response.status);
        else {
          const game = findNflStaticGame(await response.json(), awayName, homeName);
          if (game) {
            // Legacy NFL static data must match the requested game day; team names
            // alone can accidentally match an old season's game.
            const start=game.date??game.startTime??game.start_time??game.gameDate??game.gameTime;
            const startDate=new Date(start||"");
            const pieces=Number.isFinite(startDate.getTime())
              ?new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(startDate):[];
            const part=(type:string)=>pieces.find(p=>p.type===type)?.value??"";
            const gameDay=part("year")+part("month")+part("day");
            if(!start||gameDay!==dates)attempts.push("NFL static scoreboard: dated matchup could not be verified");
            else {
              const data=normalizeNflStatic(game,awayName,homeName);
              if(Number.isFinite(data.awayScore)&&Number.isFinite(data.homeScore)){
                return json({ok:true,data:{...data,automatic:{pending:true,reason:"Backup scoreboard has no verified drive history."}},attempts,scoringSafe:false});
              }
              attempts.push("NFL static scoreboard: matching game had invalid scores");
            }
          } else attempts.push("NFL live scores: matchup not found in backup feed");
        }
      } catch (error) { attempts.push("NFL live scores: " + (error instanceof Error && error.name === "AbortError" ? "timeout" : "request/parse failure")); }
    }
    if(league==="nfl"){
      const backup=await independentNflResult(body,dates,attempts);
      if(backup)return backup;
    }
    return json({ ok: false, scoringSafe: false, attempts, error: "No trusted feed returned this exact matchup. Keep the last verified display and pause drive scoring until a source recovers." }, 503);
  } catch {
    return json({ error: "Invalid request.", scoringSafe: false }, 400);
  }
});