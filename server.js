// ClientSided's Private Roblox Name Scanner: accounts, passkeys, background scanning, email
const http=require("http"),fs=require("fs"),path=require("path"),crypto=require("crypto"),{promisify}=require("util");
const scrypt=promisify(crypto.scrypt);
const os=require("os");
let DIR=process.env.DATA_DIR||__dirname;
try{fs.accessSync(DIR,fs.constants.W_OK)}catch(e){DIR=os.tmpdir();console.warn("WARNING: app folder is read-only. Using "+DIR+", so accounts and names will be lost on restart. Set DATA_DIR to a persistent disk.")}
const DBF=path.join(DIR,"data.json");
let db={users:{},sessions:{}};try{db=JSON.parse(fs.readFileSync(DBF,"utf8"))}catch(e){}
const save=()=>{try{fs.writeFileSync(DBF+".tmp",JSON.stringify(db));fs.renameSync(DBF+".tmp",DBF)}catch(e){console.error("Could not save data:",e.message)}};
const rnd=n=>crypto.randomBytes(n).toString("base64url");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const EMAIL=/^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,255}\.[A-Za-z]{2,}$/;
const fmt=ms=>{const s=Math.round(ms/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60);return(h?h+"h ":"")+(h||m?m+"m ":"")+s%60+"s"};
const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const json=(res,c,o)=>{res.writeHead(c,{"Content-Type":"application/json"});res.end(JSON.stringify(o))};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const clean=s=>String(s??"").replace(/[\r\n]+/g," ").slice(0,200);
const readBody=req=>new Promise((ok,no)=>{let b="";req.on("data",d=>{b+=d;if(b.length>200000){no(new Error("Request too large"));req.destroy()}});req.on("end",()=>ok(b))});
const SW=()=>require("@simplewebauthn/server");

// ---- email
function mailCfg(){let c={};try{c=JSON.parse(fs.readFileSync(path.join(__dirname,"mail-config.json"),"utf8"))}catch(e){}const e=process.env;
  return{host:e.SMTP_HOST||c.host,port:+(e.SMTP_PORT||c.port||465),user:e.SMTP_USER||c.user,pass:e.SMTP_PASS||c.pass,from:e.MAIL_FROM||c.from||e.SMTP_USER||c.user}}
const configured=()=>{const m=mailCfg();return!!(m.host&&m.user&&m.pass)};
async function sendMail(to,subject,text,html){
  if(!configured())throw new Error("Email isn't set up on the server. Create mail-config.json.");
  const m=mailCfg();
  await require("nodemailer").createTransport({host:m.host,port:m.port,secure:m.port===465,auth:{user:m.user,pass:m.pass}}).sendMail({from:m.from,to,subject,text,html});
}
function reportMail(j){
  const f=(t,o)=>{try{return new Date(t).toLocaleString("en-US",{timeZone:j.tz,...o})}catch(e){return new Date(t).toLocaleString("en-US",o)}};
  const a=j.found.length;
  const rows=[["Time taken",fmt(j.endedAt-j.startedAt)],["Started",f(j.startedAt,{timeStyle:"medium"})],["Finished",f(j.endedAt,{dateStyle:"full",timeStyle:"medium"})],["Names checked",j.checked],["Taken (skipped)",j.taken],["Hit rate",j.checked?(a/j.checked*100).toFixed(1)+"%":"0%"],["Settings",j.cfg]].map(([k,v])=>[k,clean(v)]);
  return{subject:"Your Roblox names: "+a+" available",
    text:"Available Roblox usernames:\n\n"+j.found.join("\n")+"\n\n"+rows.map(([k,v])=>k+": "+v).join("\n"),
    html:'<div style="font-family:Arial,sans-serif;max-width:520px"><h2 style="margin:0 0 4px">Scan complete</h2><p style="color:#666;margin:0 0 16px">'+a+" available username"+(a===1?"":"s")+" found</p>"+
      j.found.map(n=>'<div style="font:700 17px monospace;padding:10px 14px;margin:6px 0;background:#eafff3;border-left:4px solid #22c55e;border-radius:6px">'+esc(n)+"</div>").join("")+
      '<table style="margin-top:18px;font-size:14px;border-collapse:collapse">'+rows.map(([k,v])=>'<tr><td style="padding:4px 14px 4px 0;color:#666">'+esc(k)+"</td><td>"+esc(v)+"</td></tr>").join("")+"</table></div>"};
}
async function mailJob(j){
  j.mail={state:"sending",to:j.email};
  try{const m=reportMail(j);await sendMail(j.email,m.subject,m.text,m.html);j.mail={state:"sent",to:j.email}}
  catch(e){j.mail={state:"failed",to:j.email,error:e.code==="MODULE_NOT_FOUND"?"Run npm install in the scanner folder first.":e.message}}
}

// ---- background scan jobs (keep running when the browser tab is hidden or closed)
const jobs=new Map(),MAX_JOBS=3;
const pub=j=>{const{seen,tz,...r}=j;return r};
function gen(j){
  const L="abcdefghijklmnopqrstuvwxyz",N="0123456789",pool=(j.letters?L:"")+(j.numbers?N:"");
  for(let k=0;k<60;k++){
    let s=j.pre,us=(j.pre.match(/_/g)||[]).length;
    while(s.length<j.len){const i=s.length,p=(j.under&&us<1&&i>0&&i<j.len-1)?pool+"_":pool,ch=p[crypto.randomInt(p.length)];if(ch==="_")us++;s+=ch}
    if(s.endsWith("_")||(j.letters&&!/[a-z]/.test(s)))continue;
    return s;
  }
  return null;
}
function finish(j,reason){if(j.done)return;j.done=true;j.running=false;j.reason=reason;j.endedAt=Date.now();if(j.email&&j.found.length)mailJob(j)}
async function run(j,u){
  while(j.running){
    if(j.found.length>=j.target)return finish(j,"done");
    const name=gen(j);
    if(!name||j.dupes>3000)return finish(j,"exhausted");
    if(j.seen.has(name)){j.dupes++;continue}
    j.dupes=0;j.seen.add(name);j.current=name;
    try{
      const r=await fetch("https://auth.roblox.com/v1/usernames/validate?request.username="+name+"&request.birthday=2000-01-01&request.context=Signup");
      if(!j.running)return;
      if(r.status===429){j.seen.delete(name);j.rl=true;const w=Date.now();await sleep(10000);j.rlWait+=Date.now()-w;j.rl=false;continue}
      if(r.status!==200)throw new Error("HTTP "+r.status);
      const d=await r.json();j.errs=0;j.checked++;
      if(d.code===0){j.found.push(name);if(!u.names.some(n=>n.name===name)){u.names.unshift({name,len:j.len,at:Date.now()});u.names.length=Math.min(u.names.length,2000);save()}}
      else{j.taken++;j.recent.unshift(name);j.recent.length=Math.min(j.recent.length,6)}
    }catch(e){j.seen.delete(name);if(++j.errs>=8)return finish(j,"error");await sleep(2000);continue}
    await sleep(380);
  }
}

// ---- auth helpers
const cookies=req=>Object.fromEntries((req.headers.cookie||"").split(";").map(c=>c.trim().split("=")).filter(a=>a[0]));
const getU=k=>has(db.users,k)?db.users[k]:null;
function authed(req){const t=cookies(req).sid;if(!t||!has(db.sessions,t))return null;const s=db.sessions[t];return s.exp>Date.now()?getU(s.u):null}
function startSession(req,res,u){
  for(const[t,s]of Object.entries(db.sessions))if(s.exp<Date.now())delete db.sessions[t];
  const t=rnd(32);db.sessions[t]={u:u.key,exp:Date.now()+30*864e5};save();
  res.setHeader("Set-Cookie","sid="+t+"; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000"+(req.headers["x-forwarded-proto"]==="https"?"; Secure":""));
}
const fails={};
const limited=k=>{const a=(fails[k]||[]).filter(t=>Date.now()-t<6e5);fails[k]=a;return a.length>=8};
const failed=k=>(fails[k]=fails[k]||[]).push(Date.now());
const chals=new Map();
const setChal=(id,c)=>{chals.set(id,{c,exp:Date.now()+3e5});for(const[k,v]of chals)if(v.exp<Date.now())chals.delete(k)};
const takeChal=id=>{const v=chals.get(id);chals.delete(id);return v&&v.exp>Date.now()?v.c:null};
const ctx=req=>{const host=req.headers.host||"localhost:3000";return{rpID:process.env.RP_ID||host.split(":")[0],origin:process.env.ORIGIN||((req.headers["x-forwarded-proto"]||"http")+"://"+host)}};
let lastTest=0;

http.createServer(async(req,res)=>{
  try{
    const p=new URL(req.url,"http://x").pathname,{rpID,origin}=ctx(req);
    if(!p.startsWith("/api/"))return fs.readFile(path.join(__dirname,"index.html"),(e,d)=>{res.writeHead(e?500:200,{"Content-Type":"text/html; charset=utf-8"});res.end(e?"index.html missing":d)});
    if(req.method==="POST"){
      if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{error:"Bad origin"});
      if(!(req.headers["content-type"]||"").includes("application/json"))return json(res,415,{error:"JSON only"});
    }
    const b=req.method==="POST"?JSON.parse((await readBody(req))||"{}"):{},key=req.method+" "+p,u=authed(req);

    if(key==="GET /api/mail-status")return json(res,200,{configured:configured()});

    if(key==="POST /api/signup"||key==="POST /api/login"){
      const name=String(b.username||"").trim(),pw=String(b.password||""),k=name.toLowerCase(),lk=req.socket.remoteAddress+k;
      if(limited(lk))return json(res,429,{error:"Too many attempts. Try again in a few minutes."});
      if(key.endsWith("signup")){
        if(!/^[A-Za-z0-9_]{3,24}$/.test(name))return json(res,400,{error:"Username must be 3-24 letters, numbers or underscores."});
        if(pw.length<8||pw.length>200)return json(res,400,{error:"Password must be at least 8 characters."});
        if(getU(k))return json(res,409,{error:"That username is taken."});
        const salt=rnd(16);
        db.users[k]={key:k,name,id:rnd(16),salt,hash:(await scrypt(pw,salt,64)).toString("base64url"),creds:[],names:[],settings:{}};
        startSession(req,res,db.users[k]);return json(res,200,{ok:true});
      }
      const x=getU(k);let ok=false;
      if(x&&x.hash){const h=await scrypt(pw,x.salt,64);ok=crypto.timingSafeEqual(h,Buffer.from(x.hash,"base64url"))}
      if(!ok){failed(lk);return json(res,401,{error:"Wrong username or password."})}
      startSession(req,res,x);return json(res,200,{ok:true});
    }

    if(key==="POST /api/passkey/auth-options"){
      const o=await SW().generateAuthenticationOptions({rpID,userVerification:"preferred"}),cid=rnd(12);
      setChal(cid,o.challenge);return json(res,200,{options:o,cid});
    }
    if(key==="POST /api/passkey/auth-verify"){
      const ch=takeChal(b.cid);if(!ch)return json(res,400,{error:"Passkey request expired. Try again."});
      let x=null,c=null;
      for(const w of Object.values(db.users)){const f=w.creds.find(q=>q.id===(b.response&&b.response.id));if(f){x=w;c=f;break}}
      if(!x)return json(res,401,{error:"That passkey isn't registered on this scanner."});
      const v=await SW().verifyAuthenticationResponse({response:b.response,expectedChallenge:ch,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:false,
        credential:{id:c.id,publicKey:new Uint8Array(Buffer.from(c.publicKey,"base64url")),counter:c.counter,transports:c.transports}});
      if(!v.verified)return json(res,401,{error:"Passkey check failed."});
      c.counter=v.authenticationInfo.newCounter;startSession(req,res,x);return json(res,200,{ok:true});
    }

    if(!u)return json(res,401,{error:"Please sign in."});

    if(key==="GET /api/me")return json(res,200,{user:{name:u.name,settings:u.settings||{},names:u.names,passkeys:u.creds.length}});
    if(key==="POST /api/logout"){delete db.sessions[cookies(req).sid];save();res.setHeader("Set-Cookie","sid=; Max-Age=0; Path=/");return json(res,200,{ok:true})}

    if(key==="POST /api/passkey/reg-options"){
      const o=await SW().generateRegistrationOptions({rpName:"ClientSided Scanner",rpID,userName:u.name,userID:new Uint8Array(Buffer.from(u.id,"base64url")),attestationType:"none",
        excludeCredentials:u.creds.map(c=>({id:c.id})),authenticatorSelection:{residentKey:"required",userVerification:"preferred"}});
      setChal("r"+u.key,o.challenge);return json(res,200,{options:o});
    }
    if(key==="POST /api/passkey/reg-verify"){
      const ch=takeChal("r"+u.key);if(!ch)return json(res,400,{error:"Passkey request expired. Try again."});
      const v=await SW().verifyRegistrationResponse({response:b.response,expectedChallenge:ch,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:false});
      if(!v.verified)return json(res,400,{error:"Passkey couldn't be verified."});
      const c=v.registrationInfo.credential;
      u.creds.push({id:c.id,publicKey:Buffer.from(c.publicKey).toString("base64url"),counter:c.counter,transports:(b.response.response&&b.response.response.transports)||[]});
      save();return json(res,200,{ok:true,passkeys:u.creds.length});
    }

    if(key==="POST /api/settings"){
      const S={};
      for(const k of["len","target"])if(Number.isFinite(+b[k]))S[k]=+b[k];
      for(const k of["pre","email"])S[k]=String(b[k]||"").slice(0,64);
      for(const k of["oL","oN","oU","mailOn"])S[k]=!!b[k];
      u.settings=S;save();return json(res,200,{ok:true});
    }
    if(key==="POST /api/names/clear"){u.names=[];save();return json(res,200,{ok:true})}

    if(key==="GET /api/scan"){const j=jobs.get(u.key);return json(res,200,{job:j?pub(j):null})}
    if(key==="POST /api/scan/start"){
      const old=jobs.get(u.key);if(old&&old.running)return json(res,409,{error:"A scan is already running."});
      if([...jobs.values()].filter(j=>j.running).length>=MAX_JOBS)return json(res,429,{error:"The server is busy with other scans. Try again soon."});
      const len=Math.max(3,Math.min(20,b.len|0)),target=Math.max(1,Math.min(999,b.target|0)),pre=String(b.pre||"").toLowerCase();
      const letters=!!b.letters,numbers=!!b.numbers,under=!!b.underscore;
      if(!letters&&!numbers)return json(res,400,{error:"Turn on letters or numbers."});
      if(pre&&(!/^[a-z0-9_]+$/.test(pre)||pre.length>=len||pre[0]==="_"))return json(res,400,{error:"Prefix must be shorter than the length and use letters, numbers or _ only."});
      const j={id:rnd(6),len,target,pre,letters,numbers,under,email:EMAIL.test(b.email||"")?b.email:"",tz:String(b.tz||"UTC").slice(0,60),
        cfg:len+" characters, "+[letters&&"letters",numbers&&"numbers",under&&"underscore"].filter(Boolean).join(" + ")+(pre?', starts with "'+pre+'"':""),
        found:[],checked:0,taken:0,rlWait:0,rl:false,current:"",recent:[],dupes:0,errs:0,startedAt:Date.now(),endedAt:0,running:true,done:false,reason:"",mail:{state:"off"},seen:new Set()};
      jobs.set(u.key,j);run(j,u);return json(res,200,{ok:true});
    }
    if(key==="POST /api/scan/stop"){const j=jobs.get(u.key);if(j&&j.running)finish(j,"stopped");return json(res,200,{ok:true})}
    if(key==="POST /api/scan/mail"){
      const j=jobs.get(u.key);if(!j||!j.done||!j.email||!j.found.length)return json(res,400,{error:"Nothing to email."});
      mailJob(j);return json(res,200,{ok:true});
    }
    if(key==="POST /api/email/test"){
      if(!EMAIL.test(b.to||""))return json(res,400,{error:"Invalid email address."});
      if(Date.now()-lastTest<5000)return json(res,429,{error:"Wait a few seconds and try again."});
      lastTest=Date.now();await sendMail(b.to,"Scanner test email","Your ClientSided's Private Roblox Name Scanner can send email.","<p>Your ClientSided's Private Roblox Name Scanner can send email.</p>");
      return json(res,200,{ok:true});
    }
    return json(res,404,{error:"Not found"});
  }catch(e){
    json(res,e.code==="MODULE_NOT_FOUND"?500:400,{error:e.code==="MODULE_NOT_FOUND"?"Run npm install in the scanner folder first.":(e.message||"Request failed")});
  }
}).listen(process.env.PORT||3000,process.env.HOST||(process.env.PORT?"0.0.0.0":"127.0.0.1"),()=>console.log("Scanner running on port "+(process.env.PORT||3000)+" (email "+(configured()?"ready":"not set up")+")"));
