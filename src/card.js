// Config and texts are injected by the bot when the card is sent.
var T=window.TelegramWidget,C=__CFG__,S=C.s,D={},tab='sub',sel=0,TABS=['sub','pay','how'];
function $(i){return document.getElementById(i)}
if(C.c)document.body.style.setProperty('--a',C.c);
function parse(j){try{return JSON.parse(j)||{}}catch(e){return{}}}
function show(e,v){e.style.display=v?'':'none'}
function gb(b){var g=b/1073741824;return String(g>=100?Math.round(g):Math.round(g*10)/10).replace('.',S.dec)+' '+S.gb}
function plural(n){var a=n%10,b=n%100;return S.days[a==1&&b!=11?0:a>=2&&a<=4&&(b<10||b>=20)?1:2]}
var nt;function note(t){$('m').textContent=t;clearTimeout(nt);nt=setTimeout(function(){$('m').textContent=''},4000)}
function hasPay(){return C.t.length||C.r}
function draw(){
  var i,b,now=Date.now()/1000,none=D.x,left=Math.ceil((D.e-now)/86400),st=D.s,dead=!none&&(st=='EXPIRED'||D.e<now);
  var ever=!none&&!dead&&left>3650,live=!none&&!dead&&st=='ACTIVE';
  // tabs
  $('tabs').innerHTML='';
  for(i=0;i<3;i++){if(i==1&&!hasPay())continue;b=document.createElement('button');b.textContent=S.tabs[i];b.className=tab==TABS[i]?'on':'';b.onclick=go(TABS[i]);$('tabs').appendChild(b)}
  for(i=0;i<3;i++)show($(TABS[i]),tab==TABS[i]);
  // header: brand and status
  $('br').textContent=C.n;
  show($('st'),!none);
  $('sx').textContent=dead?S.st.EXPIRED:S.st[st]||st;
  $('st').style.color=$('si').style.background=dead||st=='DISABLED'?'#FF6B6B':st=='LIMITED'?'#FFB547':'';
  // the route line runs only while the subscription works
  $('rt').className='rt'+(live?'':' off');
  $('r1').textContent=S.route[0];$('r2').textContent=S.route[1];$('r3').textContent=S.route[2];
  // time left: a big number, or a word when there is no number to show
  var word=none?S.none:dead?S.over:ever?S.forever:'';
  $('dy').textContent=word||left;$('dy').className=word?'t':'';
  $('l1').textContent=word?'':plural(left);
  var d=new Date(D.e*1000),ds;
  try{ds=d.toLocaleDateString(S.loc,{day:'numeric',month:'long',year:'numeric'})}catch(e){ds=d.toISOString().slice(0,10)}
  $('un').textContent=none?S.nonehint:ever?'':(dead?'':S.until+' ')+ds;
  // traffic
  show($('tr'),!none);
  $('tl').textContent=S.traffic;show($('bw'),D.l>0);
  $('tb').style.width=(D.l>0?Math.min(100,D.u/D.l*100):0)+'%';
  $('tv').textContent=D.l>0?gb(D.u).replace(' '+S.gb,'')+' / '+gb(D.l):gb(D.u||0)+', '+S.unlim;
  // devices: one dot per slot when there is a small limit
  show($('dc'),!none&&(D.d>0||D.dl>0));
  $('dl').textContent=S.devices;
  $('dv').textContent=(D.dl>0&&D.dl<9?'\u25CF'.repeat(Math.min(D.d,D.dl))+'\u25CB'.repeat(Math.max(0,D.dl-D.d))+' ':'')+D.d+(D.dl?' '+S.of+' '+D.dl:'');
  $('cp').textContent=S.open;show($('cp'),!none&&D.k);
  $('rn').textContent=none?S.choose:S.renew;show($('rn'),hasPay());
  // renew
  $('pls').innerHTML='';
  for(i=0;i<C.t.length;i++){b=document.createElement('div');b.className='pl'+(C.p&&i==sel?' on':'');b.innerHTML=(C.p?'<i></i>':'')+'<span></span><b></b>';b.children[C.p?1:0].textContent=C.t[i].title;b.lastChild.textContent=C.t[i].price;if(C.p)b.onclick=choose(i);$('pls').appendChild(b)}
  $('go').textContent=C.p?S.payfor+' '+C.t[sel].price:S.pay;show($('go'),C.p||C.r);
  $('bs').textContent=S.stars;show($('bs'),C.p&&C.z);
  $('sp').textContent=S.support;show($('sp'),C.h);
  // how to connect
  $('s1').textContent=S.s1.replace('{app}',C.a);
  $('s2').textContent=S.s2;$('s3').textContent=S.s3;
  $('op').textContent=S.open;show($('op'),D.k)
}
// Telegram links (the Stars invoice, a bot, a channel) open inside Telegram with
// openTelegramLink; openLink refuses them and is only for other https sites.
function open(u){try{/^https:\/\/(t\.me|telegram\.me|telegram\.dog)\//.test(u)?T.openTelegramLink(u):T.openLink(u)}catch(e){note(S.fail)}}
function go(t){return function(){tab=t;draw()}}
function choose(i){return function(){sel=i;draw()}}
var busy=0;
$('cp').onclick=function(){open(D.k)};
$('rn').onclick=go('pay');
// With payments on, the bot answers a tap with a Telegram Stars invoice in the chat.
$('go').onclick=function(){if(!C.p)return open(C.r);if(D.v&&D.v[sel])return open('https://t.me/$'+D.v[sel]);if(busy)return;busy=1;note(S.wait);T.request('b'+sel).then(function(a){busy=0;note(a.result=='1'?S.inv:a.result=='2'?S.demo:S.fail)},function(){busy=0;note(S.fail)})};
$('sp').onclick=function(){open(C.h)};
$('bs').onclick=function(){open(C.z)};
$('op').onclick=function(){open(D.k)};
function take(j){var n=parse(j),up=D.e&&n.e>D.e+3600;if(n.x||n.e){D=n;if(up)tab='sub';draw();if(up)note(S.done)}}
T.onEvent('chatDataChanged',function(){take(T.chatData)});
take(T.chatData);draw();
// Ask the bot for fresh numbers when the card appears.
try{T.request('r').then(function(a){take(a.result)},function(){})}catch(e){}
T.ready();
