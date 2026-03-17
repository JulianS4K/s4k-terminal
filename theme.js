// ================================================================
// theme.js — S4K Terminal
// F5 theme engine — presets, colors, backgrounds, cursors
// ================================================================
'use strict';

function applyPreset(name,el){ currentTheme.preset=name;currentTheme.custom={}; document.querySelectorAll('.theme-card').forEach(c=>c.classList.remove('active')); if(el)el.classList.add('active'); const root=document.documentElement; Object.keys(PRESETS.matrix).forEach(v=>root.style.removeProperty(v)); Object.entries(PRESETS[name]||{}).forEach(([k,v])=>root.style.setProperty(k,v)); syncColorPickers(); }

function applyCustomColor(v,val){ currentTheme.custom[v]=val; document.documentElement.style.setProperty(v,val); }

function syncColorPickers(){ const s=getComputedStyle(document.documentElement); const m={'--bg':'c-bg','--bg2':'c-bg2','--amber':'c-amber','--white':'c-white','--sg':'c-sg','--te':'c-te','--border':'c-border','--muted':'c-muted'}; Object.entries(m).forEach(([v,id])=>{const el=document.getElementById(id);if(!el)return;const val=s.getPropertyValue(v).trim();if(val.startsWith('#')&&val.length>=7)el.value=val.substring(0,7);}); }

function applyBG(name,el){ currentTheme.bg=name; document.querySelectorAll('.bg-card').forEach(c=>c.classList.remove('active')); if(el)el.classList.add('active'); const p=BG_MAPS[name]||BG_MAPS.none,t=document.querySelector('.terminal'); t.style.backgroundImage=p.bg; t.style.backgroundSize=p.size; }

function applyCursor(name,el){ currentTheme.cursor=name; document.querySelectorAll('.cur-card').forEach(c=>c.classList.remove('active')); if(el)el.classList.add('active'); document.body.style.cursor=name==='none'?'none':name; }

function applyTermName(val){
  currentTheme.name=val;
  const d = val.trim() || 'S4K Terminal';
  const el = document.getElementById('term-title');
  if(el) el.innerHTML = `${d} <span style="font-size:12px;font-weight:400;color:var(--muted);margin-left:6px;">Ticket Market Analytics</span>`;
  const badge = document.getElementById('ver-badge');
  if(badge) badge.textContent = APP_VERSION;
  document.title = val.trim() || 'S4K Terminal';
}

function applyMarquee(val){ currentTheme.marquee=val; const p=document.getElementById('marquee-preview'),inn=document.getElementById('marquee-inner'); if(!val.trim()){p.style.display='none';removeMarqueeBar();return;} p.style.display='block';inn.textContent=val;applyMarqueeBar(val); }

function applyMarqueeBar(text){ removeMarqueeBar();if(!text)return; const bar=document.createElement('div');bar.id='marquee-bar';bar.style.cssText='overflow:hidden;border-bottom:1px solid var(--border);padding:3px 0;background:var(--bg2);flex-shrink:0;';bar.innerHTML=`<div style="white-space:nowrap;font-size:10px;color:var(--amber);animation:marquee 14s linear infinite;display:inline-block;padding-left:100%;letter-spacing:0.1em;">${text}</div>`;document.querySelector('.statusbar').insertAdjacentElement('afterend',bar); }

function removeMarqueeBar(){ const el=document.getElementById('marquee-bar');if(el)el.remove(); }

function saveTheme(){ localStorage.setItem(TKEY,JSON.stringify(currentTheme));toast('THEME SAVED'); }

function resetTheme(){ currentTheme={preset:'default',custom:{},bg:'none',cursor:'default',name:'',marquee:''}; applyPreset('default',document.getElementById('preset-default'));applyBG('none',document.getElementById('bg-none'));applyCursor('default',document.getElementById('cur-default'));document.getElementById('term-name').value='';document.getElementById('marquee-text').value='';applyTermName('');applyMarquee('');document.body.style.cursor='';localStorage.removeItem(TKEY);toast('THEME RESET'); }

function loadTheme(){ try{ const saved=JSON.parse(localStorage.getItem(TKEY)||'null');if(!saved)return;currentTheme=saved;applyPreset(saved.preset||'default',document.getElementById(`preset-${saved.preset||'default'}`));Object.entries(saved.custom||{}).forEach(([k,v])=>document.documentElement.style.setProperty(k,v));if(saved.bg)applyBG(saved.bg,document.getElementById(`bg-${saved.bg}`));if(saved.cursor)applyCursor(saved.cursor,document.getElementById(`cur-${saved.cursor}`));if(saved.name){document.getElementById('term-name').value=saved.name;applyTermName(saved.name);}if(saved.marquee){document.getElementById('marquee-text').value=saved.marquee;applyMarqueeBar(saved.marquee);}syncColorPickers();}catch(e){} }

// ================================================================
// F6 — INTELLIGENCE
// ================================================================

function applyCustomThemeCSS(){
  const css=document.getElementById('theme-css-input').value.trim();
  const status=document.getElementById('theme-css-status');
  if(!css){ status.textContent='Nothing to apply'; return; }
  // Extract variables from :root block and apply to documentElement
  try{
    const match=css.match(/:root\s*\{([^}]+)\}/s)||[null,css];
    const vars=match[1]||css;
    let applied=0;
    vars.split(';').forEach(decl=>{
      const [k,v]=(decl||'').split(':').map(s=>s.trim());
      if(k&&k.startsWith('--')&&v){
        document.documentElement.style.setProperty(k,v);
        applied++;
      }
    });
    localStorage.setItem('s4k_custom_theme_css', css);
    status.textContent=`Applied ${applied} variables ✓`;
    status.style.color='var(--green)';
    toast('THEME APPLIED');
  }catch(e){
    status.textContent=`Error: ${e.message}`;
    status.style.color='var(--red)';
  }
}

function exportCurrentTheme(){
  const vars=['--bg','--bg2','--bg3','--border','--muted','--white','--green','--red','--amber','--amber2','--cyan','--purple','--rss','--te','--te-bg','--te-bd','--sg','--sg-bg','--sg-bd','--font'];
  const style=getComputedStyle(document.documentElement);
  const lines=vars.map(v=>`  ${v}: ${style.getPropertyValue(v).trim()};`).join('\n');
  const block=`:root {\n${lines}\n}`;
  document.getElementById('theme-css-input').value=block;
  navigator.clipboard?.writeText(block).catch(()=>{});
  toast('CURRENT THEME EXPORTED — PASTE INTO AI TO MODIFY');
}

function resetCustomThemeCSS(){
  localStorage.removeItem('s4k_custom_theme_css');
  // Reset all overrides to stylesheet defaults
  const vars=['--bg','--bg2','--bg3','--border','--muted','--white','--green','--red','--amber','--amber2','--cyan','--purple','--rss','--te','--te-bg','--te-bd','--sg','--sg-bg','--sg-bd','--font'];
  vars.forEach(v=>document.documentElement.style.removeProperty(v));
  document.getElementById('theme-css-input').value='';
  document.getElementById('theme-css-status').textContent='Reset to default ✓';
  toast('THEME RESET');
}

// Load saved custom theme CSS on init
(function loadSavedThemeCSS(){
  const saved=localStorage.getItem('s4k_custom_theme_css');
  if(!saved) return;
  try{
    const match=saved.match(/:root\s*\{([^}]+)\}/s)||[null,saved];
    const vars=match[1]||saved;
    vars.split(';').forEach(decl=>{
      const [k,v]=(decl||'').split(':').map(s=>s.trim());
      if(k&&k.startsWith('--')&&v) document.documentElement.style.setProperty(k,v);
    });
  }catch(e){}
})();
