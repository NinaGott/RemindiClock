/* RemindiClock Web UI */
(function(){
  // Inject minimal style for active wifi button if not defined
  if(!document.getElementById('wc-inline-style')){
    const st=document.createElement('style'); st.id='wc-inline-style'; st.textContent=`button.active{outline:2px solid #1976d2; background:#1976d210}
    .wifi-item{display:flex;align-items:center;justify-content:space-between;gap:.5rem;min-width:180px}
    .wifi-name{flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .wifi-icon{position:relative;width:34px;height:14px;display:inline-block}
    .wifi-icon span{position:absolute;bottom:0;width:6px;background:#666;border-radius:1px;transition:.25s}
    .wifi-icon .b1{left:0;height:25%}
    .wifi-icon .b2{left:8px;height:25%}
    .wifi-icon .b3{left:16px;height:25%}
    .wifi-icon .b4{left:24px;height:25%}
    .wifi-icon.lvl2 .b1,.wifi-icon.lvl2 .b2{background:#4caf50;height:55%}
    .wifi-icon.lvl3 .b1,.wifi-icon.lvl3 .b2,.wifi-icon.lvl3 .b3{background:#4caf50;height:75%}
    .wifi-icon.lvl4 .b1,.wifi-icon.lvl4 .b2,.wifi-icon.lvl4 .b3,.wifi-icon.lvl4 .b4{background:#4caf50;height:100%}
    .wifi-icon.lvl1 .b1{background:#ff9800;height:40%}
    .wifi-icon.lvl1 .b2,.wifi-icon.lvl1 .b3,.wifi-icon.lvl1 .b4{opacity:.25}
    `; document.head.appendChild(st);
  }
  const app = document.getElementById('app');
  const State = {
    info:null,
    config:null,
    networks:[],
    scanning:false,
    step:0,
    wizardMode:true,
  skipWaste:false, // Nutzer hat Abfall-Schritt übersprungen
  waitWasteImport:false,
    toasts:[],
    connected:false,
    dashboard:null,
    scanTimer:null,
    dashTimer:null,
    scanStart:0,
    scanDuration:10000,
    selectedSSID:'',
    wifiPassword:'',
    selectedAddress:'',
  selectedTimezone:'',
  pendingWasteColors:null // lokale (noch nicht bestätigte) Farbauswahl
  ,wasteIcalDraft:''
  ,editingActive:false
  ,lastInputActivity:0
  // Drafts to keep wizard step 3 form values stable across background refreshes
  ,draftBirthday:{name:'',date:''}
  ,draftSingle:{name:'',date:'',color:'#ff8800'}
  ,draftSeries:{name:'',recur:'weekly',monthly_pos:'',weekdays:[],color:'#33aaff'}
  ,mqttNeedsRestart:false
  ,rebootWatching:false
  ,reimportInProgress:false
  ,wasteImportStartedAt:0
  ,otaStatus:null
  ,otaTimer:null
  ,marketDraft:{btc:undefined,msci:undefined}
  ,_histKey:''
  ,showWifiPassword:false
  };

  // ---- Farbpalette & Helfer (mobile freundlich) ----
  const STD_COLORS=[
    '#ffffff','#ff9800','#ff0000','#00ff00','#0000ff','#ffff00','#00ffff','#ff00ff','#00bfff'
  ];
  function colorChooser(name,initial){
    const wrap=h('div',{class:'color-chooser'});
    const hidden=h('input',{type:'hidden',name,value:initial||'#ffffff'});
    STD_COLORS.forEach(col=>{
      const btn=h('button',{type:'button',class:'swatch-small'+(col.toLowerCase()===(initial||'').toLowerCase()?' sel':''),style:'--c:'+col,onclick:ev=>{
        wrap.querySelectorAll('.swatch-small').forEach(s=>s.classList.remove('sel'));
        ev.currentTarget.classList.add('sel'); hidden.value=col;
      }},'');
      wrap.appendChild(btn);
    });
    const custom=h('input',{type:'color',class:'custom-color',value:initial||'#ffffff',oninput:e=>{ wrap.querySelectorAll('.swatch-small').forEach(s=>s.classList.remove('sel')); hidden.value=e.target.value; }});
    wrap.appendChild(custom); wrap.appendChild(hidden); return wrap;
  }

  // ---- Utility helpers ----
  const h=(tag,attrs={},...children)=>{
    const el=document.createElement(tag);
    for(const [k,v] of Object.entries(attrs||{})){
      if(k==='class') el.className=v; else if(k==='html') el.innerHTML=v; else if(k.startsWith('on')&&typeof v==='function') el.addEventListener(k.substring(2),v); else if(v!==false && v!=null) el.setAttribute(k,v===true?'':v);
    }
    for(const c of children.flat()){
      if(c==null) continue;
      if(typeof c==='string' || typeof c==='number' || typeof c==='boolean'){
        el.appendChild(document.createTextNode(String(c)));
      } else {
        el.appendChild(c);
      }
    }
    return el;
  };
  const api=async (url,opts={})=>{
    const r= await fetch(url,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});
    const ct=r.headers.get('content-type')||'';
    if(!r.ok){
      // Erlaube für /api/dashboard einen 401/403 mit JSON-Body, damit Login-Gate gerendert werden kann
      if((r.status===401 || r.status===403) && url.includes('/api/dashboard') && ct.includes('application/json')){
        const j=await r.json(); j.__httpStatus=r.status; return j;
      }
      throw new Error(r.status+' '+r.statusText);
    }
    if(ct.includes('application/json')) return await r.json();
    return await r.text();
  };
  const toast=(msg,type='info',timeout=4000)=>{
    const id=Date.now()+Math.random();
    const t={id,msg,type};
    State.toasts.push(t);renderToasts();
    if(timeout) setTimeout(()=>{State.toasts=State.toasts.filter(x=>x.id!==id);renderToasts();},timeout);
  };

  function renderToasts(){
    let c=document.querySelector('.toast-container');
    if(!c){c=h('div',{class:'toast-container'});document.body.appendChild(c);} 
    c.innerHTML='';
    State.toasts.forEach(t=>{
      c.appendChild(h('div',{class:'toast toast-'+t.type},t.msg));
    });
  }

  // ---- Wizard Steps ----
  function render(){
    const active=document.activeElement;
    const isEditable=active && ['INPUT','TEXTAREA','SELECT'].includes(active.tagName);
    let restoreKey=null; let caretPos=null; let restoreType=null;
    if(isEditable){
      restoreKey=active.getAttribute('data-fkey')||active.getAttribute('name')||active.id;
      restoreType=active.tagName;
      try{ if(active.selectionStart!=null) caretPos=active.selectionStart; }catch(_){}
    }
    app.innerHTML='';
    // Auth gate hard block: wenn Anmeldung erforderlich und nicht eingeloggt, nur Login anzeigen
    if(State.dashboard && State.dashboard.authRequired && !State.dashboard.authed){
      showLoginGate();
      return;
    }
    if(State.wizardMode) renderWizard(); else renderMain();
    // History handling: push only when view/step changes
    const key=(State.wizardMode?'wiz:'+State.step:'app:'+State.view+':'+(State.view==='Settings'? (State.subView||''):''));
    if(!State._histKey){
      try{ history.replaceState({app:1,wizard:State.wizardMode,step:State.step,view:State.view,sub:State.subView},''); }catch(_){ }
      State._histKey=key;
    } else if(State._histKey!==key){
      try{ history.pushState({app:1,wizard:State.wizardMode,step:State.step,view:State.view,sub:State.subView},''); }catch(_){ }
      State._histKey=key;
    }
    if(restoreKey){
      const el=document.querySelector(`[data-fkey="${restoreKey}"]`)||document.querySelector(`[name="${restoreKey}"]`)||document.getElementById(restoreKey);
      if(el && (!restoreType || el.tagName===restoreType)){
        el.focus({preventScroll:true});
        try{ if(caretPos!=null && el.setSelectionRange) el.setSelectionRange(caretPos,caretPos); }catch(_){}
      }
    }
  }

  function renderWizard(){
    // Fokus im Wizard merken
    let activeName=null, selStart=null, selEnd=null;
    const act=document.activeElement;
    if(act && ['INPUT','SELECT','TEXTAREA'].includes(act.tagName)){
      activeName=act.getAttribute('name')||act.id;
      try{ selStart=act.selectionStart; selEnd=act.selectionEnd; }catch(_){}}
    const wrap=h('div',{class:'wizard'});
  // Steps: 0 WLAN,1 Passwort (falls erforderlich),2 Adresse,3 Abfall,4 Termine(optional),5 Börsenkurse(optional),6 Fertig
    wrap.appendChild(h('div',{class:'steps'},
      [0,1,2,3,4,5].map(i=>h('span',{class: i===State.step?'active':''}))
    ));

  if(State.step===0){
      wrap.appendChild(h('h1',{},'WLAN verbinden'));
  wrap.appendChild(h('p',{},'Verbinde dich mit diesem Setup-WLAN und wähle dann dein Heimnetz.'));
  const list=h('div',{id:'wifi-list',class:'card'});
  list.appendChild(scanArea());
      wrap.appendChild(list);
      wrap.appendChild(h('div',{class:'divider'}));
  const form=h('form',{onsubmit:e=>{e.preventDefault();connectWifi(form)}});
  form.appendChild(h('label',{class:'field'},'SSID',h('input',{name:'ssid',required:true,placeholder:'Netzwerk',value:State.selectedSSID||'',oninput:e=>{State.selectedSSID=e.target.value;}})));
  const pwInput=h('input',{id:'wifi-password',name:'password',type: (State.showWifiPassword?'text':'password'),required:true,placeholder:'Passwort',value:State.wifiPassword||'',oninput:e=>{State.wifiPassword=e.target.value;}});
  const eyeBtn=h('button',{type:'button',class:'pw-toggle',title:(State.showWifiPassword?'Passwort verbergen':'Passwort anzeigen'),'aria-label':(State.showWifiPassword?'Passwort verbergen':'Passwort anzeigen'),onclick:()=>{ State.showWifiPassword=!State.showWifiPassword; try{ pwInput.setAttribute('type', State.showWifiPassword?'text':'password'); }catch(_){ } eyeBtn.textContent = State.showWifiPassword?'🙈':'👁'; eyeBtn.setAttribute('title', State.showWifiPassword?'Passwort verbergen':'Passwort anzeigen'); eyeBtn.setAttribute('aria-label', State.showWifiPassword?'Passwort verbergen':'Passwort anzeigen'); }}, State.showWifiPassword?'🙈':'👁');
  const pwWrap=h('div',{class:'pw-wrap'}, pwInput, eyeBtn);
  form.appendChild(h('label',{class:'field'},'Passwort',pwWrap));
      form.appendChild(h('div',{class:'actions'},h('button',{type:'submit'},'Verbinden')));
      wrap.appendChild(form);
      const hint=h('div',{class:'card'},
  h('p',{},'Falls keine Netze erscheinen: Gerät näher an Router, kurz warten und "Aktualisieren" drücken.'),
        h('p',{class:'small muted'},'Nach dem Verbinden wechselt dein Gerät ggf. automatisch ins Heimnetz. Diese Seite kann kurzzeitig nicht erreichbar sein.')
      ); 
      wrap.appendChild(hint);
    }
  else if(State.step===1){
      // Admin password step: now occurs immediately after WiFi connect if backend requires it
  const mustSet = State.dashboard?.stage === 'adminpass';
  const needsPw = mustSet || (!!State.dashboard?.authRequired && !State.dashboard?.authed);
      if(needsPw){
        wrap.appendChild(h('h1',{},'Admin Passwort'));
        wrap.appendChild(h('p',{},'Lege ein Passwort für die Weboberfläche fest.'));
        const f=h('form',{onsubmit:e=>{e.preventDefault();setAdminPassword(f,true);}});
        f.appendChild(field('Passwort','pw','password',''));
        f.appendChild(field('Wiederholen','pw2','password',''));
        wrap.appendChild(f);
        wrap.appendChild(h('div',{class:'actions'}, h('button',{onclick:()=>{ setAdminPassword(f,true); }},'Speichern & Weiter')));
      } else {
        // if not needed, skip ahead to address step
        State.step=2; render(); return;
      }
    } else if(State.step===2){
      // Address & location
      wrap.appendChild(h('h1',{},'Adresse & Standort'));
  wrap.appendChild(h('p',{},'Adresse bestimmt Zeitzone, Wetter- und Abfall-Region.'));
      if(State.dashboard){
        wrap.appendChild(h('div',{class:'card'},
          h('p',{},'WLAN-Verbindung erfolgreich. Gerät erreichbar unter:'),
          h('ul',{},
            h('li',{},'http://'+(State.dashboard.hostname? State.dashboard.hostname.toLowerCase() : 'remindiclock')),
            h('li',{},'IP: '+(State.dashboard.ip||'-'))
          ),
          h('p',{class:'small muted'},'Füge die Seite am besten jetzt zu deinen Favoriten hinzu.')
        ));
      }
  if(!State.selectedAddress) State.selectedAddress = State.dashboard?.address||'';
  if(!State.selectedTimezone) State.selectedTimezone = State.dashboard?.timezone||'Europe/Berlin';
  const form=h('form',{onsubmit:e=>{e.preventDefault();saveAddress(form);}});
  // Structured address inputs
  if(!State.addrPostal) State.addrPostal = State.dashboard?.postalCode||'';
  if(!State.addrCity) State.addrCity = State.dashboard?.city||'';
  if(!State.addrCountry) State.addrCountry = State.dashboard?.country||'Deutschland';
  form.appendChild(h('div',{class:'field-row'},
    h('label',{class:'field compact'},'PLZ',h('input',{name:'postalCode',placeholder:'12345',value:State.addrPostal,oninput:e=>{State.addrPostal=e.target.value;}})),
    h('label',{class:'field compact'},'Stadt',h('input',{name:'city',required:true,placeholder:'Stadt',value:State.addrCity,oninput:e=>{State.addrCity=e.target.value;}})),
    h('label',{class:'field compact'},'Land',h('input',{name:'country',placeholder:'Deutschland',value:State.addrCountry,oninput:e=>{State.addrCountry=e.target.value;}}))
  ));
  // Search button & results
  form.appendChild(h('div',{class:'actions'},
    h('button',{type:'button',class:'secondary',onclick:citySearch},'Orte suchen')
  ));
  if(State.cityResults && State.cityResults.length){
    const list=h('div',{class:'card'}, h('p',{},'Treffer auswählen:'),
      ...State.cityResults.map(r=> h('button',{class:'secondary',onclick:()=>selectCityResult(r)}, `${r.name} (${r.admin1||''} ${r.country||''}) ${r.latitude.toFixed(2)},${r.longitude.toFixed(2)}`))
    );
    form.appendChild(list);
  }
  // Zeitzone & Koordinaten werden aus gewähltem Suchtreffer übernommen (kein separates Feld mehr)
  if(State.selectedCityResult){
    form.appendChild(h('div',{class:'card small'},
      h('p',{},'Ausgewählt: '+State.selectedCityResult.name+' ('+(State.selectedCityResult.admin1||'')+' '+(State.selectedCityResult.country||'')+')'),
      h('p',{class:'small muted'},'TZ: '+State.selectedCityResult.timezone+'  '+State.selectedCityResult.latitude.toFixed(2)+','+State.selectedCityResult.longitude.toFixed(2))
    ));
    // Save button only after a selection has been made
    form.appendChild(h('div',{class:'actions'},
      h('button',{type:'submit'},'Speichern')
    ));
  }
      wrap.appendChild(form);
  } else if(State.step===3){
      wrap.appendChild(h('h1',{},'Abfallkalender'));
      wrap.appendChild(h('p',{},'iCal Link des regionalen Entsorgers einrichten.'));
      // Region Hinweis basierend auf PLZ / Stadt
      if(State.dashboard){
        const plz=State.dashboard.postalCode||''; const city=State.dashboard.city||'';
        wrap.appendChild(h('div',{class:'card'},
          h('p',{},'Erkannte Region: '+(plz?plz+' ':'')+city),
          h('p',{class:'small muted'},'Klicke den Anbieter-Link, kopiere deine erzeugte iCal URL und füge diese im Formular unten ein.')
        ));
        if(State.dashboard.wasteProviderName){
          wrap.appendChild(h('div',{class:'card'},
            h('p',{},'1. Lokaler Entsorger: '+State.dashboard.wasteProviderName),
            h('p',{},h('a',{href:State.dashboard.wasteProviderUrl,target:'_blank'},'Website öffnen und iCal URL kopieren'))
          ));
        }
        if(State.dashboard.wasteProviderSearchUrl){
          wrap.appendChild(h('div',{class:'card'},
            h('p',{},'2. Falls nicht passend: '),
            h('p',{},h('a',{href:State.dashboard.wasteProviderSearchUrl,target:'_blank'},'Google Suche nach regionalem Abfuhrkalender'))
          ));
        }
      }
  if(!State.wasteIcalDraft && State.dashboard?.wasteIcalUrl) State.wasteIcalDraft=State.dashboard.wasteIcalUrl;
  const form=h('form',{onsubmit:e=>{e.preventDefault();saveWaste(form);}});
  form.appendChild(h('label',{class:'field'},'3. iCal URL vom lokalen Entsorger einfügen',h('input',{name:'url',type:'url',placeholder:'https://...',value:State.wasteIcalDraft||'',oninput:e=>{State.wasteIcalDraft=e.target.value;}})));
    // Aktionen: Importieren + Überspringen nebeneinander (Skip nur wenn noch nicht bestätigt)
    const actionChildren=[ h('button',{type:'submit'}, State.dashboard?.wasteIcalUrl?'Neu laden':'Importieren') ];
    if(!State.dashboard?.wasteConfirmed){
      actionChildren.push(
        h('button',{type:'button',class:'secondary',onclick:()=>{
          if(!State.skipWaste){ State.skipWaste=true; localStorage.setItem('rcSkipWaste','1'); }
          // Überspringe Pflichtschritt lokal und fahre mit optionalen Schritten fort (Events)
          sendWizardStage('events');
          State.step=4; State.view=null; render();
        }},'Überspringen')
      );
    }
    form.appendChild(h('div',{class:'actions'}, actionChildren));
    wrap.appendChild(form);
    // Color selection (only if events present)
    if(State.dashboard?.wasteEvents){
      const colorForm=h('form',{onsubmit:e=>{e.preventDefault();/* kein submit */}});
      const normalize=(v,def)=>{
        if(!v) v=def; if(typeof v!=="string") return def; // fallback
        if(!v.startsWith('#')) v='#'+v; // ensure leading #
        v=v.trim();
        const m=v.match(/^#([0-9A-Fa-f]{6})$/); if(!m) return def;
        return '#'+m[1].toLowerCase();
      };
      const defaults={ bio:'#228b22', residual:'#ffffff', paper:'#0000ff', packaging:'#ffd700', green:'#006400' };
      const addColor=(label,name,serverVal)=>{
        const local = State.pendingWasteColors && State.pendingWasteColors[name];
        const val = local || serverVal || defaults[name];
        const norm=normalize(val, defaults[name]);
        const input=h('input',{type:'color',name,value:norm,oninput:e=>{
          if(!State.pendingWasteColors) State.pendingWasteColors={};
          State.pendingWasteColors[name]=e.target.value; // persist Auswahl
        }});
        const wrap=h('label',{class:'field'},label,input);
        colorForm.appendChild(wrap);
      };
      addColor('Bioabfall','bio',State.dashboard.wasteColorBio);
      addColor('Restmüll','residual',State.dashboard.wasteColorResidual);
      addColor('Papier','paper',State.dashboard.wasteColorPaper);
      addColor('Verpackung (gelber Sack / Tonne)','packaging',State.dashboard.wasteColorPackaging);
      addColor('Gartenschnitt','green',State.dashboard.wasteColorGreen);
      // Reset button restores defaults and saves; confirm also saves + confirms
      const doReset=async()=>{
        State.pendingWasteColors={...defaults};
        Object.entries(defaults).forEach(([k,v])=>{ const inp=colorForm.querySelector(`input[name=${k}]`); if(inp) inp.value=v; });
        // Defaults sofort speichern
        try{ await api('/api/waste/colors',{method:'POST',body:JSON.stringify(State.pendingWasteColors)}); toast('Standardfarben gesetzt','success'); await refreshDashboard(); }catch(e){ toast('Fehler beim Zurücksetzen','error'); }
        render();
      };
      colorForm.appendChild(h('div',{class:'actions'},
        h('button',{type:'button',class:'secondary',onclick:doReset},'Farben zurücksetzen'),
        h('button',{type:'button',class:'primary',onclick:()=>confirmWasteSetup(colorForm),disabled:!State.dashboard.wasteEvents || State.dashboard.wasteConfirmed}, State.dashboard.wasteConfirmed?'Bestätigt':'Speichern & Bestätigen')
      ));
      wrap.appendChild(colorForm);
    }
    if(!State.dashboard?.wasteConfirmed){
      wrap.appendChild(h('div',{class:'card'},h('p',{class:'small muted'},'Bearbeiten der einzelnen Farben kann später in den Einstellungen erfolgen.')));
    } else {
      wrap.appendChild(h('div',{class:'actions'},h('button',{onclick:()=>{State.step=3;render();}},'Weiter')));
    }
    // Wenn bereits importiert oder gerade import läuft -> Tabelle anzeigen sobald Events da
    if(State.dashboard?.wasteEvents){
      const cats=[
        {k:'bio',label:'Bioabfall'},
        {k:'residual',label:'Restmüll'},
        {k:'paper',label:'Papier'},
        {k:'packaging',label:'Verpackung (Gelber Sack / Tonne)'},
        {k:'green',label:'Gartenschnitt'}
      ];
      const tbl=h('div',{class:'card'});
      tbl.appendChild(h('header',{},h('h3',{},'Gefundene Termine')));
      cats.forEach(c=>{
        const arr=State.dashboard.wasteEvents[c.k]||[];
        if(!arr.length) return;
        tbl.appendChild(h('section',{},h('h4',{},c.label+' ('+arr.length+')'),h('ul',{},arr.slice(0,40).map(d=>h('li',{},d)))));
      });
      if(tbl.querySelector('section')) wrap.appendChild(tbl); else wrap.appendChild(h('div',{class:'card'},h('p',{},'Noch keine Termine importiert.')));
    } else if(State.dashboard?.wasteIcalUrl){
      // Import läuft: bei langer Dauer Button zum erneuten Prüfen anzeigen
      const box=h('div',{class:'card'});
      box.appendChild(h('p',{},'Import läuft...'));
      const stuck = State.wasteImportStartedAt && (Date.now()-State.wasteImportStartedAt>90000);
      if(stuck){
        box.appendChild(h('p',{class:'small muted'},'Das dauert länger als üblich. Du kannst die Prüfung erneut starten.'));
        box.appendChild(h('div',{class:'actions'},
          h('button',{class:'secondary',onclick:async()=>{ await refreshDashboard(true); render(); }},'Erneut prüfen')
        ));
      }
      wrap.appendChild(box);
    }
  } else if(State.step===4){
      wrap.appendChild(h('h1',{},'Termine & Geburtstage'));
      wrap.appendChild(h('p',{},'Lege wiederkehrende oder einzelne Termine sowie Geburtstage an. Dies kann auch später in den Einstellungen erfolgen.'));
      // Simple inline forms (reuse helper builders later in settings view)
      const section=h('div',{class:'grid'});
      // Birthday form
      const fb=h('form',{onsubmit:e=>{e.preventDefault();addBirthdayWizard(fb);}});
  fb.appendChild(fieldInline('Name','birthday_name','text',State.draftBirthday.name||'', 'birthday_name'));
  fb.querySelector('input[name=birthday_name]').addEventListener('input',e=>{State.draftBirthday.name=e.target.value;});
  fb.appendChild(fieldInline('Geburtstag','birthday_date','date',State.draftBirthday.date||'', 'birthday_date'));
  fb.querySelector('input[name=birthday_date]').addEventListener('input',e=>{State.draftBirthday.date=e.target.value;});
      fb.appendChild(h('div',{class:'actions'},h('button',{type:'submit'},'Geburtstag hinzufügen')));
      section.appendChild(h('div',{class:'card'},h('header',{},h('h3',{},'Geburtstag')),fb));
      // Single event form
  const fs=h('form',{onsubmit:e=>{e.preventDefault();addSingleWizard(fs);}});
  fs.appendChild(fieldInline('Name','single_name','text',State.draftSingle.name||'', 'single_name'));
  fs.querySelector('input[name=single_name]').addEventListener('input',e=>{State.draftSingle.name=e.target.value;});
  fs.appendChild(fieldInline('Datum','single_date','date',State.draftSingle.date||'', 'single_date'));
  fs.querySelector('input[name=single_date]').addEventListener('input',e=>{State.draftSingle.date=e.target.value;});
  const singleColorChooser=colorChooser('color',State.draftSingle.color||'#ff8800');
  singleColorChooser.addEventListener('input',e=>{ if(e.target && e.target.name==='color'){ State.draftSingle.color=e.target.value; }});
  fs.appendChild(labelWrap('Farbe',singleColorChooser));
      fs.appendChild(h('div',{class:'actions'},h('button',{type:'submit'},'Einmaligen Termin hinzufügen')));
      section.appendChild(h('div',{class:'card'},h('header',{},h('h3',{},'Einmaliger Termin')),fs));
      // Series event form
  const fser=h('form',{onsubmit:e=>{e.preventDefault();addSeriesWizard(fser);}});
  fser.appendChild(fieldInline('Name','series_name','text',State.draftSeries.name||'', 'series_name'));
  fser.querySelector('input[name=series_name]').addEventListener('input',e=>{State.draftSeries.name=e.target.value;});
      // recurrence select
      const recurSel=h('select',{name:'recur',onchange:e=>{State.draftSeries.recur=e.target.value;toggleMonthlyPos(fser);}},
        h('option',{value:'weekly'},'Wöchentlich'),
        h('option',{value:'biweekly'},'14-tägig'),
        h('option',{value:'monthly'},'Monatlich')
      );
      fser.appendChild(labelWrap('Wiederholung',recurSel));
      // monthly position select
      const mPosSel=h('select',{name:'monthly_pos',style:'display:none',onchange:e=>{State.draftSeries.monthly_pos=e.target.value;}},
        h('option',{value:''},'- Position -'),
        h('option',{value:'1'},'Erster'),
        h('option',{value:'2'},'Zweiter'),
        h('option',{value:'3'},'Dritter'),
        h('option',{value:'4'},'Vierter')
      );
      fser.appendChild(labelWrap('Monats-Pos',mPosSel));
      // weekdays checkboxes
      const wdays=['Mo','Di','Mi','Do','Fr','Sa','So'];
      const wdWrap=h('div',{class:'weekday-select'});
      wdays.forEach((lbl,i)=>{
        const idx=i+1; // 1..7
        const checked= Array.isArray(State.draftSeries.weekdays) && State.draftSeries.weekdays.includes(idx);
        const cb=h('label',{class:'wd'},h('input',{type:'checkbox',value:String(idx),name:'wd',checked:checked?true:false}),lbl);
        wdWrap.appendChild(cb);
      });
      fser.appendChild(labelWrap('Wochentage',wdWrap));
      const seriesColorChooser=colorChooser('color',State.draftSeries.color||'#33aaff');
      seriesColorChooser.addEventListener('input',e=>{ if(e.target && e.target.name==='color'){ State.draftSeries.color=e.target.value; }});
      fser.appendChild(labelWrap('Farbe',seriesColorChooser));
      fser.appendChild(h('div',{class:'actions'},h('button',{type:'submit'},'Serientermin hinzufügen')));
      section.appendChild(h('div',{class:'card'},h('header',{},h('h3',{},'Serientermin')),fser));
      // Apply stored recurrence & monthly pos
      setTimeout(()=>{ recurSel.value=State.draftSeries.recur||'weekly'; toggleMonthlyPos(fser); if(recurSel.value==='monthly' && State.draftSeries.monthly_pos){ mPosSel.style.display=''; mPosSel.value=State.draftSeries.monthly_pos; } },0);
      // Update weekday draft on change
      fser.addEventListener('change',e=>{ if(e.target && e.target.name==='wd'){ State.draftSeries.weekdays = collectWeekdays(fser); }});
      wrap.appendChild(section);
      wrap.appendChild(h('div',{class:'actions'},
        h('button',{class:'secondary',onclick:()=>{ sendWizardStage('markets'); State.step=5; render(); }},'Überspringen'),
        h('button',{onclick:()=>{ sendWizardStage('markets'); State.step=5; render(); }},'Weiter')
      ));
    } else if(State.step===5){
      // New markets step (BTC / MSCI)
      wrap.appendChild(h('h1',{},'Börsenkurse'));
      wrap.appendChild(h('p',{},'Aktivierte die Anzeige der Bitcoin oder MSCI World ETF Kursänderungen. Die Anzeige erfolgt bei Tagesveränderung > ±0.5% gegenüber dem Vortag.'));
      const form=h('form',{onsubmit:e=>{e.preventDefault(); saveMarkets(form); }});
      const btcSel=h('select',{name:'btc','data-fkey':'markets_btc'},
        h('option',{value:'off'},'Deaktiviert'),
        h('option',{value:'auto'},'Automatisch')
      );
      const msciSel=h('select',{name:'msci','data-fkey':'markets_msci'},
        h('option',{value:'off'},'Deaktiviert'),
        h('option',{value:'auto'},'Automatisch')
      );
      // Initial aus Dashboard nur falls kein Draft existiert
      if(State.marketDraft.btc===undefined){
        // Wizard Default: Immer 'auto' anzeigen, wenn Nutzer noch nichts gewählt hat
        State.marketDraft.btc = 'auto';
      }
      if(State.marketDraft.msci===undefined){
        // Wizard Default: Immer 'auto' anzeigen, wenn Nutzer noch nichts gewählt hat
        State.marketDraft.msci = 'auto';
      }
      btcSel.value=State.marketDraft.btc;
      msciSel.value=State.marketDraft.msci;
      btcSel.addEventListener('change',()=>{ State.marketDraft.btc=btcSel.value; State._marketsTouched=true; });
      msciSel.addEventListener('change',()=>{ State.marketDraft.msci=msciSel.value; State._marketsTouched=true; });
      form.appendChild(labelWrap('BTC', btcSel));
      form.appendChild(labelWrap('MSCI', msciSel));
      form.appendChild(h('div',{class:'actions'},
        h('button',{type:'button',class:'secondary',onclick:()=>{ State.step=6; sendWizardStage('review'); render(); }},'Überspringen'),
        // Wichtig: kein onclick auf dem Submit-Button, damit das onsubmit (saveMarkets) zuerst ausgeführt werden kann
        h('button',{type:'submit'},'Speichern & Weiter')
      ));
      wrap.appendChild(form);
    } else if(State.step===5){
      // final finish
    } else if(State.step===6){
      wrap.appendChild(h('h1',{},'Fertig'));
      wrap.appendChild(h('p',{},'Die Konfiguration deiner Remindi-Clock ist abgeschlossen.'));
      wrap.appendChild(h('div',{class:'actions'},h('button',{onclick:()=>{ localStorage.setItem('rcWizardDone','1'); sendWizardStage('done'); State.wizardMode=false; State.view='Dashboard'; render(); }},'Zum Dashboard')));
    }
    app.appendChild(wrap);
    // Versuche Fokus wiederherzustellen
    if(activeName){
      const el=app.querySelector(`[name="${activeName}"]`);
      if(el){ el.focus({preventScroll:true}); try{ if(selStart!=null && selEnd!=null && el.setSelectionRange) el.setSelectionRange(selStart, selEnd); }catch(_){ } }
    }
  // Return password input ref for focus restore
  if(State.step===0) return document.getElementById('wifi-password');
  return null;
  }

  function renderMain(){
    const header=h('header',{class:'appbar'},
      h('h1',{},'RemindiClock'),
      State.dashboard?.apMode? h('span',{class:'badge',style:'background:#b71c1c'},'AP MODE'):null,
      h('nav',{class:'tabs'},
  ['Dashboard','Einstellungen'].map(name=>
          h('button',{class: State.view===name? 'active':'',onclick:()=>{State.view=name;render();}},name)
        )
      )
    );
    app.appendChild(header);
    if(!State.view) State.view='Dashboard';
    const main=h('main');
    if(State.view==='Dashboard'){
      main.appendChild(viewDashboard());
    } else if(State.view==='Einstellungen'){
      main.appendChild(viewSettingsHub());
    }
    // Logout nur im Dashboard und unten über dem Footer anzeigen
    if(State.view==='Dashboard' && State.dashboard?.authRequired){
      const bottom=h('div',{class:'logout-bottom'},
        h('div',{class:'actions',style:'justify-content:center;margin:1rem 0'},
          h('button',{onclick:logout},'Logout')
        )
      );
      main.appendChild(bottom);
    }
    main.appendChild(h('footer',{},'Remindi © '+new Date().getFullYear()));
    app.appendChild(main);
  }

  // ---- Individual Views ----
  function statusDot(ok){return h('span',{class:'status-dot '+(ok===true?'status-online':ok===false?'status-offline':'status-unknown')});}
  function card(title,body,actions){
    const cardWrap=h('div',{class:'card'});
    cardWrap.appendChild(h('header',{},h('h3',{},title)));
    if(body) cardWrap.appendChild(body);
    if(actions){
      // Wenn body ein FORM ist, Actions in das Formular einbetten damit submit funktioniert
      const actWrap=h('div',{class:'actions'});
      if(Array.isArray(actions)) actions.forEach(a=>actWrap.appendChild(a)); else actWrap.appendChild(actions);
      if(body && body.tagName==='FORM') body.appendChild(actWrap); else cardWrap.appendChild(actWrap);
    }
    return cardWrap;
  }

  function viewDashboard(){
    const g=h('div',{class:'cards'});
    // Anzeige Box
    const tagsWrap=h('div',{class:'tags'});
    if(State.dashboard?.extra && Array.isArray(State.dashboard.extra)){
      State.dashboard.extra.forEach(w=>{
        const tag=h('span',{class:'word-tag',style:'--col:'+(w.color||'#444')},w.name);
        tagsWrap.appendChild(tag);
      });
      if(!State.dashboard.extra.length){ tagsWrap.appendChild(h('span',{class:'muted'},'Keine Zusatzwörter aktiv')); }
    } else {
      tagsWrap.appendChild(h('span',{class:'muted'},'Keine Daten'));
    }
    const phraseEl=h('div',{class:'phrase'}, State.dashboard?.phrase || '—');
    g.appendChild(card('Anzeige',h('div',{}, phraseEl, tagsWrap)));
    // Services Box mit grünen/roten Kreisen
    const services=h('div',{},
      serviceLine('Uhrzeit', State.dashboard?.timeSync),
      serviceLine('Wetter', State.dashboard?.weather_ok),
      serviceLine('Termine', State.dashboard?.birthdays),
      serviceLine('Abfallkalender', State.dashboard?.waste_ok),
      serviceLine('Börse BTC', State.dashboard?.btc_ok),
      serviceLine('Börse MSCI', State.dashboard?.msci_ok),
      serviceLine('MQTT', State.dashboard?.mqtt)
    );
    g.appendChild(card('Services', services, h('button',{class:'secondary',onclick:refreshDashboard},'Aktualisieren')));
    return g;
  }
  function serviceLine(label,ok){ return h('div',{class:'inline'},statusDot(ok===true),h('span',{},label)); }
  function statusLine(label,val){
    let ok=null; if(typeof val==='boolean') ok=val; if(label==='Aktuelle Zeit') ok=val && val!=='--:--';
    return h('div',{class:'inline'},statusDot(ok),h('span',{},label+': '+(val==null?'?':val)));
  }

  // Settings hub with subtabs
  function viewSettingsHub(){
    if(!State.subView || State.subView==='Allgemein') State.subView='Gerät';
    const wrap=h('div',{});
  const tabs=['Gerät','Helligkeit','Wetter','Abfall','Termine','Börsen','MQTT'];
    // Ensure valid tab selection
    if(!tabs.includes(State.subView)) State.subView='Gerät';
    wrap.appendChild(h('div',{class:'subtabs'}, tabs.map(t=> h('button',{class:State.subView===t?'active':'',onclick:()=>{State.subView=t; if(t==='Termine' && !State.eventsLoaded) loadEvents(); render();}},t))));
    let content;
    switch(State.subView){
  case 'Gerät': content=viewDevice(); break;
      case 'Helligkeit': content=viewBrightness(); break;
      case 'Wetter': content=viewWeather(); break;
      case 'Abfall': content=viewWaste(); break;
  case 'Termine': content=viewEvents(); break;
  case 'Börsen': content=viewMarkets(); break;
  case 'MQTT': content=viewMQTT(); break;
    }
    wrap.appendChild(content);
    return wrap;
  }

  function viewDevice(){
    const d=State.dashboard||{};
    const wrap=h('div',{class:'grid'});
    // Reihenfolge: Geräteinfo, Software Update, Wort UPDATE, Neustart, Werkseinstellungen
    const info=h('div',{},
      lineKV('IP', d.ip||'-'),
      lineKV('WLAN', [ (d.wifi_ssid? d.wifi_ssid:'-'), rssiIcon(d.wifi_rssi) ]),
      lineKV('Uptime', formatUptime(d.uptime_ms)),
      lineKV('Zeitzone', d.timezone||'-'),
      lineKV('Firmware', d.version||'?')
    );
    wrap.appendChild(card('Geräteinfo',info));
    wrap.appendChild(buildOtaCard());
    // UPDATE Wort Toggle (Style analog Wetter AUTO/AUS Buttons -> verwenden Klasse inline-btns und .mini Buttons)
    const updMode = (d.updateWordMode)|| (d.weatherWords && d.weatherWords.UPDATE && d.weatherWords.UPDATE.mode) || 'auto';
    const updWrap=h('div',{});
  const btnRow=h('div',{class:'inline-btns mode-buttons'});
    function renderUpdBtns(){
      btnRow.innerHTML='';
      [['auto','AUTO'],['disabled','AUS']].forEach(([m,label])=>{
        btnRow.appendChild(h('button',{class:'mini'+(updWrap.dataset.mode===m?' active':''),onclick:()=>{ updWrap.dataset.mode=m; renderUpdBtns(); }},label));
      });
    }
    updWrap.dataset.mode= (updMode==='disabled')? 'disabled':'auto';
    renderUpdBtns();
    const saveBtn=h('button',{onclick:async()=>{
      const mode=updWrap.dataset.mode;
      try {
        await api('/api/settings/weather-words',{method:'POST',body:JSON.stringify({ UPDATE:{ enabled: mode==='auto' } })});
        toast('UPDATE Wort gespeichert','success');
        await refreshDashboard(true);
      } catch(e){ toast('Fehler beim Speichern','error'); }
    }},'Speichern');
    updWrap.appendChild(h('p',{class:'small'},'Wort "UPDATE" anzeigen bei verfügbarem/aktivem Update.'));
    updWrap.appendChild(btnRow);
    updWrap.appendChild(h('div',{class:'actions'},saveBtn));
    wrap.appendChild(card('Wort UPDATE', updWrap));
    const restartBox=h('div',{},h('p',{},'Neustart des Geräts durchführen.'),h('button',{onclick:confirmRestart},'Neustart'));
    wrap.appendChild(card('Neustart',restartBox));
    const resetBox=h('div',{},
      h('p',{},'Alle gespeicherten Konfigurationen und Daten werden dauerhaft gelöscht (WLAN/MQTT, Adresse/Koordinaten, Abfall-URL und -Cache, Termine/Geburtstage, Zusatzwörter, Debug-Log, OTA-Zustände).'),
  h('p',{class:'small muted'},'Nach dem Reset startet das Gerät im Access-Point Modus (SSID: RemindiClock-Setup, Passwort siehe Anleitung). Die Weboberfläche ist dann unter http://192.168.4.1 erreichbar.'),
      h('button',{class:'danger',onclick:factoryResetConfirm},'Werkseinstellungen')
    );
    wrap.appendChild(card('Werkseinstellungen',resetBox));
    return wrap;
  }
  function buildOtaCard(){
    const box=h('div',{});
    const st=State.otaStatus;
    if(!st){ box.appendChild(h('p',{},'OTA Status wird geladen...')); loadOTAStatus(); return card('Software Update',box); }
    if(st.hasUpdate){
      if(st.metadataVersion){
        box.appendChild(h('div',{class:'kv'},h('strong',{},'Verfügbare Version: '),h('span',{},st.metadataVersion)));
      }
      if(st.changelog){
        box.appendChild(h('details',{},h('summary',{},'Changelog anzeigen'), h('pre',{style:'white-space:pre-wrap;font-size:0.75rem;'}, st.changelog)));
      }
      const btn=h('button',{class:'primary',onclick:()=>startOTAUpdate(btn,st.metadataVersion)},'Update installieren');
      box.appendChild(h('div',{class:'actions'},btn));
    } else {
      // Kein Update: aktuelle Version aus Dashboard falls vorhanden anzeigen
      const cur=State.dashboard?.version || st.metadataVersion || 'unbekannt';
      box.appendChild(h('p',{},'Firmware aktuell: '+cur));
    }
    if(localStorage.getItem('rcPendingUpdateTarget')){
      box.appendChild(h('p',{class:'small'},'Update läuft – Bitte warten, Gerät startet neu...'));
    }
    return card('Software Update', box);
  }
  async function loadOTAStatus(){ try { const s=await api('/api/ota/status'); State.otaStatus=s; } catch(e){} render(); }
  async function startOTAUpdate(btn,targetVersion){
    if(!confirm('Update auf Version '+targetVersion+' installieren?')) return;
    const done=setLoading(btn);
    try {
      const prevVer=State.dashboard?.version||'';
      if(targetVersion){
        localStorage.setItem('rcPendingUpdateTarget',targetVersion);
        localStorage.setItem('rcPendingUpdatePrev',prevVer);
        localStorage.setItem('rcPendingUpdateTs',String(Date.now()));
      }
      const r=await fetch('/api/ota/firmware',{method:'POST'});
      if(r.ok){
        toast('Update gestartet – Bitte warten...');
        btn.disabled=true; btn.textContent='Bitte warten...';
        beginRebootWatch(true);
      } else {
        toast('Update Start fehlgeschlagen','error');
        localStorage.removeItem('rcPendingUpdateTarget');
        localStorage.removeItem('rcPendingUpdatePrev');
        localStorage.removeItem('rcPendingUpdateTs');
      }
    } catch(e){
      toast('Netzwerkfehler','error');
      localStorage.removeItem('rcPendingUpdateTarget');
      localStorage.removeItem('rcPendingUpdatePrev');
      localStorage.removeItem('rcPendingUpdateTs');
    } finally { done(); }
  }
  async function setAdminPassword(form, proceed){
    const data=Object.fromEntries(new FormData(form).entries());
    const pw=(data.pw||'').trim(); const pw2=(data.pw2||'').trim();
    if(pw.length<4){ toast('Passwort zu kurz','warn'); return; }
    if(pw!==pw2){ toast('Passwörter stimmen nicht überein','error'); return; }
    try{
  await api('/api/auth/set',{method:'POST',body:JSON.stringify({password:pw})});
      toast('Passwort gesetzt','success');
      await refreshDashboard();
  if(proceed){ State.step=2; render(); }
    } catch(e){ toast('Fehler beim Setzen','error'); }
  }
  function showLoginGate(){
    const existing=document.getElementById('login-gate'); if(existing) return;
    const gate=document.createElement('div'); gate.id='login-gate'; gate.className='login-gate';
    const box=document.createElement('div'); box.className='login-box';
    const h2=document.createElement('h2'); h2.textContent='Anmeldung erforderlich'; box.appendChild(h2);
    const form=document.createElement('form'); form.onsubmit=async (e)=>{ e.preventDefault(); const pw=form.querySelector('input[name=pw]').value; await doLogin(pw); };
    const lbl=document.createElement('label'); lbl.className='field'; lbl.textContent='Passwort';
    const inp=document.createElement('input'); inp.type='password'; inp.name='pw'; lbl.appendChild(inp);
    form.appendChild(lbl);
    const actions=document.createElement('div'); actions.className='actions';
    const btn=document.createElement('button'); btn.type='submit'; btn.textContent='Anmelden'; actions.appendChild(btn);
  const forgot=document.createElement('button'); forgot.type='button'; forgot.className='secondary'; forgot.textContent='Passwort vergessen'; forgot.onclick=()=>forgotPassword(); actions.appendChild(forgot);
    form.appendChild(actions);
    box.appendChild(form);
    gate.appendChild(box);
    document.body.appendChild(gate);
    setTimeout(()=>{ inp.focus(); },0);
  }
  async function doLogin(pw){
    try{ await api('/api/auth/login',{method:'POST',body:JSON.stringify({password:pw})}); toast('Angemeldet','success'); await refreshDashboard(true); const gate=document.getElementById('login-gate'); if(gate) gate.remove(); } catch(e){ toast('Falsches Passwort','error'); }
  }
  async function logout(){ try{ await fetch('/api/auth/logout',{method:'POST'}); await refreshDashboard(true); showLoginGate(); }catch(e){} }
  async function forgotPassword(){
    if(!confirm('Werkseinstellungen ausführen? Alle Daten gehen verloren.')) return;
    try{
      await fetch('/api/settings/factory-reset/public',{method:'POST'});
    }catch(_){ /* ignore */ }
    // Zeige sofort Hinweis + Reboot-Watch
    toast('Werkseinstellungen aktiviert. Gerät startet neu...','warn');
    beginRebootWatch(true);
  }
  function lineKV(k,v){
    const valSpan=h('span',{});
    if(Array.isArray(v)) v.forEach(x=>{ if(typeof x==='string') valSpan.appendChild(document.createTextNode(x)); else if(x) valSpan.appendChild(x); });
    else if(typeof v==='string' || typeof v==='number') valSpan.textContent=String(v);
    else if(v && v.nodeType) valSpan.appendChild(v); // DOM node
    else if(v!==undefined && v!==null) valSpan.textContent=String(v);
    return h('div',{class:'kv'},h('strong',{},k+': '),valSpan);
  }
  function rssiIcon(r){
    if(r==null) return '';
    let lvl=1; if(r>-55) lvl=4; else if(r>-65) lvl=3; else if(r>-75) lvl=2; else lvl=1;
    const bars=[1,2,3,4].map(i=>{
      const active = i<=lvl;
      const bh=4+i*3; // steigende Höhe
      const x=(i-1)*4;
      const y=16-bh;
      return `<rect x="${x}" y="${y}" width="3" height="${bh}" rx="1" fill="${active?'#0af':'#ccc'}"/>`;
    }).join('');
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="16" viewBox="0 0 16 16" style="vertical-align:middle;margin-left:4px">${bars}</svg>`;
    return h('span',{class:'wifi-rssi',html:svg});
  }
  function formatUptime(ms){ if(!ms && ms!==0) return '-'; const s=Math.floor(ms/1000); const d=Math.floor(s/86400); const h=Math.floor((s%86400)/3600); const m=Math.floor((s%3600)/60); let out=''; if(d) out+=d+'d '; out+=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0'); return out; }
  function confirmRestart(){ if(!confirm('Gerät wirklich neu starten?')) return; fetch('/api/restart',{method:'POST'}).then(()=>toast('Neustart ausgeführt')); }
  function factoryResetConfirm(){
    if(!confirm('Alle gespeicherten Konfigurationen und Daten werden dauerhaft gelöscht. Fortfahren?')) return;
    factoryReset();
  }

  function viewBrightness(){
    const c=h('div',{class:'grid'});
    const f=h('form',{onsubmit:e=>{e.preventDefault();saveBrightness(f);}});
  // Map rawBrightness (1..255) to percentage (1..100)
  const raw=State.dashboard?.rawBrightness||128;
  const pct=Math.min(100,Math.max(1, Math.round(raw*100/255)));
  f.appendChild(h('label',{class:'field'},'Helligkeit',h('input',{type:'range',name:'brightnessPercent',min:1,max:100,value:pct,oninput:e=>{e.target.nextSibling.textContent=e.target.value+'%';}}),h('span',{},pct+'%')));
    const nightSel=h('select',{name:'night'},
      h('option',{value:'off'},'Aus'),
      h('option',{value:'on'},'An')
    );
    const currentNight = (State.dashboard?.nightModeRaw==='on')? 'on':'off';
    setTimeout(()=>{ nightSel.value=currentNight; toggleNightFields(); },0);
    f.appendChild(h('label',{class:'field'},'Nachtmodus',nightSel));
    // Night schedule fields
    const nfWrap = h('div',{class:'night-fields'});
    const nh = State.dashboard?.nightStartHour ?? 22;
    const nm = State.dashboard?.nightStartMinute ?? 0;
    const eh = State.dashboard?.nightEndHour ?? 6;
    const em = State.dashboard?.nightEndMinute ?? 0;
    const nb = State.dashboard?.nightBrightness ?? 30;
    nfWrap.appendChild(h('label',{class:'field'},'Start (HH:MM)',
      h('input',{type:'number',name:'nightStartHour',min:0,max:23,value:nh,style:'width:70px'}),
      h('input',{type:'number',name:'nightStartMinute',min:0,max:59,value:nm,style:'width:70px'})));
    nfWrap.appendChild(h('label',{class:'field'},'Ende (HH:MM)',
      h('input',{type:'number',name:'nightEndHour',min:0,max:23,value:eh,style:'width:70px'}),
      h('input',{type:'number',name:'nightEndMinute',min:0,max:59,value:em,style:'width:70px'})));
    nfWrap.appendChild(h('label',{class:'field'},'Nacht-Helligkeit',h('input',{type:'range',name:'nightBrightness',min:1,max:255,value:nb,oninput:e=>{e.target.nextSibling.textContent=e.target.value;} }),h('span',{},nb)));
    f.appendChild(nfWrap);
    nightSel.onchange=()=>{ toggleNightFields(); };
    function toggleNightFields(){ nfWrap.style.display = (nightSel.value==='on')? 'block':'none'; }
  const baseColor = (State.dashboard?.color && /^#?[0-9a-fA-F]{6}$/.test(State.dashboard.color))? (State.dashboard.color.startsWith('#')? State.dashboard.color : '#'+State.dashboard.color) : '#ffffff';
  f.appendChild(h('label',{class:'field'},'Uhrzeit',h('input',{type:'color',name:'color',value:baseColor}))); // renamed
    c.appendChild(card('LED Einstellungen',f,h('button',{type:'submit'},'Übernehmen')));
  // Removed 'Farben Zusatzwörter' card per request
    return c;
  }

  function viewWeather(){
    // Neue UI: Konfiguration Auto-Wetter-Wörter (Farben + enable/disable) analog Kategorie-Farben Layout
    const defs={REGEN:'#0000FF',SCHNEE:'#FFFFFF',WIND:'#FFFF00',LUEFTEN:'#00BFFF',GIESSEN:'#0000FF'};
    const order=['REGEN','SCHNEE','WIND','LUEFTEN','GIESSEN'];
    const f=h('form',{onsubmit:e=>{e.preventDefault();saveWeatherWords(f);}});
    order.forEach(k=>{
      let col=defs[k]; let mode='auto';
      if(State.dashboard?.weatherWords && State.dashboard.weatherWords[k]){
        const ww=State.dashboard.weatherWords[k];
        if(ww.color && /^#?[0-9a-fA-F]{6}$/.test(ww.color)) col= ww.color.startsWith('#')? ww.color : '#'+ww.color;
        if(ww.mode) mode=ww.mode;
      }
      const row=h('div',{class:'field weather-word-row'},
        h('span',{style:'min-width:110px;display:inline-block;font-weight:600;'},k),
        h('input',{type:'color',name:k+'_col',value:col}),
        (function(){
          const wrap=h('span',{class:'mode-buttons',style:'margin-left:8px;display:inline-flex;gap:4px;'});
          function makeBtn(label,val){
            const active=(mode==='auto'&&val==='auto')||(mode!=='auto'&&val==='disabled'&&mode==='disabled');
            return h('button',{type:'button','data-word':k,'data-mode':val,class:active?'mini active':'mini',onclick:()=>{ setMode(k,val,wrap); }},label);
          }
          wrap.appendChild(makeBtn('AUTO','auto'));
          wrap.appendChild(makeBtn('AUS','disabled'));
          return wrap;
        })()
      );
      f.appendChild(row);
    });
    function setMode(word,mode,wrap){
      // toggle button styles
      const btns=wrap.querySelectorAll('button'); btns.forEach(b=>{ b.classList.remove('active'); if(b.getAttribute('data-mode')===mode) b.classList.add('active'); });
      // store selection in hidden input
      let hidden=f.querySelector('input[name="'+word+'_mode"]'); if(!hidden){ hidden=h('input',{type:'hidden',name:word+'_mode'}); f.appendChild(hidden); }
      hidden.value=mode;
    }
    // Initialize hidden inputs according to initial modes
    order.forEach(k=>{ let m='auto'; if(State.dashboard?.weatherWords && State.dashboard.weatherWords[k] && State.dashboard.weatherWords[k].mode) m=State.dashboard.weatherWords[k].mode; let hidden=h('input',{type:'hidden',name:k+'_mode',value:(m==='auto'?'auto':'disabled')}); f.appendChild(hidden); });
    const actions=h('div',{class:'actions'});
    const saveBtn=h('button',{type:'submit'},'Speichern');
  const infoBtn=h('button',{type:'button',class:'btn-info',onclick:()=>showWeatherInfo()},'Info');
    actions.appendChild(saveBtn); actions.appendChild(infoBtn);
    f.appendChild(actions);
    const cards=[];
    cards.push(card('Wetter Wörter (Auto-Modus)',f));
    // Metrics + Lüften Sensitivität
    cards.push(buildLueftenCard());
    const wrap=h('div',{}); cards.forEach(c=>wrap.appendChild(c)); return wrap;
  }
  function buildLueftenCard(){
    const d=State.dashboard||{};
  const level = d.lueftenLevel||3;
  const mode = d.lueftenMode||'auto';
    function fmt(v,dec=1){ if(v===undefined||v===null) return '—'; return (Math.round(v* Math.pow(10,dec))/Math.pow(10,dec)).toFixed(dec); }
    const insideTemp = fmt(d.insideTempC,1)+'°C';
    const insideRH = fmt(d.insideRelHumidity,0)+'%';
    const insideAbs = fmt(d.insideAbsHumidity,1)+' g/m³';
    const outsideTemp = fmt(d.outsideTempC,1)+'°C';
    const outsideRH = fmt(d.outsideRelHumidity,0)+'%';
    const outsideAbs = fmt(d.outsideAbsHumidity,1)+' g/m³';
  const diff = (d.lueftenDiff!==undefined)? fmt(d.lueftenDiff,2)+' g/m³':'—';
  const minAvg3d = (d.lueftenMinAvg3d!==undefined)? fmt(d.lueftenMinAvg3d,2)+' g/m³':'—';
    const thOn = (d.lueftenOnThreshold!==undefined)? fmt(d.lueftenOnThreshold,2)+' g/m³':'—';
    const thOff = (d.lueftenOffThreshold!==undefined)? fmt(d.lueftenOffThreshold,2)+' g/m³':'—';
    const active = d.lueftenActive? 'AN' : 'AUS';
    const cont=h('div',{});
    const tbl=h('table',{class:'metrics'},
      h('tr',{},h('th',{colspan:3},'Innen')), 
      h('tr',{},h('td',{},'Temperatur'),h('td',{colspan:2},insideTemp)),
      h('tr',{},h('td',{},'rel. Feuchte'),h('td',{colspan:2},insideRH)),
      h('tr',{},h('td',{},'abs. Feuchte'),h('td',{colspan:2},insideAbs)),
      h('tr',{},h('th',{colspan:3},'Außen')),
      h('tr',{},h('td',{},'Temperatur'),h('td',{colspan:2},outsideTemp)),
      h('tr',{},h('td',{},'rel. Feuchte'),h('td',{colspan:2},outsideRH)),
      h('tr',{},h('td',{},'abs. Feuchte'),h('td',{colspan:2},outsideAbs)),
      h('tr',{},h('th',{colspan:3},'Lüften Logik')),
      h('tr',{},h('td',{},'Differenz (in-au)'),h('td',{colspan:2},diff)),
      h('tr',{},h('td',{},'Schwelle AN'),h('td',{colspan:2},thOn)),
      h('tr',{},h('td',{},'Schwelle AUS'),h('td',{colspan:2},thOff)),
  h('tr',{},h('td',{},'Niedrigste Differenz eine Woche'),h('td',{colspan:2},minAvg3d)),
      h('tr',{},h('td',{},'Anzeige'),h('td',{colspan:2},active))
    );
    cont.appendChild(tbl);
    const form=h('form',{onsubmit:e=>{e.preventDefault();saveLueften(form);}});
  const slider=h('input',{type:'range',min:1,max:10,value:level,name:'level',oninput:e=>{lvlVal.textContent='Stufe '+e.target.value;}});
  if(mode==='auto'){ slider.disabled=true; slider.title='Automatische Kalibrierung aktiv'; }
    const lvlVal=h('span',{},'Stufe '+level);
    form.appendChild(h('label',{class:'field'},'Sensitivität LÜFTEN', slider, lvlVal));
    const modeWrap=h('div',{class:'field'},
      h('span',{},'Kalibrierung: '),
      (function(){
        const row=h('div',{class:'inline-btns mode-buttons'});
        function make(label,val){
          const active=(mode===val);
          const btn=h('button',{type:'button','data-mode':val,class: active?'mini active':'mini',onclick:()=>{
            // Visuellen Active-Status sofort umschalten
            const btns=row.querySelectorAll('button'); btns.forEach(b=>{ b.classList.remove('active'); if(b.getAttribute('data-mode')===val) b.classList.add('active'); });
            setLueftenMode(val);
          }},label);
          return btn;
        }
        row.appendChild(make('AUTO','auto'));
        row.appendChild(make('MANUELL','manual'));
        return row;
      })()
    );
    form.appendChild(modeWrap);
  const actionsRow=h('div',{class:'actions'});
  const saveBtn=h('button',{type:'submit'},'Speichern');
  if(mode==='auto'){ saveBtn.disabled=true; saveBtn.title='Im AUTO‑Modus wird automatisch kalibriert'; }
  actionsRow.appendChild(saveBtn);
  // Aktualisieren Button (grau wie Info Buttons -> reuse btn-info class)
  actionsRow.appendChild(h('button',{type:'button',class:'btn-info',onclick:async()=>{ await refreshDashboard(true); render(); }},'Aktualisieren'));
  form.appendChild(actionsRow);
    cont.appendChild(form);
    return card('LÜFTEN & Klima', cont);
  }
  async function saveLueften(f){
    const lvl=parseInt(f.level.value,10);
    // Sende Level sowohl als Query als auch als Body Plain (maximale Kompatibilität)
    try{
      await api('/api/settings/lueften?level='+encodeURIComponent(lvl),{method:'POST',body:String(lvl)});
    }catch(e){
      await api('/api/settings/lueften?level='+encodeURIComponent(lvl),{method:'POST'});
    }
    toast('Lüften Sensitivität aktualisiert');
    await refreshDashboard(true);
    render();
  }

  async function setLueftenMode(mode){
    await api('/api/settings/lueften-mode',{method:'POST',body:JSON.stringify({mode})});
    toast('Kalibrierungsmodus: '+(mode==='auto'?'AUTO':'MANUELL'));
    await refreshDashboard(true);
    render();
  }
  function showWeatherInfo(){
    const text=`Die Wetter Wörter REGEN, SCHNEE und WIND zeigen die erwarteten Wetterereignisse in den kommenden 3 Stunden für deinen Standort.\n\nDas Wort GIESSEN gilt den Gartenpflanzen. Es leuchtet auf, sofern es gestern nicht geregnet hat und draußen warm war und es heute ebenfalls draußen warm ist und nicht regnen wird.\n\nDas Wort LÜFTEN zeigt an, dass aktuell eine hohe gemessene Luftfeuchtigkeit im Innerraum vorliegt (zB durch Kochen, Duschen oder längeren Aufenthalt). Sofern die absolute Luftfeuchtigkeit draußen geringer ist als im Innenraum, leuchtet das Wort LÜFTEN. Dadurch kann die Luftqualität verbessert und zB Schimmelbildung im Innenraum vorgebeugt werden. Verwenden Sie den AUTO Kalibrierungsmodus um Sensorschwankungen vorzubeugen. Dabei wird der zeitlich gemittelte, niedrigste Differenzwert jede Woche ermittelt und nach Abschluss der Woche als neuer Referenzwert angewandet. Die Sensitivität-Stufe wird automatisch gesetzt. Dies kann anfänglich ungenau sein und erfordert eine Woche initiale Kalibrierzeit. Alternativ können Sie in der manuellen Kalibrierung die Sensitivität eigenständig festlegen.\n\nSie können individuelle Farben für die jeweiligen Wörter einstellen oder diese deaktivieren.`;
    const body=document.createElement('div');
    text.split(/\n\n/).forEach(p=>{ body.appendChild(document.createElement('p')).textContent=p; });
    showModal('Wetter Wörter Info', body);
  }

  function viewWaste(){
    const wrap=h('div',{class:'grid'});
    // ABFALL Wort Modus (auto/disabled)
    const awMode=(State.dashboard?.weatherWords && State.dashboard.weatherWords.ABFALL && State.dashboard.weatherWords.ABFALL.mode) ? State.dashboard.weatherWords.ABFALL.mode : 'auto'; // fallback
    // Da ABFALL Teil der ExtraWords ist, holen wir Modus indirekt über /api/words Dashboard? Falls nicht vorhanden -> annehmen auto
    let abfallMode='auto';
    if(State.dashboard && State.dashboard.extra){
      // Kein direkter Modus enthalten; ignorieren -> lassen hidden Input auf 'auto'
    }
    const awForm=h('form',{onsubmit:e=>{e.preventDefault();saveAbfallMode(awForm);}});
    const modeWrap=h('div',{class:'field weather-word-row'},
      h('span',{style:'min-width:110px;display:inline-block;font-weight:600;'},'ABFALL'),
      (function(){
        const wrapB=h('span',{class:'mode-buttons',style:'margin-left:4px;display:inline-flex;gap:4px;'});
        function make(label,val){ return h('button',{type:'button','data-mode':val,class: (abfallMode==='auto'&&val==='auto')||(abfallMode==='disabled'&&val==='disabled')?'mini active':'mini',onclick:()=>setAbfallMode(val,wrapB)},label); }
        wrapB.appendChild(make('AUTO','auto'));
        wrapB.appendChild(make('AUS','disabled'));
        return wrapB;
      })()
    );
    awForm.appendChild(modeWrap);
    awForm.appendChild(h('input',{type:'hidden',name:'abfall_mode',value:abfallMode}));
  const abfActions=h('div',{class:'actions'});
  const abfSave=h('button',{type:'submit'},'Speichern');
  const abfInfo=h('button',{type:'button',class:'btn-info',onclick:()=>showAbfallInfo()},'Info');
  abfActions.appendChild(abfSave); abfActions.appendChild(abfInfo);
  awForm.appendChild(abfActions);
    wrap.appendChild(card('ABFALLKALENDER',awForm));
    // Neue: Einzelne Farben für Kategorien bearbeiten (bio, residual, paper, packaging, green)
    const catColorForm=h('form',{onsubmit:e=>{e.preventDefault();saveWasteColors(catColorForm);}});
    const catInputs=[
      {name:'bio', label:'Bioabfall', val:State.dashboard?.wasteColorBio},
      {name:'residual', label:'Restmüll', val:State.dashboard?.wasteColorResidual},
      {name:'paper', label:'Papier', val:State.dashboard?.wasteColorPaper},
      {name:'packaging', label:'Verpackung (Gelber Sack / Tonne)', val:State.dashboard?.wasteColorPackaging},
      {name:'green', label:'Gartenschnitt', val:State.dashboard?.wasteColorGreen}
    ];
    catInputs.forEach(c=>{
      const v=(c.val && c.val.length===7)? c.val : '#ffffff';
      catColorForm.appendChild(h('label',{class:'field'},c.label,h('input',{type:'color',name:c.name,value:v})));
    });
    wrap.appendChild(card('Kategorie-Farben',catColorForm,h('button',{type:'submit'},'Alle speichern')));
    // Events table or import form if empty
    const hasEvents = !!State.dashboard?.wasteEvents && Object.values(State.dashboard.wasteEvents).some(v=>Array.isArray(v)&&v.length);
    if(hasEvents){
      const cats=[
        {k:'bio',label:'Bioabfall'},
        {k:'residual',label:'Restmüll'},
        {k:'paper',label:'Papier'},
        {k:'packaging',label:'Verpackung (Gelber Sack / Tonne)'},
        {k:'green',label:'Gartenschnitt'}
      ];
      const tbl=h('div',{class:'card'},h('header',{},h('h3',{},'Importierte Termine'),
        h('div',{class:'actions',style:'margin-top:.5rem;'}, h('button',{class:'danger',onclick:()=>reimportWasteConfirm()},'Neue Termine importieren'))
      ));
      cats.forEach(c=>{
        const arr=State.dashboard.wasteEvents[c.k]||[];
        if(!arr.length) return;
        const list=h('ul',{class:'waste-list'}, arr.slice(0,50).map(d=> h('li',{},d)));
        tbl.appendChild(h('section',{},h('h4',{},c.label+' ('+arr.length+')'),list));
      });
      wrap.appendChild(tbl);
    } else {
      // Show inline iCal import when empty
      const emptyImport=h('form',{onsubmit:e=>{e.preventDefault();saveWaste(e.target);}},
        h('label',{class:'field'},'iCal URL',h('input',{name:'url',type:'url',required:true,placeholder:'https://...'})),
        h('div',{class:'actions'},h('button',{type:'submit'},'Importieren'))
      );
      wrap.appendChild(card('Importierte Termine', h('div',{}, h('p',{class:'small muted'},'Keine Termine vorhanden. Bitte iCal URL importieren.'), emptyImport)));
    }
    return wrap;
  }
  function showAbfallInfo(){
    const txt=`Das Wort ABFALL leuchtet in der individuellen Farbe der Abfall-Kategorie auf, welche als nächstes vom Entsorger abgeholt wird. Das Wort wird am Vortag der Abholung um 18Uhr aktiviert und am Tag der Abholung um 12 Uhr wieder deaktiviert.\n\nZum Import der Abholungstermine importieren Sie bitte den iCal Kalender Link Ihres lokalen Abfall-Entsorgers (copy-paste einfügen und importieren). Die Zuordnung der Abfall-Kategorien erfolgt automatisch.\n\nSie können individuelle Farben für die Abfallkategorien einstellen oder die Erinnerung zur Abfall-Abholung deaktivieren.`;
    const body=document.createElement('div');
    txt.split(/\n\n/).forEach(p=>{ body.appendChild(document.createElement('p')).textContent=p; });
    showModal('Abfallkalender Info', body);
  }

  function viewEvents(){
    const wrap=h('div',{class:'grid'});
    const all=State.events||[];
    const groups={birthday:[],single:[],series:[]};
    all.forEach(e=>{ if(groups[e.type]) groups[e.type].push(e); });
    const wdMap=['Mo','Di','Mi','Do','Fr','Sa','So'];
    const fmtSeries=e=>{ const parts=[e.recur]; if(e.recur==='monthly' && e.monthly_pos) parts.push('Pos '+e.monthly_pos); if(e.weekdays&&e.weekdays.length) parts.push(e.weekdays.map(w=>wdMap[(w-1)%7]).join(',')); return parts.join(' / '); };
    const buildList=(title,arr,type)=>{
      const box=h('div',{});
      if(!arr.length){ box.appendChild(h('p',{class:'small muted'},'Keine '+title)); }
      const list=h('div',{class:'event-group'});
      arr.forEach(ev=>{
        let meta=''; if(type==='birthday') meta=(ev.day? String(ev.day).padStart(2,'0'):'??')+'.'+(ev.month? String(ev.month).padStart(2,'0'):'??'); else if(type==='single') meta=ev.date; else meta=fmtSeries(ev);
        const row=h('div',{class:'event-row'},
          h('span',{class:'event-name'},ev.name||'-'),
          h('span',{class:'event-meta small muted'},meta),
          h('span',{class:'event-actions'},
            h('button',{class:'secondary',onclick:()=>openEventModal(ev.type,ev)},'Bearbeiten'),
            h('button',{class:'danger',onclick:()=>deleteEvent(ev.id)},'Löschen')
          )
        );
        list.appendChild(row);
      });
      if(arr.length) box.appendChild(list);
  const addBtn=h('button',{class:'btn-add',onclick:()=>openEventModal(type,null)},'Hinzufügen');
  const infoBtn=h('button',{type:'button',class:'btn-info',onclick:()=>showEventInfo(type)},'Info');
      const actions=h('div',{class:'actions'},addBtn,infoBtn);
      return card(title,box,actions);
    };
    wrap.appendChild(buildList('Geburtstage',groups.birthday,'birthday'));
    wrap.appendChild(buildList('Einmalige Termine',groups.single,'single'));
    wrap.appendChild(buildList('Serientermine',groups.series,'series'));
    if(!State.eventsLoaded) loadEvents();
    return wrap;
  }
  function showEventInfo(type){
    let txt=''; let title='Info';
    if(type==='birthday'){
      title='Geburtstage Info';
      txt='Fügen Sie der RemindiClock eine Erinnerung für gespeicherte Geburtstage Ihrer Familie oder Freunde hinzu. Das Wort GEBURTSTAG leuchtet am Tag eines gespeicherten Geburtstag jedes Jahr am passenden Datum automatisch auf.';
    } else if(type==='single'){
      title='Einmaliger Termin Info';
      txt='Lassen Sie sich an einen wichtigen Termin in Ihrer Wunschfarbe erinneren. Fügen Sie einen Termin hinzu und Ihre RemindiClock wird das Wort TERMIN am Tag des Termins anzeigen';
    } else if(type==='series'){
      title='Serientermine Info';
      txt='Lassen Sie sich an einen wiederkehrende Termine in Ihrer Wunschfarbe erinneren. Fügen Sie einen Serientermin hinzu und Ihre RemindiClock wird das Wort TERMIN am Tag des Termins anzeigen. Stellen Sie die Wiederholfrequenz des Termins (wöchentlich, 14-tägig oder monatlich) und den jeweiligen Wochentag ein. Für die monatliche Wiederholung geben Sie bitte zusätzlich an ob Sie am 1., 2., 3. oder 4. Auftreten des Wochentags im Monat an den Termin erinnert werden möchten.';
    }
    const body=document.createElement('div');
    txt.split(/\n\n/).forEach(p=>{ body.appendChild(document.createElement('p')).textContent=p; });
    showModal(title, body);
  }

  function viewMQTT(){
  const f=h('form',{id:'mqtt-form',onsubmit:e=>{e.preventDefault();saveMQTT(f);}});
  // Vorhandene Werte aus Dashboard übernehmen (falls vorhanden)
  const dash=State.dashboard||{};
  f.appendChild(field('Broker','broker','text',dash.mqttBroker||''));
  f.appendChild(field('Port','port','number',dash.mqttPort!=null?dash.mqttPort:1883));
  f.appendChild(field('Client ID','client','text',dash.mqttClientId||'RemindiClock'));
  f.appendChild(field('Benutzer','user','text',dash.mqttUser||''));
  // Passwort nie vorausfüllen, Platzhalter anzeigen falls gesetzt
  const passField=h('label',{class:'field'},'Passwort',h('input',{name:'pass',type:'password',placeholder: dash.mqttHasPassword? '********':''}));
  f.appendChild(passField);
  f.appendChild(field('Basis Topic','base','text',dash.mqttBase||'RemindiClock'));
  const saveBtn=h('button',{type:'submit'},'Speichern');
  const infoBtn=h('button',{type:'button',class:'secondary',onclick:showMqttHelp},'MQTT Hilfe');
  const c=card('MQTT Verbindung',f,h('div',{class:'actions'},saveBtn,infoBtn));
  // After first render of card, inject restart hint if pending
  setTimeout(()=>{ if(State.mqttNeedsRestart) showRestartHint(); },0);
  return c;
  }

  function showMqttHelp(){
  const dash=State.dashboard||{}; const base=dash.mqttBase||'RemindiClock';
    const wEx=base+'/word/BTC';
    const body=h('div',{},
      h('p',{},'MQTT Struktur – Basis-Topic: '+base),
      h('pre',{class:'mono small',style:'white-space:pre-wrap'},
        '# Topics je Wort (Beispiel BTC)\n'+
        wEx+'/set    (Commands)\n'+
        wEx+'/on     (retained true|false)\n'+
        wEx+'/mode   (retained mqtt|auto|disabled)\n'+
        wEx+'/color  (retained #RRGGBB oder leer)\n\n'+
        '# Befehle (Topic <base>/word/<WORD>/set)\n'+
        'Einfacher String:\n'+
        '  mqtt\n  auto\n  disabled\n  on\n  off\n  on #FF8800\n\n'+
        'JSON Varianten:\n'+
        '  { "mode":"auto" }\n'+
        '  { "mode":"mqtt" }\n'+
        '  { "mode":"disabled" }\n'+
        '  { "command":"on", "color":"#00FF00" }\n'+
        '  { "command":"off" }\n\n'+
        '# Regeln\n'+
        '- mode setzt Betriebsart (auto|mqtt|disabled).\n'+
        '- on/off (oder command) wirkt nur wenn aktueller Modus mqtt ist.\n'+
        '- Farbe nur zusammen mit Einschalten (on oder command:on); Format #RRGGBB.\n'+
        '- /on und /color spiegeln den echten Status (Auto Änderungen sofort).\n\n'+
        '# Weitere Topics\n'+
        base+'/status            (Online/Offline)\n'+
        base+'/time              (Zeit HH:MM)\n'+
        base+'/brightness/set    (1-100)\n\n'+
        '# Home Assistant\n'+
        'Nutze /on als state_topic, /mode für Verfügbarkeit/Modus, /color optional als Attribut.')
    );
    showModal('MQTT Hilfe', body);
  }

  // Generic modal helper (simple info modal)
  function showModal(titleText, content){
    const existing=document.getElementById('modal-backdrop'); if(existing) existing.remove();
    const backdrop=document.createElement('div'); backdrop.id='modal-backdrop'; backdrop.className='modal-backdrop';
    backdrop.addEventListener('click',e=>{ if(e.target===backdrop) backdrop.remove(); });
    const modal=document.createElement('div'); modal.className='modal';
    const closeBtn=document.createElement('button'); closeBtn.className='modal-close'; closeBtn.type='button'; closeBtn.textContent='×'; closeBtn.onclick=()=>backdrop.remove();
    const title=document.createElement('h2'); title.textContent=titleText||'';
    modal.appendChild(closeBtn);
    modal.appendChild(title);
    if(typeof content==='string'){
      const p=document.createElement('p'); p.textContent=content; modal.appendChild(p);
    } else if(content){
      modal.appendChild(content);
    }
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    // Basic ESC close
    const escHandler=(ev)=>{ if(ev.key==='Escape'){ backdrop.remove(); document.removeEventListener('keydown',escHandler); } };
    document.addEventListener('keydown',escHandler);
    // Focus first focusable
    setTimeout(()=>{ const btn=modal.querySelector('button:not(.modal-close)'); (btn||closeBtn).focus(); },0);
  }

  function viewMarkets(){
    const d=State.dashboard||{};
    const form=h('form',{onsubmit:e=>{e.preventDefault();saveMarkets(form);}});
    // Draft state (so UI Auswahl nicht sofort durch Dashboard Refresh überschrieben wird)
    if(!State.marketDraft) State.marketDraft={};
    const btcWrap=h('div',{}); btcWrap.dataset.mode= State.marketDraft.btc || (d.marketBtcMode||'off');
    const msciWrap=h('div',{}); msciWrap.dataset.mode= State.marketDraft.msci || (d.marketMsciMode||'off');
    function makeModeRow(wrap,label){
      const row=h('div',{class:'inline-btns mode-buttons'});
      const name=label.toLowerCase();
      const hidden=h('input',{type:'hidden',name:name,value:wrap.dataset.mode});
      const modes=[['auto','AUTO'],['off','AUS']];
      modes.forEach(([m,txt])=>{
        const btn=h('button',{type:'button',class:'mini'+(wrap.dataset.mode===m?' active':''),onclick:()=>{
          if(wrap.dataset.mode===m) return; // kein Wechsel nötig
          wrap.dataset.mode=m;
          State.marketDraft[name]=m;
          hidden.value=m;
          // Active Klassen aktualisieren
          row.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
          btn.classList.add('active');
        }},txt);
        row.appendChild(btn);
      });
      form.appendChild(labelWrap(label,row));
      form.appendChild(hidden);
    }
  makeModeRow(btcWrap,'BTC');
  makeModeRow(msciWrap,'MSCI');
  const marketActions=h('div',{class:'actions'});
  const mSave=h('button',{type:'submit'},'Speichern');
  const mInfo=h('button',{type:'button',class:'btn-info',onclick:()=>showMarketsInfo()},'Info');
  marketActions.appendChild(mSave); marketActions.appendChild(mInfo);
  form.appendChild(marketActions);
    // Hidden inputs on submit
  // submit no longer needs to inject hidden inputs (kept in sync live)
    return card('Börsenkurse',form);
  }
  function showMarketsInfo(){
  const txt=`Lassen Sie durch die Wörter BTC und MSCI Ihre RemindiClock die Kursentwicklung des aktuellen Tages anzeigen. Im Falle einer Änderung von +/- 0.5 % oder mehr werden die Wörter entsprechend rot (fallend) oder grün (steigend) angezeigt. Der Kurs des Bitcoin bezieht sich auf die Entwicklung seit 0:00 Uhr (lokale Zeit), MSCI bezieht sich auf die Entwicklung des ETF iShares Core MSCI World seit dem letzten Börsenschluss (Abend des letzten Werktags). Das Wort MSCI ist am Wochenende deaktiviert.\n\nHinweis: Die auf der Uhr angezeigten Wörter dienen ausschließlich zu dekorativen Zwecken.\nDie Daten stammen aus öffentlichen Schnittstellen, deren Richtigkeit, Aktualität und Verfügbarkeit nicht jederzeit gewährleistet werden kann. Es handelt sich nicht um eine verbindliche Kursanzeige. Die Anzeige darf nicht als Grundlage für finanzielle Entscheidungen verwendet werden. Jegliche Gewährleistung oder Haftung für die angezeigten Wertentwicklung ist ausgeschlossen.`;
    const body=document.createElement('div');
    txt.split(/\n\n/).forEach(p=>{ body.appendChild(document.createElement('p')).textContent=p; });
    showModal('Börsen Info', body);
  }

  function field(label,name,type='text',value='',readonly){
    return h('label',{class:'field'},label,h('input',{name,type,value,readonly:readonly?true:false}));
  }

  // ---- Actions (API placeholders) ----
  function scanArea(){
    const box=h('div',{});
    if(!State.scanning && !State.networks.length){
      box.appendChild(h('p',{},'Noch keine Suche durchgeführt.'));
      box.appendChild(h('button',{onclick:startScan},'Suche starten'));
    } else if(State.scanning){
      const prog=h('div',{class:'progress-wrap'},
        h('div',{class:'progress-bar',style:'width:0%'}));
      box.appendChild(h('p',{},'Suche läuft ('+Math.round(State.scanDuration/1000)+'s)...'));
      box.appendChild(prog);
      const update=()=>{
        if(!State.scanning) return;
        const el=prog.querySelector('.progress-bar');
        const pct=Math.min(100, ((Date.now()-State.scanStart)/State.scanDuration)*100);
        el.style.width=pct+'%';
        if(pct<100) requestAnimationFrame(update);
      }; update();
    } else {
      // show results + refresh button
      const list=h('div',{class:'net-list'});
      const nets=State.networks.slice().sort((a,b)=>(b.rssi||0)-(a.rssi||0));
      nets.forEach(net=>{
        const ssid=net.ssid||net.SSID||'';
        const r=net.rssi!=null? net.rssi : -100;
        let lvl=1; if(r>=-55) lvl=4; else if(r>=-65) lvl=3; else if(r>=-75) lvl=2; else lvl=1;
        const cls='secondary'+(ssid===State.selectedSSID?' active':'');
        list.appendChild(h('button',{class:cls,onclick:()=>selectNetwork(ssid),title:ssid+' ('+r+' dBm)'},
          h('span',{class:'wifi-item'},
            h('span',{class:'wifi-name'},ssid),
            h('span',{class:'wifi-icon lvl'+lvl},
              h('span',{class:'b1'}),
              h('span',{class:'b2'}),
              h('span',{class:'b3'}),
              h('span',{class:'b4'})
            )
          )
        ));
      });
      if(!nets.length) list.appendChild(h('p',{},'Keine Netzwerke gefunden.'));
      box.appendChild(list);
      box.appendChild(h('div',{class:'actions'},h('button',{onclick:startScan},'Aktualisieren')));
    }
    return box;
  }
  async function startScan(){
    State.scanning=true; State.networks=[]; State.scanStart=Date.now(); render();
    try{ 
      const startRes = await api('/api/wifi/scan/start');
      console.log('[SCAN] start response', startRes);
    }catch(e){ State.scanning=false; toast('Start fehlgeschlagen','error'); return; }
    // poll progress until finish or timeout
    const end=State.scanStart+State.scanDuration;
    const poll=async()=>{
      try{
        const res=await api('/api/wifi/scan');
        if(res && res.scanning===false){
            State.scanning=false; State.networks=res.networks||[]; render(); return; }
        // if res.scanning true but no progress and after 2s still empty, extend end time once
        if(Date.now()-State.scanStart>2000 && State.networks.length===0){ /* optional backoff hook */ }
      }catch(e){}
      if(Date.now()<end && State.scanning){ setTimeout(poll,1200); } else if(State.scanning){ // timeout
        State.scanning=false; const res=await api('/api/wifi/scan'); State.networks=res.networks||[]; render(); }
    }; poll();
  }

  async function loadNetworks(){ return State.networks; } // Replace old loadNetworks call usages (kept for backward compat but unused)
  async function selectNetwork(ssid){
    State.selectedSSID=ssid;
    const inp=document.querySelector('input[name=ssid]'); if(inp) inp.value=ssid;
    // Re-render network list to show active highlight without resetting password
    if(State.step===0 && State.wizardMode){
      const wifiList=document.getElementById('wifi-list'); if(wifiList){
        // only update buttons area inside wifi-list if exists
        const btns=wifiList.querySelectorAll('button');
        btns.forEach(b=>{ if(b.textContent.startsWith(ssid+' ')) b.classList.add('active'); else b.classList.remove('active'); });
      }
    }
  }
  async function connectWifi(form){
  const data=Object.fromEntries(new FormData(form).entries());
  State.selectedSSID=data.ssid; State.wifiPassword=data.password;
    toast('Verbinde mit '+data.ssid+' ...','info');
    try{ await fetch('/api/wifi/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});}catch(_){/* ignorieren */}
    const note=h('div',{class:'card'},
      h('h3',{},'Verbindungsaufbau...'),
      h('p',{},'Der ESP32 startet nun mit deinem WLAN neu. Diese Seite wird ggf. kurz nicht erreichbar sein.'),
      h('p',{},'Versuche in 10-15 Sekunden: '),
      h('ul',{},
        h('li',{},'http://remindiclock (Hostname)'),
        h('li',{},'http://remindiclock.local (mDNS, falls unterstützt)'),
        h('li',{},'oder die IP-Adresse aus dem Router (DHCP-Liste)')
      ),
      h('p',{class:'small muted'},'Viele Android Geräte unterstützen mDNS nicht – verwende dann den Hostnamen oder die IP.')
    );
    app.innerHTML=''; app.appendChild(note);
  // Erst Hostname ohne .local, dann Fallback auf .local nach weiteren 5s falls Seite noch offen
  setTimeout(()=>{ try{ window.location.href='http://remindiclock/'; }catch(_){ } },10000);
  setTimeout(()=>{ if(document.visibilityState!=='hidden') { try{ window.location.href='http://remindiclock.local/'; }catch(_){ } } },15000);
  }
  async function saveAddress(form){
  const data={ postalCode:State.addrPostal, city:State.addrCity, country:State.addrCountry };
    try {
      if(State.selectedCityResult){
        data.latitude=State.selectedCityResult.latitude;
        data.longitude=State.selectedCityResult.longitude;
        data.timezone=State.selectedCityResult.timezone;
        data.city=State.selectedCityResult.name;
      }
      await api('/api/address',{method:'POST',body:JSON.stringify(data)});
        toast('Adresse + Standort übernommen','success');
  // Nach Adresseingabe direkt zu Schritt 3 (Abfall) wechseln
  await refreshDashboard();
  State.wizardMode=true;
  State.step=3;
  render();
    }catch(e){ toast('Speichern fehlgeschlagen','error'); }
  }
  function sendWizardStage(stage){
    try{ fetch('/api/wizard/stage',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'stage='+encodeURIComponent(stage)}); }catch(_){ }
  }
  async function citySearch(){
    if(!State.addrCity) { toast('Stadt eingeben','warn'); return; }
    try{
      const res= await api('/api/geocode?city='+encodeURIComponent(State.addrCity));
      if(res.ok){ State.cityResults = res.results; toast(res.results.length+' Treffer','info'); } else { State.cityResults=[]; toast('Keine Treffer','warn'); }
    }catch(e){ State.cityResults=[]; toast('Suche fehlgeschlagen','error'); }
    render();
  }
  async function selectCityResult(r){
    try{
    State.selectedCityResult=r; State.addrCity=r.name; State.addrCountry=r.country;
    toast('Standort gewählt – jetzt Speichern drücken','info');
    render();
    }catch(e){ toast('Übernahme fehlgeschlagen','error'); }
  }
  async function pollForStage(){
    // Legacy Funktion wird jetzt durch gezielte Poll-Steuerung ersetzt.
    // Beibehalten als Wrapper für Kompatibilität: führt genau einen Poll aus.
    await targetedPollOnce();
  }
  // Neue Poll-Variablen
  if(!State.pollMode){ State.pollMode='none'; State.nextPollTs=0; State.pollAttempts=0; }
  async function targetedPollOnce(){
    if(!State.wizardMode) return;
    try {
      const dash = await api('/api/dashboard');
      const prevStage = State.dashboard?.stage;
      const prevWasteValid = !!State.dashboard?.wasteEvents;
      State.dashboard = dash;
      const st = dash.stage;
      if(st==='wifi'){
        const looksLikeSetup = dash.apMode || !dash.online || !dash.wifi_ssid;
        if(looksLikeSetup){ State.step=0; }
        // sonst Schritt beibehalten (kein Rücksprung)
      }
      else if(st==='adminpass') State.step=1;
  else if(st==='address') State.step=2;
      else if(st==='waste' && !State.skipWaste) State.step=3;
  else if(st==='waste' && State.skipWaste) { State.step=4; }
  else if(st==='events') {
        // Bleibe im Abfall-Schritt, solange noch nicht bestätigt wurde
        if(!State.dashboard?.wasteConfirmed && !State.skipWaste) State.step=3; else State.step=4;
      }
  else if(st==='markets') State.step=5;
  else if(st==='review') State.step=6;
      else if(st==='done'){
        if(localStorage.getItem('rcWizardDone')!=='1') localStorage.setItem('rcWizardDone','1');
        State.wizardMode=false; State.view='Dashboard';
      }
      // Fokus-Schutz für alle Formular-Schritte (0=wifi,1=address,2=waste,3=events)
      const ae=document.activeElement;
      const blockNames=['ssid','password','addrCity','addrPostal','ical','birthday_name','birthday_date','single_name','single_date','series_name','date'];
      const isFocus = ae && ae.tagName==='INPUT' && blockNames.includes(ae.name);
      const stageChanged = prevStage!==dash.stage;
      const gotWaste = !prevWasteValid && !!dash.wasteEvents;
      // Erweiterter Edit-Schutz speziell für Schritt 3 (Termine & Geburtstage):
      // Mobile Datepicker entziehen oft den Fokus -> zusätzlich letzte Aktivität & editingActive berücksichtigen
      const recentInput = Date.now() - (State.lastInputActivity||0) < 8000; // 8s Schonfrist
  const inEventsStep = State.wizardMode && State.step===4;
      const suppress = inEventsStep && (isFocus || State.editingActive || recentInput);
      if(stageChanged || gotWaste || (!suppress && !isFocus)){
        render();
      }
    }catch(e){ }
  }
  function schedulePoll(mode, delayMs){
    State.pollMode=mode; State.nextPollTs=Date.now()+delayMs; State.pollAttempts=0;
  }
  function continuePoll(delayMs){ State.nextPollTs=Date.now()+delayMs; }
  function stopPoll(){ State.pollMode='none'; }
  // Haupt-Poll Schleife (leichtgewichtig)
  if(!window.__wizPollLoop){
    window.__wizPollLoop = setInterval(async ()=>{
      if(!State.wizardMode || State.pollMode==='none') return;
      if(Date.now() < State.nextPollTs) return;
      State.pollAttempts++;
      await targetedPollOnce();
      // Logik pro Modus
      if(State.pollMode==='wifi'){ // warten bis Stage != wifi
        if(State.dashboard?.stage!=='wifi'){ stopPoll(); return; }
        if(State.pollAttempts>15){ stopPoll(); return; } // Timeout ~ anpassbar
        continuePoll(1500);
      } else if(State.pollMode==='waste'){ // warten bis Events da oder Stage nicht mehr waste
        if(State.dashboard?.wasteEvents || State.dashboard?.stage!=='waste'){
          State.waitWasteImport=false;
          stopPoll();
          return;
        }
        // Poll bis zu ~2 Minuten (60 * 1.8s)
        if(State.pollAttempts>60){ State.pollAttempts=0; }
        continuePoll(1800);
      }
    },400);
  }
  async function refreshDashboard(force, opts){
  opts=opts||{}; const suppressWizard=!!opts.suppressWizard;
  const prevStage = State.dashboard?.stage;
  try { State.dashboard = await api('/api/dashboard'); } catch(e){ }
    // OTA Erfolg / Fehlschlag über Versionsvergleich erkennen
    try {
      const tgt=localStorage.getItem('rcPendingUpdateTarget');
      const prevVer=localStorage.getItem('rcPendingUpdatePrev');
      const ts=parseInt(localStorage.getItem('rcPendingUpdateTs')||'0',10);
      if(tgt && prevVer && State.dashboard?.version){
        if(State.dashboard.version===tgt){
          toast('Update installiert ('+tgt+')','success');
          localStorage.removeItem('rcPendingUpdateTarget');
          localStorage.removeItem('rcPendingUpdatePrev');
          localStorage.removeItem('rcPendingUpdateTs');
        } else if(State.dashboard.version!==prevVer && State.dashboard.version!==tgt){
          // Version hat sich verändert, aber nicht identisch zum erwarteten Ziel -> trotzdem Erfolg melden
          toast('Firmware geändert ('+State.dashboard.version+')','success');
          localStorage.removeItem('rcPendingUpdateTarget');
          localStorage.removeItem('rcPendingUpdatePrev');
          localStorage.removeItem('rcPendingUpdateTs');
        } else if(ts && Date.now()-ts>60000){
          toast('Update fehlgeschlagen (Version unverändert)','error');
          localStorage.removeItem('rcPendingUpdateTarget');
          localStorage.removeItem('rcPendingUpdatePrev');
          localStorage.removeItem('rcPendingUpdateTs');
        }
      }
    }catch(_){ }
    const stRe=State.dashboard?.stage;
  // Regression NICHT mehr automatisch erzwingen, damit der abgeschlossene Wizard nicht erneut erscheint.
  // Falls künftig ein Factory-Reset entdeckt werden soll, sollte Backend stage wieder auf 'wifi' setzen UND rcWizardDone löschen.
    let stepBefore=State.step; const newStage=State.dashboard?.stage;
    if(State.wizardMode){
      const st=State.dashboard?.stage;
      if(State.waitWasteImport){
        // Beende Wartezustand, sobald Events da sind ODER der Server die Stage weitergeschaltet hat
        if(State.dashboard?.wasteEvents || State.dashboard?.stage !== 'waste'){
          State.waitWasteImport=false;
        } else {
          State.step=3; // während des Imports auf dem Abfall-Schritt verbleiben
        }
      }
      if(!State.waitWasteImport){
    if(st==='wifi'){
      const looksLikeSetup = State.dashboard?.apMode || !State.dashboard?.online || !State.dashboard?.wifi_ssid;
      if(looksLikeSetup){ State.step=0; }
    }
  else if(st==='adminpass'){ State.step=1; }
  else if(st==='address'){ State.step=2; }
    else if(st==='waste' && !State.skipWaste){ State.step=3; }
  else if(st==='waste' && State.skipWaste){ State.step=4; }
  else if(st==='events'){ 
          // Nicht automatisch weiter, solange nicht bestätigt
          if(!State.dashboard?.wasteConfirmed && !State.skipWaste) State.step=3; else State.step=4;
        }
  else if(st==='markets'){ State.step=5; }
  else if(st==='review'){ State.step=6; }
    else if(st==='done'){
          if(localStorage.getItem('rcWizardDone')!=='1') localStorage.setItem('rcWizardDone','1');
          if(State.dashboard && State.dashboard.authRequired && !State.dashboard.authed){ State.wizardMode=true; State.step=5; }
          else { State.wizardMode=false; State.view='Dashboard'; }
        }
      }
    }
    // Wenn lokale Farbauswahl existiert und Server liefert Defaults, nicht überschreiben
    if(State.pendingWasteColors && State.dashboard){
      // Nur falls wizard Step 2 aktiv, Daten nicht auf pending resetten
      if(State.step===2){
        Object.entries(State.pendingWasteColors).forEach(([k,v])=>{
          // Spiegeln in dashboard, damit Render dieselben Werte nutzt
          const propMap={bio:'wasteColorBio',residual:'wasteColorResidual',paper:'wasteColorPaper',packaging:'wasteColorPackaging',green:'wasteColorGreen'};
          const p=propMap[k]; if(p) State.dashboard[p]=v;
        });
      }
    }
  // Delta-basiertes Rendern: Nur wenn Stage wechselt, neue Waste Events eintreffen oder explizit force
  const gotWaste = !State.dashboard?.__prevWasteValid && !!State.dashboard?.wasteEvents;
  State.dashboard.__prevWasteValid = !!State.dashboard?.wasteEvents;
  const ae=document.activeElement; const focusInputs=['ssid','password','addrCity','addrPostal','ical','birthday_name','birthday_date','single_name','single_date','series_name','date'];
  const focusBlock = ae && ae.tagName==='INPUT' && focusInputs.includes(ae.name);
  const recentInput = Date.now() - (State.lastInputActivity||0) < 8000;
  const inEventsStep = State.wizardMode && State.step===4;
  const editingHold = inEventsStep && (focusBlock || State.editingActive || recentInput);
  if(force || prevStage!==newStage || gotWaste || (!editingHold && !focusBlock)){
    render();
  }
  }
  // Dashboard Loop nur außerhalb des Wizards aktiv
  function startDashboardLoop(){ if(State.dashTimer) return; State.dashTimer=setInterval(()=>{ if(!State.wizardMode) refreshDashboard(false); },5000);} 
  function stopDashboardLoop(){ if(State.dashTimer){ clearInterval(State.dashTimer); State.dashTimer=null; } }
  // Während Wizard deaktivieren wir die Dashboard-Schleife vollständig
  if(State.wizardMode){ stopDashboardLoop(); }
  async function factoryReset(){
    // Zweite Sicherheitsabfrage (erste in factoryResetConfirm) bleibt für direkte Aufrufe bestehen
  if(confirm('Zurücksetzen und neu starten?')) {
      try {
        // Lokale Wizard-Flags sofort löschen, damit nach Reload Wizard wieder startet
        localStorage.removeItem('rcWizardDone');
        localStorage.removeItem('rcSkipWaste');
        // UI direkt in Wizard-Modus versetzen (falls Gerät etwas verzögert neu startet)
        State.wizardMode=true; State.skipWaste=false; State.step=0; State.view=null; render();
        await api('/api/settings/factory-reset',{method:'POST'});
    toast('Werkseinstellungen aktiviert. Gerät startet neu...','warn');
    beginRebootWatch(true);
      } catch(e){ /* ignore */ }
    }
  }
  async function saveBrightness(form){
    const data=Object.fromEntries(new FormData(form).entries());
    const btn=form.querySelector('button[type=submit]'); const done=setLoading(btn);
  try { await api('/api/settings/brightness',{method:'POST',body:JSON.stringify(data)}); toast('LED gespeichert','success');
    // Lokale Dashboard-Werte direkt anpassen
    if(State.dashboard){ const pct=parseInt(data.brightnessPercent||data.brightness||0,10); if(pct>0){ State.dashboard.rawBrightness = Math.round(pct*255/100); State.dashboard.brightness = pct; } }
    // Farbe lokal übernehmen und sofort Dashboard + Anzeige aktualisieren (force render)
    if(data.color){ let c=data.color; if(!c.startsWith('#')) c='#'+c; State.dashboard.color=c; }
    await refreshDashboard(true);
  } catch(e){ toast('Fehler','error'); } finally { done(); State.editingActive=false; }
  }
  async function saveExtraColors(wrap){
    const rows=[...wrap.querySelectorAll('.pal-row')];
    if(!rows.length){ toast('Keine Palette','warn'); return; }
    const out={}; rows.forEach(r=>{ const lbl=r.querySelector('.pal-label'); if(lbl && r.dataset.sel) out[lbl.textContent]=r.dataset.sel; });
    if(Object.keys(out).length===0){ toast('Keine Auswahl','warn'); return; }
    const btn=wrap.parentElement?.querySelector('button.secondary'); const done=setLoading(btn);
  try{ await api('/api/settings/extra-colors',{method:'POST',body:JSON.stringify(out)}); toast('Farben gespeichert','success'); await refreshDashboard(true); }
    catch(e){ toast('Fehler beim Speichern','error'); } finally { done(); }
  }
  async function saveWeatherWords(form){ const data=Object.fromEntries(new FormData(form).entries()); const payload={}; const map=[['REGEN','#0000FF'],['SCHNEE','#FFFFFF'],['WIND','#FFFF00'],['LUEFTEN','#00BFFF'],['GIESSEN','#0000FF']];
    map.forEach(([k,def])=>{ const mode=(data[k+'_mode']||'auto'); let col=(data[k+'_col']||def); if(col && !col.startsWith('#')) col='#'+col; payload[k]={enabled:(mode==='auto'),color:col}; });
    const btn=form.querySelector('button[type=submit]'); const done=setLoading(btn);
    try{ await api('/api/settings/weather-words',{method:'POST',body:JSON.stringify(payload)}); toast('Gespeichert','success'); await refreshDashboard(true); }
    catch(e){ toast('Speichern fehlgeschlagen','error'); } finally { done(); }
  }
  // entfernt: veraltete Import-Implementierung mit doppelter Definition
  // Ersetze ad-hoc Poll-Logik durch gezielten Poll Mode
  async function importWaste(form){
    const d=Object.fromEntries(new FormData(form).entries());
    try{
      await api('/api/waste/ical',{method:'POST',body:JSON.stringify({url:d.ical})});
      toast('Kalender gespeichert','success');
      // Nutzer hat nun aktiv importiert -> etwaiges früheres Überspringen zurücksetzen
      try{ localStorage.removeItem('rcSkipWaste'); }catch(_){ }
      State.skipWaste=false;
      State.waitWasteImport=true;
  State.step=3; // während Import im Abfall-Schritt bleiben
  State.wasteImportStartedAt=Date.now();
  // einmalig direkt refreshen, falls Backend sehr schnell antwortet
  await refreshDashboard(true);
      State.wasteIcalDraft=d.ical;
      schedulePoll('waste',800);
  // Fallback: nach 120s Warteflag zurücksetzen, damit UI nicht hängen bleibt
  setTimeout(()=>{ if(State.waitWasteImport && State.dashboard?.stage!=='waste'){ State.waitWasteImport=false; render(); } }, 120000);
    }catch(e){ toast('Fehler beim Import','error'); }
  }
  async function saveWaste(form){
    const d=Object.fromEntries(new FormData(form).entries());
    try{
      await api('/api/waste/ical',{method:'POST',body:JSON.stringify({url:d.url})});
      toast('Abfall iCal gespeichert','success');
      // Nutzer hat nun aktiv importiert -> etwaiges früheres Überspringen zurücksetzen
      try{ localStorage.removeItem('rcSkipWaste'); }catch(_){ }
      State.skipWaste=false;
      State.waitWasteImport=true;
  State.step=3; // während Import im Abfall-Schritt bleiben
  State.wasteImportStartedAt=Date.now();
  await refreshDashboard(true);
      schedulePoll('waste',800);
  setTimeout(()=>{ if(State.waitWasteImport && State.dashboard?.stage!=='waste'){ State.waitWasteImport=false; render(); } }, 120000);
    }catch(e){ toast('Speichern fehlgeschlagen','error'); }
  }
  async function saveWasteColors(form){ const d=Object.fromEntries(new FormData(form).entries()); const btn=form.querySelector('button[type=submit]'); const done=setLoading(btn); try{ await api('/api/waste/colors',{method:'POST',body:JSON.stringify(d)}); toast('Farben gespeichert','success'); await refreshDashboard(); render(); }catch(e){ toast('Fehler beim Speichern','error'); } finally { done(); } }
  async function saveAbfallMode(form){ const d=Object.fromEntries(new FormData(form).entries()); const mode=(d.abfall_mode==='disabled')?'disabled':'auto'; try{ await api('/api/settings/weather-words',{method:'POST',body:JSON.stringify({ABFALL:{enabled:mode==='auto'}})}); toast('ABFALL Modus gespeichert','success'); await refreshDashboard(true); }catch(e){ toast('Speichern fehlgeschlagen','error'); } }
  function setAbfallMode(mode,wrap){ const btns=wrap.querySelectorAll('button'); btns.forEach(b=>{ b.classList.remove('active'); if(b.getAttribute('data-mode')===mode) b.classList.add('active'); }); const form=wrap.closest('form'); const hidden=form.querySelector('input[name=abfall_mode]'); hidden.value=mode; }
  async function reimportWasteConfirm(){
    if(!confirm('Alle importierten Abfall-Termine löschen und neuen iCal Link importieren?')) return;
    State.reimportInProgress=true;
    try{
  // Löschen: URL entfernen (keepUrl=0) aber Bestätigung behalten (keepConfirm=1) damit Stage nicht zurückspringt
  const res = await api('/api/waste/clear?keepConfirm=1',{method:'POST'});
      if(res && res.cleared){
        toast('Abfall-Termine gelöscht','success');
        // Lokale Events sofort entfernen für direkte UI-Reaktion
        if(State.dashboard){
          if(State.dashboard.wasteEvents){
            Object.keys(State.dashboard.wasteEvents).forEach(k=>{ State.dashboard.wasteEvents[k]=[]; });
          }
          // Auch Kennzeichen zurücksetzen, damit Render keine alten Daten anzeigt
          State.dashboard.waste = false;
          State.dashboard.waste_ok = false;
          // URL entfernt, Confirmation behalten -> Stage bleibt 'done'
          // Nach dem Löschen sofort Import-Ansicht mit Provider-Hinweisen erneut zeigen
          State.view='Settings';
          State.settingsTab='waste';
          State.wasteIcalDraft='';
          // Scroll nach oben für sichtbare Hinweise
          setTimeout(()=>{ window.scrollTo(0,0); },10);
        }
        render();
        // Dashboard aktualisieren ohne Wizard-Auto-Umschaltung
  await refreshDashboard(true,{suppressWizard:true});
      } else {
        toast('Löschen fehlgeschlagen','error');
      }
    }catch(e){ toast('Fehler beim Neu-Import','error'); }
    finally { State.reimportInProgress=false; }
  }
  async function confirmWasteSetup(form){
    try{
      if(form){
        const d=Object.fromEntries(new FormData(form).entries());
        State.pendingWasteColors=d;
        await api('/api/waste/colors',{method:'POST',body:JSON.stringify(d)});
      }
      await api('/api/waste/colors',{method:'POST',body:JSON.stringify({confirm:true})});
      toast('Abfall-Konfiguration bestätigt','success');
      State.pendingWasteColors=null;
      // Nach Bestätigung zum nächsten Schritt (Termine & Geburtstage)
      sendWizardStage('events');
      await refreshDashboard(true);
      State.step=4;
      render();
    }catch(e){
      toast('Fehler bei Bestätigung','error');
    }
  }
  async function saveWasteColor(form){ const d=Object.fromEntries(new FormData(form).entries()); try{ await api('/api/waste/color',{method:'POST',body:JSON.stringify({color:d.color})}); toast('Farbe gespeichert','success'); await refreshDashboard(true); }catch(e){ toast('Fehler beim Speichern','error'); } }
  async function saveMarkets(form){
    const d=Object.fromEntries(new FormData(form).entries());
    try{
      await api('/api/settings/markets',{method:'POST',body:JSON.stringify(d)});
      toast('Börsenkurse gespeichert','success');
      // Aktuelle Auswahl im State beibehalten
      if(!State.dashboard) State.dashboard={};
      State.dashboard.marketBtcMode=d.btc;
      State.dashboard.marketMsciMode=d.msci;
  // Draft verwerfen – Dashboard Wert ist nun maßgeblich
  if(State.marketDraft){ delete State.marketDraft.btc; delete State.marketDraft.msci; }
      // Serverseitigen Status nachladen um Konsistenz zu sichern
      await refreshDashboard(true);
      // Nach erfolgreichem Speichern im Wizard vom Schritt 5 (Markets) auf 6 (Fertig) wechseln
      if(State.wizardMode && State.step===5){
        State.step=6;
        sendWizardStage('review');
      }
      render();
    }catch(e){ toast('Speichern fehlgeschlagen','error'); }
  }
  // --- Events/Birthdays API integration ---
  async function loadEvents(){
    try { const res= await api('/api/events'); State.events = res; State.eventsLoaded=true; render(); }
    catch(e){ toast('Events Laden fehlgeschlagen','error'); }
  }
  function parseDateParts(iso){ if(!iso||iso.length<10) return null; return {y:parseInt(iso.substring(0,4)), m:parseInt(iso.substring(5,7)), d:parseInt(iso.substring(8,10))}; }
  async function submitBirthday(form){ const d=Object.fromEntries(new FormData(form).entries()); if(d.id){ // edit: allow only name change for simplicity
      const btn=form.querySelector('button[type=submit]'); const done=setLoading(btn);
      const payload={}; if(d.name) payload.name=d.name; try{ await putEvent(d.id,payload); toast('Aktualisiert','success'); State.editEvent=null; loadEvents(); form.reset(); }catch(e){ toast(e.message||'Fehler','error'); } finally { done(); }
      return;
  }
  // Wizard uses birthday_date as field name -> map to date
  if(!d.name && d.birthday_name) d.name = d.birthday_name;
  if(!d.date && d.birthday_date) d.date = d.birthday_date;
  if(!d.date){ toast('Datum fehlt','warn'); return; } const p=parseDateParts(d.date); if(!p){ toast('Ungültiges Datum','error'); return; }
    const payload={type:'birthday', name:d.name||'Geburtstag', month:p.m, day:p.d}; const btn=form.querySelector('button[type=submit]'); const done2=setLoading(btn); try{ await postEvent(payload); toast('Geburtstag gespeichert','success'); form.reset(); loadEvents(); }catch(e){ toast(e.message||'Fehler','error'); } finally { done2(); } }
  async function postEvent(obj){
    try{
      let r= await fetch('/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)});
      if(!r.ok){
        const payload='body='+encodeURIComponent(JSON.stringify(obj));
        r= await fetch('/api/events',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:payload});
      }
      if(!r.ok) throw new Error('HTTP '+r.status);
  // Nach erfolgreichem Speichern Dashboard aktualisieren (Status-Badges)
  refreshDashboard(false);
      return true;
    }catch(e){ console.error('[Events] post fail',e); throw e; }
  }
  async function submitSingle(form){ const d=Object.fromEntries(new FormData(form).entries()); if(d.id){ const payload={}; const btn=form.querySelector('button[type=submit]'); const done=setLoading(btn); if(!d.name && d.single_name) d.name=d.single_name; if(d.name) payload.name=d.name; if(d.date) payload.date=d.date; if(d.single_date && !payload.date) payload.date=d.single_date; if(d.color) payload.color=d.color; try{ await putEvent(d.id,payload); toast('Aktualisiert','success'); State.editEvent=null; loadEvents(); form.reset(); }catch(e){ toast(e.message||'Fehler','error'); } finally { done(); } return; }
    // Wizard uses single_date as field name -> map
    if(!d.name && d.single_name) d.name = d.single_name;
    if(!d.date && d.single_date) d.date = d.single_date;
    if(!d.date){ toast('Datum fehlt','warn'); return;}
    // Datum normalisieren: akzeptiere YYYY-MM-DD oder DD.MM.YYYY
    let iso = d.date.trim();
    if(/^[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{2,4}$/.test(iso)){
      const parts=iso.split('.'); let dd=parseInt(parts[0],10); let mm=parseInt(parts[1],10); let yy=parseInt(parts[2],10); if(yy<100){ yy += (yy>=70?1900:2000); }
      if(yy>1900 && mm>=1&&mm<=12 && dd>=1&&dd<=31){ iso = `${yy.toString().padStart(4,'0')}-${mm.toString().padStart(2,'0')}-${dd.toString().padStart(2,'0')}`; }
    }
    if(!/^\d{4}-\d{2}-\d{2}$/.test(iso)){ toast('Ungültiges Datum','error'); return; }
    // Zusätzlich year/month/day mitsenden für Backend-Fallback
    const y=parseInt(iso.substring(0,4),10), m=parseInt(iso.substring(5,7),10), da=parseInt(iso.substring(8,10),10);
    const payload={type:'single', name:d.name||'Termin', date:iso, year:y, month:m, day:da, color:d.color||'#ff8800'};
    const btn=form.querySelector('button[type=submit]'); const done2=setLoading(btn); try{ await postEvent(payload); toast('Termin gespeichert','success'); form.reset(); loadEvents(); }catch(e){ toast(e.message||'Fehler','error'); } finally { done2(); } }
  function collectWeekdays(form){ return Array.from(form.querySelectorAll('input[name=wd]:checked')).map(i=>parseInt(i.value)); }
  async function submitSeries(form){ const d=Object.fromEntries(new FormData(form).entries()); const wds=collectWeekdays(form); if(d.id){ const payload={}; const btn=form.querySelector('button[type=submit]'); const done=setLoading(btn); if(d.name) payload.name=d.name; if(d.recur) payload.recur=d.recur; if(wds.length) payload.weekdays=wds; if(d.color) payload.color=d.color; if(d.recur==='monthly' && d.monthly_pos) payload.monthly_pos=parseInt(d.monthly_pos); try{ await putEvent(d.id,payload); toast('Aktualisiert','success'); State.editEvent=null; loadEvents(); form.reset(); }catch(e){ toast(e.message||'Fehler','error'); } finally { done(); } return; }
  if(!d.name && d.series_name) d.name = d.series_name;
  if(!wds.length){ toast('Mindestens ein Wochentag','warn'); return; } const payload={type:'series', name:d.name||'Serie', recur:d.recur||'weekly', weekdays:wds, color:d.color||'#33aaff'}; if(d.recur==='monthly' && d.monthly_pos) payload.monthly_pos=parseInt(d.monthly_pos); const btn=form.querySelector('button[type=submit]'); const done2=setLoading(btn); try{ await postEvent(payload); toast('Serie gespeichert','success'); form.reset(); toggleMonthlyPos(form); loadEvents(); }catch(e){ toast(e.message||'Fehler','error'); } finally { done2(); } }
  async function putEvent(id,obj){ try{ let r= await fetch('/api/events?id='+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)}); if(!r.ok){ const payload='body='+encodeURIComponent(JSON.stringify(obj)); r= await fetch('/api/events?id='+id,{method:'PUT',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:payload}); } if(!r.ok) throw new Error('HTTP '+r.status); return true; }catch(e){ console.error('[Events] put fail',e); throw e; } }
  async function deleteEvent(id){ if(!confirm('Löschen?')) return; try{ await fetch('/api/events?id='+id,{method:'DELETE'}); toast('Gelöscht','success'); loadEvents(); }catch(e){ toast('Löschen fehlgeschlagen','error'); } }
  function toggleMonthlyPos(form){ const sel=form.querySelector('select[name=recur]'); const mp=form.querySelector('select[name=monthly_pos]'); if(!sel||!mp) return; if(sel.value==='monthly'){ mp.style.display=''; } else { mp.style.display='none'; mp.value=''; } }

  // Wizard-specific helpers for events
  function fieldInline(label,name,type,value,fkey){ return h('label',{class:'field'},label,h('input',{name,type,value:value||'', 'data-fkey':fkey||name})); }
  function labelWrap(label,el){ return h('label',{class:'field'},label,el); }
  async function addBirthdayWizard(form){ await submitBirthday(form); }
  async function addSingleWizard(form){ await submitSingle(form); }
  async function addSeriesWizard(form){ await submitSeries(form); }

  // ---- Modal Handling for Events ----
  function openEventModal(type, ev){
    const existing=document.getElementById('modal-backdrop'); if(existing) existing.remove();
    const backdrop=document.createElement('div'); backdrop.id='modal-backdrop'; backdrop.className='modal-backdrop';
    const modal=document.createElement('div'); modal.className='modal';
    const title=document.createElement('h2'); title.textContent=(ev? 'Bearbeiten: ' : 'Neu: ')+ (type==='birthday'?'Geburtstag': type==='single'?'Termin':'Serientermin');
    const closeBtn=document.createElement('button'); closeBtn.className='modal-close'; closeBtn.textContent='×'; closeBtn.type='button'; closeBtn.onclick=()=>backdrop.remove();
    modal.appendChild(closeBtn);
    modal.appendChild(title);
    const form=document.createElement('form'); form.className='event-form';
    if(ev) form.appendChild(createHidden('id',ev.id));
    if(type==='birthday') buildBirthdayForm(form,ev);
    else if(type==='single') buildSingleForm(form,ev);
    else buildSeriesForm(form,ev);
    const actions=document.createElement('div'); actions.className='actions';
    const save=document.createElement('button'); save.type='submit'; save.textContent= ev? 'Aktualisieren':'Speichern';
    const cancel=document.createElement('button'); cancel.type='button'; cancel.textContent='Abbrechen'; cancel.className='secondary'; cancel.onclick=()=>backdrop.remove();
    actions.appendChild(cancel); actions.appendChild(save);
    form.appendChild(actions);
    form.onsubmit=(e)=>{
      e.preventDefault();
      if(type==='birthday') submitBirthday(form);
      else if(type==='single') submitSingle(form);
      else submitSeries(form);
      // Close after short delay to allow toast
      setTimeout(()=>{ if(document.getElementById('modal-backdrop')) backdrop.remove(); },300);
    };
    modal.appendChild(form);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    setTimeout(()=>{ const first=form.querySelector('input,select'); if(first) first.focus(); },10);
  }
  function createHidden(name,val){ const i=document.createElement('input'); i.type='hidden'; i.name=name; i.value=val; return i; }
  function buildBirthdayForm(form,ev){
    form.appendChild(labelWrapSimple('Name',inputText('name',ev?ev.name:'')));
    if(!ev){ form.appendChild(labelWrapSimple('Datum',inputField('date','date',''))); }
  }
  function buildSingleForm(form,ev){
    form.appendChild(labelWrapSimple('Name',inputText('name',ev?ev.name:'')));
    form.appendChild(labelWrapSimple('Datum',inputField('date','date',ev?ev.date:'')));
    form.appendChild(labelWrapSimple('Farbe',inputField('color','color',ev?(ev.color||'#ff8800'):'#ff8800')));
  }
  function buildSeriesForm(form,ev){
    form.appendChild(labelWrapSimple('Name',inputText('name',ev?ev.name:'')));
    const recur=inputSelect('recur',['weekly','biweekly','monthly'], ev?ev.recur:'weekly'); form.appendChild(labelWrapSimple('Wiederholung',recur));
    const mp=inputSelect('monthly_pos',['','1','2','3','4'], ev? (ev.monthly_pos?String(ev.monthly_pos):'') : ''); mp.style.display= (recur.value==='monthly')?'':'none'; form.appendChild(labelWrapSimple('Monats-Pos',mp));
    recur.addEventListener('change',()=>{ mp.style.display= recur.value==='monthly'? '' : 'none'; if(recur.value!=='monthly') mp.value=''; });
    const wdWrap=document.createElement('div'); wdWrap.className='weekday-select'; ['Mo','Di','Mi','Do','Fr','Sa','So'].forEach((lbl,i)=>{ const idx=i+1; const lab=document.createElement('label'); lab.className='wd'; const cb=document.createElement('input'); cb.type='checkbox'; cb.name='wd'; cb.value=String(idx); if(ev && Array.isArray(ev.weekdays) && ev.weekdays.includes(idx)) cb.checked=true; lab.appendChild(cb); lab.appendChild(document.createTextNode(lbl)); wdWrap.appendChild(lab); });
    form.appendChild(labelWrapSimple('Wochentage',wdWrap));
    form.appendChild(labelWrapSimple('Farbe',inputField('color','color',ev?(ev.color||'#33aaff'):'#33aaff')));
  }
  function inputText(name,val){ return inputField(name,'text',val); }
  function inputField(name,type,val){ const i=document.createElement('input'); i.name=name; i.type=type; if(val!=null) i.value=val; return i; }
  function inputSelect(name,options,val){ const s=document.createElement('select'); s.name=name; options.forEach(o=>{ const opt=document.createElement('option'); opt.value=o; opt.textContent= o===''?'- Pos -': (o==='weekly'?'Wöchentlich': o==='biweekly'?'14-tägig': o==='monthly'?'Monatlich': o); if(o===val) opt.selected=true; s.appendChild(opt); }); return s; }
  function labelWrapSimple(label,el){ const l=document.createElement('label'); l.className='field'; const span=document.createElement('span'); span.textContent=label; l.appendChild(span); l.appendChild(el); return l; }
  async function saveMQTT(form){
  console.debug('[MQTT][SAVE] handler invoked');
    const raw=Object.fromEntries(new FormData(form).entries());
    // Leere Felder entfernen, Passwort nur senden wenn eingegeben
    const data={};
    for(const [k,v] of Object.entries(raw)){
      if(k==='pass' && !v) continue; // nicht überschreiben wenn leer
      if(v!=='' && v!=null) data[k]=v;
    }
    const btn=form.querySelector('button[type=submit]'); const done=setLoading(btn);
    try{ 
      console.debug('[MQTT][SAVE] sending', data);
      const r= await fetch('/api/settings/mqtt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
      const txt= await r.text();
      console.debug('[MQTT][SAVE] response', r.status, txt);
  if(r.ok){ toast('MQTT gespeichert – Neustart nötig','success'); State.mqttNeedsRestart=true; showRestartHint(); }
      else { toast('MQTT Fehler '+r.status,'error'); }
      await refreshDashboard(true);
    }
    catch(e){ console.error('[MQTT][SAVE] error',e); toast('Fehler MQTT','error'); }
    finally { done(); State.editingActive=false; }
  }

  function showRestartHint(){
    // Insert restart hint only once per render
    if(document.getElementById('restart-hint')) return;
    const form=document.getElementById('mqtt-form');
    if(!form) return;
  State.mqttNeedsRestart=true; // persist across renders
    const box=document.createElement('div');
    box.id='restart-hint';
  box.className='restart-hint';
  box.innerHTML='<strong>Neustart erforderlich:</strong> Die neuen MQTT Einstellungen werden erst nach einem Neustart aktiv.';
    const btn=document.createElement('button');
    btn.type='button';
    btn.textContent='Jetzt neu starten';
    btn.addEventListener('click',async()=>{
      btn.disabled=true; const old=btn.textContent; btn.textContent='Neustart…';
      try{ const r=await fetch('/api/restart',{method:'POST'}); if(r.ok){ toast('Gerät startet neu…'); State.mqttNeedsRestart=false; beginRebootWatch(false); } else { toast('Neustart fehlgeschlagen'); btn.disabled=false; btn.textContent=old; } }
      catch(err){ console.error('Restart failed',err); toast('Netzwerkfehler'); btn.disabled=false; btn.textContent='Jetzt neu starten'; }
    });
    box.appendChild(btn);
    form.appendChild(box);
  }

  function beginRebootWatch(longWait){
    if(State.rebootWatching) return;
    State.rebootWatching=true;
    let sawDown=false; const start=Date.now();
    const maxMs= longWait? 45000 : 25000;
    const attempt=()=>{
      fetch('/api/dashboard',{cache:'no-store'}).then(r=>{
        if(!r.ok) throw new Error('bad');
        if(sawDown){ location.reload(); }
        else { if(Date.now()-start>maxMs){ location.reload(); return; } setTimeout(attempt,1000); }
      }).catch(()=>{ sawDown=true; if(Date.now()-start>maxMs){ location.reload(); return; } setTimeout(attempt,1500); });
    };
    setTimeout(attempt, longWait? 3000 : 1500);
  }

  // Init
  function pushAppState(){/* legacy noop */}
  window.addEventListener('popstate',e=>{
    if(e.state && e.state.app){
      State.wizardMode=e.state.wizard;
      State.step=e.state.step;
      State.view=e.state.view;
      State.subView=e.state.sub;
      render();
    } else {
      // If no state (e.g., user opened with deep hash) just reinsert current
      try{ history.replaceState({app:1,wizard:State.wizardMode,step:State.step,view:State.view,sub:State.subView},''); }catch(_){ }
    }
  });
  // Wizard-Initialisierung robuster: Nur Wizard anzeigen, wenn Stage wirklich 'wifi' unter AP/ohne Online ist oder explizit noch Pflichtschritte anstehen.
  if(State.dashboard?.stage==='done' && localStorage.getItem('rcWizardDone')==='1') {
    State.wizardMode=false; State.view='Dashboard';
  } else if(State.dashboard?.stage==='wifi') {
    const looksLikeSetup = State.dashboard?.apMode || !State.dashboard?.online || !State.dashboard?.wifi_ssid;
    State.wizardMode = !!looksLikeSetup;
  } else {
    State.wizardMode=true;
  }
  if(localStorage.getItem('rcSkipWaste')==='1') { State.skipWaste=true; }
  pollForStage();
  refreshDashboard(true);
  render();
  // Initial history state already replaced in first render
  // Loop nur starten wenn Wizard bereits abgeschlossen ist
  if(!State.wizardMode) startDashboardLoop();
  // --- Global input activity tracking to prevent focus loss ---
  document.addEventListener('focusin',e=>{ if(e.target && ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){ State.editingActive=true; }});
  document.addEventListener('focusout',e=>{ if(e.target && ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){ setTimeout(()=>{ if(!document.activeElement || !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) State.editingActive=false; },120); }});
  document.addEventListener('input',e=>{ if(e.target && ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){ State.lastInputActivity=Date.now(); }});
  // Pointer-Interaktion ebenfalls als Aktivität zählen (relevant für mobile Datepicker, die Fokus entziehen)
  document.addEventListener('pointerdown',e=>{ if(e.target && e.target.tagName==='INPUT'){ State.lastInputActivity=Date.now(); }});

  // Auto-Logout nach Inaktivität (Client-seitig), ergänzt serverseitiges 1h-Timeout
  State.lastActivityTs = Date.now();
  const bumpActivity = ()=>{ State.lastActivityTs = Date.now(); };
  ['pointerdown','keydown','wheel','touchstart','focusin','input'].forEach(evt=>document.addEventListener(evt,bumpActivity,{passive:true}));
  const INACT_MS = 50*60*1000; // 50 Minuten
  setInterval(async ()=>{
    if(!State.dashboard || !State.dashboard.authRequired) return;
    if(State.dashboard && State.dashboard.authed){
      const idle = Date.now() - (State.lastActivityTs||0);
      if(idle > INACT_MS){
        try{ await fetch('/api/auth/logout',{method:'POST'}); }catch(_){ }
        await refreshDashboard(true);
        showLoginGate();
      }
    }
  }, 30000);

  // Generic loading helper
  function setLoading(btn){
    if(!btn) return ()=>{};
    const oldTxt=btn.textContent; btn.disabled=true; btn.classList.add('loading'); btn.textContent='...';
    return ()=>{ btn.disabled=false; btn.classList.remove('loading'); btn.textContent=oldTxt; };
  }
})();
