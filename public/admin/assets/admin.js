/* 沐沐学习乐园 · 后台管理平台公共逻辑 */
(function(){
'use strict';

/* ---------- API 封装 ---------- */
const api={
  async req(method,url,body){
    const r=await fetch(url,{
      method,headers:{'Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined,
      credentials:'same-origin'
    });
    if(r.status===401){ location.href='/admin/login.html'; throw new Error('unauthorized'); }
    const ct=r.headers.get('content-type')||'';
    const j=ct.includes('json')?await r.json():null;
    if(!r.ok){ throw Object.assign(new Error(j&&j.error||'http_'+r.status),{status:r.status,body:j}); }
    return j;
  },
  me:()=>api.req('GET','/api/admin/me'),
  logout:()=>api.req('POST','/api/admin/logout'),
  all:()=>api.req('GET','/api/admin/data'),
  get:(k)=>api.req('GET','/api/admin/data/'+k),
  set:(k,v)=>api.req('POST','/api/admin/data/'+k,v),
  batch:(updates)=>api.req('POST','/api/admin/batch',{updates})
};

/* ---------- Toast ---------- */
let _tt;
function toast(msg,type){
  let el=document.getElementById('adminToast');
  if(!el){ el=document.createElement('div'); el.id='adminToast'; el.className='toast'; document.body.appendChild(el); }
  el.textContent=msg; el.className='toast show'+(type?' '+type:'');
  clearTimeout(_tt); _tt=setTimeout(()=>{el.classList.remove('show')},2200);
}
const ok=m=>toast(m,'ok'), err=m=>toast(m,'err');

/* ---------- 通用工具 ---------- */
function esc(s){ s=(s==null?'':''+s); return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function pad(n){return n<10?'0'+n:''+n}
function today(d){ d=d||new Date(); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
function fmtTime(ts){ if(!ts)return'-'; const d=new Date(ts); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes()); }
function fnv(str){ let h=2166136261; for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=(h*16777619)>>>0; } return ('0000000'+h.toString(16)).slice(-8); }
function dowCN(d){ return ['日','一','二','三','四','五','六'][(d||new Date()).getDay()]; }
function subColor(name){
  name=name||'';
  if(name.indexOf('语文')>=0) return '#e66a6a';
  if(name.indexOf('数学')>=0) return '#5aa9e6';
  if(name.indexOf('英语')>=0) return '#3fa66a';
  const palette=['#f0a35e','#9b7ede','#4fb8b2','#d97ba8','#7aa5e0','#b8b83f','#8f9f6a'];
  let h=0; for(let i=0;i<name.length;i++) h=(h*31+name.charCodeAt(i))>>>0;
  return palette[h%palette.length];
}
function $(s,p){ return (p||document).querySelector(s); }
function $$(s,p){ return Array.from((p||document).querySelectorAll(s)); }
function confirm2(msg){ return window.confirm(msg); }

/* ---------- 页面骨架 ---------- */
const NAV=[
  {group:'数据概览',items:[
    {id:'dashboard',label:'仪表盘',ico:'📊',href:'/admin/index.html'}
  ]},
  {group:'内容管理',items:[
    {id:'homework',label:'作业管理',ico:'📝',href:'/admin/homework.html'},
    {id:'course',label:'课程表管理',ico:'📅',href:'/admin/course.html'},
    {id:'schedule',label:'作息模板',ico:'⏰',href:'/admin/schedule.html'},
    {id:'notice',label:'每日提醒',ico:'📣',href:'/admin/notice.html'},
    {id:'quiz',label:'每日一题',ico:'🧠',href:'/admin/quiz.html'},
    {id:'reward',label:'奖品设置',ico:'🎁',href:'/admin/reward.html'}
  ]},
  {group:'系统配置',items:[
    {id:'sys-user',label:'用户管理',ico:'👥',href:'/admin/sys-user.html'},
    {id:'sys-dict',label:'字典表',ico:'📚',href:'/admin/sys-dict.html'}
  ]}
];

async function mountLayout(pageId,title){
  // 未登录跳转
  let me=null;
  try{ me=await api.me(); }catch(e){ return; }
  const navHtml=NAV.map(g=>
    '<div class="group">'+esc(g.group)+'</div>'+
    g.items.map(it=>'<a href="'+it.href+'" class="'+(it.id===pageId?'on':'')+'"><span class="ico">'+it.ico+'</span>'+esc(it.label)+'</a>').join('')
  ).join('');
  document.body.innerHTML=
    '<div id="layout">'+
      '<aside id="sidebar">'+
        '<div class="brand"><span class="logo">🌸</span>沐沐乐园·后台</div>'+
        '<nav>'+navHtml+'</nav>'+
        '<div class="foot">v1.0 · Node + SQLite</div>'+
      '</aside>'+
      '<div id="main">'+
        '<div id="topbar">'+
          '<button id="sidebar-toggle" onclick="document.getElementById(\'sidebar\').classList.toggle(\'open\')">☰</button>'+
          '<div class="crumb">'+esc(title)+'</div>'+
          '<div class="flex1"></div>'+
          '<div class="who">当前用户：<b>'+esc(me.user.name)+'</b>（'+esc(me.user.role)+'）</div>'+
          '<a href="javascript:window.adminLogout()" style="font-size:12px">退出登录</a>'+
        '</div>'+
        '<div id="content"></div>'+
      '</div>'+
    '</div>';
  window.adminLogout=async function(){
    try{ await api.logout(); }catch(e){}
    location.href='/admin/login.html';
  };
  return document.getElementById('content');
}

/* ---------- 窗口/弹窗 ---------- */
function openMask(id){ $('#'+id).classList.add('on'); }
function closeMask(id){ $('#'+id).classList.remove('on'); }

/* ---------- 导出 ---------- */
window.admin={ api, toast, ok, err, esc, pad, today, fmtTime, fnv, dowCN, subColor, $, $$, confirm2, mountLayout, openMask, closeMask };
})();
