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
  ,otaStatus:null
  ,otaTimer:null
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
    if(!r.ok) throw new Error(r.status+' '+r.statusText);
    const ct=r.headers.get('content-type')||'';
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
    let restoreKey=null; let caretPos=null;
    if(isEditable){ restoreKey=active.getAttribute('name')||active.id; try{ if(active.selectionStart!=null) caretPos=active.selectionStart; }catch(_){} }
    app.innerHTML='';
    if(State.wizardMode) renderWizard(); else renderMain();
  // Push history state on each primary render so back button works predictably
  // (avoid duplicate entries by replaceState instead of pushState)
  pushAppState();
    if(restoreKey){ const el=document.querySelector(`[name="${restoreKey}"]`)||document.getElementById(restoreKey); if(el){ el.focus(); try{ if(caretPos!=null && el.setSelectionRange) el.setSelectionRange(caretPos,caretPos); }catch(_){} } }
  }

  function renderWizard(){
    const wrap=h('div',{class:'wizard'});
    // Steps: 0 WLAN,1 Adresse,2 Abfall,3 Termine(optional),4 Börsenkurse(optional),5 Fertig
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
  const pwInput=h('input',{id:'wifi-password',name:'password',type:'password',required:true,placeholder:'Passwort',value:State.wifiPassword||'',oninput:e=>{State.wifiPassword=e.target.value;}});
  form.appendChild(h('label',{class:'field'},'Passwort',pwInput));
      form.appendChild(h('div',{class:'actions'},h('button',{type:'submit'},'Verbinden')));
      wrap.appendChild(form);
      const hint=h('div',{class:'card'},
  h('p',{},'Falls keine Netze erscheinen: Gerät näher an Router, kurz warten und "Aktualisieren" drücken.'),
        h('p',{class:'small muted'},'Nach dem Verbinden wechselt dein Gerät ggf. automatisch ins Heimnetz. Diese Seite kann kurzzeitig nicht erreichbar sein.')
      ); 
      wrap.appendChild(hint);
    }
  else if(State.step===1){
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
  if(!State.addrCountry) State.addrCountry = State.dashboard?.country||'DE';
  form.appendChild(h('div',{class:'field-row'},
    h('label',{class:'field compact'},'PLZ',h('input',{name:'postalCode',placeholder:'12345',value:State.addrPostal,oninput:e=>{State.addrPostal=e.target.value;}})),
    h('label',{class:'field compact'},'Stadt',h('input',{name:'city',required:true,placeholder:'Stadt',value:State.addrCity,oninput:e=>{State.addrCity=e.target.value;}})),
    h('label',{class:'field compact'},'Land',h('input',{name:'country',placeholder:'DE',value:State.addrCountry,oninput:e=>{State.addrCountry=e.target.value;}}))
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
    } else if(State.step===2){
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
            h('p',{},'Lokaler Entsorger: '+State.dashboard.wasteProviderName),
            h('p',{},h('a',{href:State.dashboard.wasteProviderUrl,target:'_blank'},'Website öffnen'))
          ));
        }
        if(State.dashboard.wasteProviderSearchUrl){
          wrap.appendChild(h('div',{class:'card'},
            h('p',{},'Falls nicht passend: '),
            h('p',{},h('a',{href:State.dashboard.wasteProviderSearchUrl,target:'_blank'},'Google Suche nach regionalem Abfuhrkalender'))
          ));
        }
      }
  if(!State.wasteIcalDraft && State.dashboard?.wasteIcalUrl) State.wasteIcalDraft=State.dashboard.wasteIcalUrl;
  const form=h('form',{onsubmit:e=>{e.preventDefault();saveWaste(form);}});
  form.appendChild(h('label',{class:'field'},'iCal URL',h('input',{name:'url',type:'url',placeholder:'https://...',value:State.wasteIcalDraft||'',oninput:e=>{State.wasteIcalDraft=e.target.value;}})));
    // Aktionen: Importieren + Überspringen nebeneinander (Skip nur wenn noch nicht bestätigt)
    const actionChildren=[ h('button',{type:'submit'}, State.dashboard?.wasteIcalUrl?'Neu laden':'Importieren') ];
    if(!State.dashboard?.wasteConfirmed){
      actionChildren.push(
  h('button',{type:'button',class:'secondary',onclick:()=>{ if(!State.skipWaste){ State.skipWaste=true; localStorage.setItem('rcSkipWaste','1'); } State.step=3; State.view=null; render(); }},'Überspringen')
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
      addColor('Bio','bio',State.dashboard.wasteColorBio);
      addColor('Restmüll','residual',State.dashboard.wasteColorResidual);
      addColor('Papier','paper',State.dashboard.wasteColorPaper);
      addColor('Verpackung','packaging',State.dashboard.wasteColorPackaging);
      addColor('Garten','green',State.dashboard.wasteColorGreen);
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
      wrap.appendChild(h('div',{class:'card'},h('p',{},'Import läuft...')));
    }
  } else if(State.step===3){
      wrap.appendChild(h('h1',{},'Termine & Geburtstage'));
      wrap.appendChild(h('p',{},'Lege wiederkehrende oder einzelne Termine sowie Geburtstage an. Dies kann auch später in den Einstellungen erfolgen.'));
      // Simple inline forms (reuse helper builders later in settings view)
      const section=h('div',{class:'grid'});
      // Birthday form
      const fb=h('form',{onsubmit:e=>{e.preventDefault();addBirthdayWizard(fb);}});
      fb.appendChild(fieldInline('Name','name','text',State.draftBirthday.name||''));
      fb.querySelector('input[name=name]').addEventListener('input',e=>{State.draftBirthday.name=e.target.value;});
      fb.appendChild(fieldInline('Geburtstag','date','date',State.draftBirthday.date||''));
      fb.querySelector('input[name=date]').addEventListener('input',e=>{State.draftBirthday.date=e.target.value;});
      fb.appendChild(h('div',{class:'actions'},h('button',{type:'submit'},'Geburtstag hinzufügen')));
      section.appendChild(h('div',{class:'card'},h('header',{},h('h3',{},'Geburtstag')),fb));
      // Single event form
  const fs=h('form',{onsubmit:e=>{e.preventDefault();addSingleWizard(fs);}});
  fs.appendChild(fieldInline('Name','name','text',State.draftSingle.name||''));
  fs.querySelector('input[name=name]').addEventListener('input',e=>{State.draftSingle.name=e.target.value;});
  fs.appendChild(fieldInline('Datum','date','date',State.draftSingle.date||''));
  fs.querySelector('input[name=date]').addEventListener('input',e=>{State.draftSingle.date=e.target.value;});
  const singleColorChooser=colorChooser('color',State.draftSingle.color||'#ff8800');
  singleColorChooser.addEventListener('input',e=>{ if(e.target && e.target.name==='color'){ State.draftSingle.color=e.target.value; }});
  fs.appendChild(labelWrap('Farbe',singleColorChooser));
      fs.appendChild(h('div',{class:'actions'},h('button',{type:'submit'},'Einmaligen Termin hinzufügen')));
      section.appendChild(h('div',{class:'card'},h('header',{},h('h3',{},'Einmaliger Termin')),fs));
      // Series event form
  const fser=h('form',{onsubmit:e=>{e.preventDefault();addSeriesWizard(fser);}});
      fser.appendChild(fieldInline('Name','name','text',State.draftSeries.name||''));
      fser.querySelector('input[name=name]').addEventListener('input',e=>{State.draftSeries.name=e.target.value;});
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
        h('button',{class:'secondary',onclick:()=>{ State.step=4; render(); }},'Überspringen'),
        h('button',{onclick:()=>{ State.step=4; render(); }},'Weiter')
      ));
    } else if(State.step===4){
      // New markets step (BTC / MSCI)
      wrap.appendChild(h('h1',{},'Börsenkurse'));
      wrap.appendChild(h('p',{},'Aktivierte die Anzeige der Bitcoin oder MSCI World ETF Kursänderungen. Die Anzeige erfolgt bei Tagesveränderung > ±0.5% gegenüber dem Vortag.'));
      const form=h('form',{onsubmit:e=>{e.preventDefault(); saveMarkets(form); }});
      const btcSel=h('select',{name:'btc'},
        h('option',{value:'off'},'Deaktiviert'),
        h('option',{value:'auto'},'Automatisch')
      );
      const msciSel=h('select',{name:'msci'},
        h('option',{value:'off'},'Deaktiviert'),
        h('option',{value:'auto'},'Automatisch')
      );
      setTimeout(()=>{ if(State.dashboard){ btcSel.value=State.dashboard.marketBtcMode||'off'; msciSel.value=State.dashboard.marketMsciMode||'off'; } },0);
      form.appendChild(labelWrap('BTC', btcSel));
      form.appendChild(labelWrap('MSCI', msciSel));
      form.appendChild(h('div',{class:'actions'},
        h('button',{type:'button',class:'secondary',onclick:()=>{ State.step=5; render(); }},'Überspringen'),
        h('button',{type:'submit'},'Speichern & Weiter')
      ));
      wrap.appendChild(form);
    } else if(State.step===5){
      wrap.appendChild(h('h1',{},'Fertig'));
      wrap.appendChild(h('p',{},'Die Konfiguration deiner Remindi-Clock ist abgeschlossen.'));
      wrap.appendChild(h('div',{class:'actions'},h('button',{onclick:()=>{ localStorage.setItem('rcWizardDone','1'); State.wizardMode=false; State.view='Dashboard'; render(); }},'Zum Dashboard')));
    }
  app.appendChild(wrap);
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
    main.appendChild(h('footer',{},'RemindiClock © '+new Date().getFullYear()));
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
    // Info box
    const info=h('div',{},
      lineKV('IP', d.ip||'-'),
      lineKV('WLAN', (d.wifi_ssid? d.wifi_ssid:'-') + rssiIcon(d.wifi_rssi)),
      lineKV('Uptime', formatUptime(d.uptime_ms)),
      lineKV('Zeitzone', d.timezone||'-'),
      lineKV('Firmware', d.version||'?')
    );
    wrap.appendChild(card('Geräteinfo',info));
    // Restart box
    const restartBox=h('div',{},h('p',{},'Neustart des Geräts durchführen.'),h('button',{onclick:confirmRestart},'Neustart'));
    wrap.appendChild(card('Neustart',restartBox));
    // Factory reset box
    const resetBox=h('div',{},h('p',{},'Alle Einstellungen löschen und Werkseinstellungen laden.'),h('button',{class:'danger',onclick:factoryResetConfirm},'Werkseinstellungen'));
    wrap.appendChild(card('Werkseinstellungen',resetBox));
  // OTA Update Box
  wrap.appendChild(buildOtaCard());
    // UPDATE Wort Toggle
    const updMode = (d.updateWordMode)|| (d.weatherWords && d.weatherWords.UPDATE && d.weatherWords.UPDATE.mode) || 'auto';
    const updWrap=h('div',{});
    const btnRow=h('div',{class:'inline-btns'});
    function renderUpdBtns(){ btnRow.innerHTML=''; ['auto','disabled'].forEach(m=>{ btnRow.appendChild(h('button',{class:'mini'+(updWrap.dataset.mode===m?' active':''),onclick:()=>{ updWrap.dataset.mode=m; renderUpdBtns(); }}, m==='auto'?'AUTO':'AUS')); }); }
    updWrap.dataset.mode=updMode==='disabled'?'disabled':'auto';
    renderUpdBtns();
    const saveBtn=h('button',{onclick:async()=>{
      const mode=updWrap.dataset.mode;
      try {
        const payload={ UPDATE:{ enabled: mode==='auto' } };
        await api('/api/settings/weather-words',{method:'POST',body:JSON.stringify(payload)});
        toast('UPDATE Wort gespeichert','success');
        await refreshDashboard(true);
      } catch(e){ toast('Fehler beim Speichern','error'); }
    }},'Speichern');
    updWrap.appendChild(h('p',{class:'small'},'Wort "UPDATE" anzeigen bei verfügbarem/aktivem Update.'));
    updWrap.appendChild(btnRow);
    updWrap.appendChild(h('div',{class:'actions'},saveBtn));
    wrap.appendChild(card('Wort UPDATE', updWrap));
    return wrap;
  }
  function buildOtaCard(){
    const box=h('div',{});
    const st=State.otaStatus;
    if(!st){ box.appendChild(h('p',{},'OTA Status wird geladen...')); loadOTAStatus(); return card('Software Update',box); }
    if(st.metadataVersion){
      box.appendChild(h('div',{class:'kv'},h('strong',{},'Verfügbare Version: '),h('span',{},st.metadataVersion)));
    } else {
      box.appendChild(h('p',{},'Kein Update verfügbar. Version 0.3.2 ist aktuell.'));
    }
    if(st.changelog){
      box.appendChild(h('details',{},h('summary',{},'Changelog anzeigen'), h('pre',{style:'white-space:pre-wrap;font-size:0.75rem;'}, st.changelog)));
    }
    if(st.hasUpdate){
      const btn=h('button',{class:'primary',onclick:()=>startOTAUpdate(btn,st.metadataVersion)},'Update installieren');
      box.appendChild(h('div',{class:'actions'},btn));
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
  function lineKV(k,v){ return h('div',{class:'kv'},h('strong',{},k+': '),h('span',{},v)); }
  function rssiIcon(r){ if(r==null) return ''; let lvl=1; if(r>-55) lvl=4; else if(r>-65) lvl=3; else if(r>-75) lvl=2; else lvl=1; return ' '+['▂','▃','▅','█'][lvl-1]; }
  function formatUptime(ms){ if(!ms && ms!==0) return '-'; const s=Math.floor(ms/1000); const d=Math.floor(s/86400); const h=Math.floor((s%86400)/3600); const m=Math.floor((s%3600)/60); let out=''; if(d) out+=d+'d '; out+=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0'); return out; }
  function confirmRestart(){ if(!confirm('Gerät wirklich neu starten?')) return; fetch('/api/restart',{method:'POST'}).then(()=>toast('Neustart ausgeführt')); }
  function factoryResetConfirm(){ if(!confirm('ALLE Einstellungen löschen?')) return; factoryReset(); }

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
    f.appendChild(h('button',{type:'submit'},'Speichern'));
    return card('Wetter Wörter (Auto-Modus)',f);
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
    awForm.appendChild(h('button',{type:'submit'},'Speichern'));
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
      return card(title,box,h('button',{class:'secondary',onclick:()=>openEventModal(type,null)},'Hinzufügen'));
    };
    wrap.appendChild(buildList('Geburtstage',groups.birthday,'birthday'));
    wrap.appendChild(buildList('Einmalige Termine',groups.single,'single'));
    wrap.appendChild(buildList('Serientermine',groups.series,'series'));
    if(!State.eventsLoaded) loadEvents();
    return wrap;
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
  f.appendChild(field('Basis Topic','base','text',dash.mqttBase||'wortuhr'));
  const c=card('MQTT Verbindung',f,h('button',{type:'submit'},'Speichern'));
  // After first render of card, inject restart hint if pending
  setTimeout(()=>{ if(State.mqttNeedsRestart) showRestartHint(); },0);
  return c;
  }

  function viewMarkets(){
    const d=State.dashboard||{};
    const form=h('form',{onsubmit:e=>{e.preventDefault();saveMarkets(form);}});
    const btcSel=h('select',{name:'btc'}, h('option',{value:'off'},'Aus'), h('option',{value:'auto'},'Automatisch'));
    const msciSel=h('select',{name:'msci'}, h('option',{value:'off'},'Aus'), h('option',{value:'auto'},'Automatisch'));
    setTimeout(()=>{ btcSel.value=d.marketBtcMode||'off'; msciSel.value=d.marketMsciMode||'off'; },0);
    form.appendChild(labelWrap('BTC',btcSel));
    form.appendChild(labelWrap('MSCI',msciSel));
    return card('Börsenkurse',form,h('button',{type:'submit'},'Speichern'));
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
  // Nach Adresseingabe direkt zu Schritt 2 (Abfall) wechseln
  await refreshDashboard();
  State.wizardMode=true;
  State.step=2;
  render();
    }catch(e){ toast('Speichern fehlgeschlagen','error'); }
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
    try {
      const dash = await api('/api/dashboard');
      State.dashboard = dash;
  if(State.wizardMode){
        const st = dash.stage;
    if(st==='wifi') State.step=0;
    else if(st==='address') State.step=1;
    else if(st==='waste' && !State.skipWaste) State.step=2; // nur anzeigen wenn nicht übersprungen
    else if(st==='done'){
          // Nur verlassen, wenn Nutzer wirklich final (Schritt 5) war oder gerade fertigstellt
          const doneFlag = localStorage.getItem('rcWizardDone')==='1';
          if(doneFlag && State.step>=5){
            State.wizardMode=false; State.view='Dashboard';
          } else {
            if(State.step < 3) State.step=3; // in optionale Schritte wechseln
          }
        }
      }
      // Fokus schützen: Ab Schritt 3 keine erzwungene Re-Renders durch Poll, außer Schritt hat sich geändert
      if(!(State.wizardMode && State.step>=3 && dash.stage==='done')){
        render();
      }
    } catch(e) {}
    if(State.wizardMode) setTimeout(pollForStage,3000);
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
    // Nur bei Regression auf wifi / address Wizard forcieren (SPIFFS Reset Szenario), nicht bei waste nach Reimport
    if(!suppressWizard && !State.wizardMode && localStorage.getItem('rcWizardDone')==='1' && stRe && stRe!=='done'){
      if((stRe==='wifi' || stRe==='address')){
        localStorage.removeItem('rcWizardDone');
        State.wizardMode=true;
        State.step = (stRe==='wifi')?0:1;
      }
    }
    let stepBefore=State.step; const newStage=State.dashboard?.stage;
    if(State.wizardMode){
      const st=State.dashboard?.stage;
      if(State.waitWasteImport){
        if(State.dashboard?.wasteEvents){ State.waitWasteImport=false; }
        else { State.step=2; }
      }
      if(!State.waitWasteImport){
    if(st==='wifi'){ State.step=0; }
    else if(st==='address'){ State.step=1; }
    else if(st==='waste' && !State.skipWaste){ State.step=2; }
    else if(st==='done'){
          const doneFlag = localStorage.getItem('rcWizardDone')==='1';
          if(doneFlag && State.step>=5){
            State.wizardMode=false; State.view='Dashboard';
          } else {
            if(!State.dashboard?.wasteConfirmed && !State.skipWaste){ State.step=2; }
            else if(State.step<3) State.step=3;
          }
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
  // Skip re-render if user actively editing (any view) and no stage transition occurred
  if(!force && State.editingActive && prevStage===newStage && (Date.now()-State.lastInputActivity)<5000){
    return; // underlying data updated, UI stays for smoother typing
  }
  // Prevent wizard step 3 form clearing: do not re-render unless stage changed or user navigates
  if(!force && State.wizardMode && State.step>=3 && prevStage===newStage){
    return;
  }
    render();
  }
  function startDashboardLoop(){ if(State.dashTimer) return; State.dashTimer=setInterval(()=>{ if(State.wizardMode) refreshDashboard(false); },5000);} 
  function stopDashboardLoop(){ if(State.dashTimer){ clearInterval(State.dashTimer); State.dashTimer=null; } }
  async function factoryReset(){
    // Zweite Sicherheitsabfrage (erste in factoryResetConfirm) bleibt für direkte Aufrufe bestehen
    if(confirm('Wirklich zurücksetzen?')) {
      try {
        // Lokale Wizard-Flags sofort löschen, damit nach Reload Wizard wieder startet
        localStorage.removeItem('rcWizardDone');
        localStorage.removeItem('rcSkipWaste');
        // UI direkt in Wizard-Modus versetzen (falls Gerät etwas verzögert neu startet)
        State.wizardMode=true; State.skipWaste=false; State.step=0; State.view=null; render();
        await api('/api/settings/factory-reset',{method:'POST'});
        toast('Reset, Neustart...','warn');
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
  async function importWaste(form){ const d=Object.fromEntries(new FormData(form).entries()); try{ await api('/api/waste/ical',{method:'POST',body:JSON.stringify({url:d.ical})}); toast('Kalender gespeichert','success'); State.waitWasteImport=true; State.step=2; State.wasteIcalDraft=d.ical; await refreshDashboard(); render(); let tries=0; const poll=async()=>{ tries++; await refreshDashboard(); if(State.dashboard?.wasteEvents || tries>8){ render(); } else setTimeout(poll,1200); }; poll(); }catch(e){ toast('Fehler beim Import','error'); } }
  async function saveWaste(form){ const d=Object.fromEntries(new FormData(form).entries()); try{ await api('/api/waste/ical',{method:'POST',body:JSON.stringify({url:d.url})}); toast('Abfall iCal gespeichert','success'); State.waitWasteImport=true; State.step=2; await refreshDashboard(); render(); let tries=0; const poll=async()=>{ tries++; await refreshDashboard(); if(State.dashboard?.wasteEvents || tries>8){ render(); } else setTimeout(poll,1200); }; poll(); }catch(e){ toast('Speichern fehlgeschlagen','error'); } }
  async function saveWasteColors(form){ const d=Object.fromEntries(new FormData(form).entries()); const btn=form.querySelector('button[type=submit]'); const done=setLoading(btn); try{ await api('/api/waste/colors',{method:'POST',body:JSON.stringify(d)}); toast('Farben gespeichert','success'); await refreshDashboard(); render(); }catch(e){ toast('Fehler beim Speichern','error'); } finally { done(); } }
  async function saveAbfallMode(form){ const d=Object.fromEntries(new FormData(form).entries()); const mode=(d.abfall_mode==='disabled')?'disabled':'auto'; try{ await api('/api/settings/weather-words',{method:'POST',body:JSON.stringify({ABFALL:{enabled:mode==='auto'}})}); toast('ABFALL Modus gespeichert','success'); await refreshDashboard(true); }catch(e){ toast('Speichern fehlgeschlagen','error'); } }
  function setAbfallMode(mode,wrap){ const btns=wrap.querySelectorAll('button'); btns.forEach(b=>{ b.classList.remove('active'); if(b.getAttribute('data-mode')===mode) b.classList.add('active'); }); const form=wrap.closest('form'); const hidden=form.querySelector('input[name=abfall_mode]'); hidden.value=mode; }
  async function reimportWasteConfirm(){
    if(!confirm('Alle importierten Abfall-Termine löschen und neuen iCal Link importieren?')) return;
    State.reimportInProgress=true;
    try{
      const res = await api('/api/waste/clear',{method:'POST'});
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
          State.dashboard.wasteConfirmed = false;
          State.dashboard.wasteIcalUrl = null;
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
  async function confirmWasteSetup(form){ try{ if(form){ const d=Object.fromEntries(new FormData(form).entries()); State.pendingWasteColors=d; await api('/api/waste/colors',{method:'POST',body:JSON.stringify(d)}); } await api('/api/waste/colors',{method:'POST',body:JSON.stringify({confirm:true})}); toast('Abfall-Konfiguration bestätigt','success'); State.pendingWasteColors=null; await refreshDashboard(); State.step=3; render(); }catch(e){ toast('Fehler bei Bestätigung','error'); } }
  async function saveWasteColor(form){ const d=Object.fromEntries(new FormData(form).entries()); try{ await api('/api/waste/color',{method:'POST',body:JSON.stringify({color:d.color})}); toast('Farbe gespeichert','success'); await refreshDashboard(true); }catch(e){ toast('Fehler beim Speichern','error'); } }
  async function saveMarkets(form){ const d=Object.fromEntries(new FormData(form).entries()); try{ await api('/api/settings/markets',{method:'POST',body:JSON.stringify(d)}); toast('Börsenkurse gespeichert','success'); State.step=5; render(); }catch(e){ toast('Speichern fehlgeschlagen','error'); } }
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
  async function submitSingle(form){ const d=Object.fromEntries(new FormData(form).entries()); if(d.id){ const payload={}; const btn=form.querySelector('button[type=submit]'); const done=setLoading(btn); if(d.name) payload.name=d.name; if(d.date) payload.date=d.date; if(d.color) payload.color=d.color; try{ await putEvent(d.id,payload); toast('Aktualisiert','success'); State.editEvent=null; loadEvents(); form.reset(); }catch(e){ toast(e.message||'Fehler','error'); } finally { done(); } return; }
    if(!d.date){ toast('Datum fehlt','warn'); return;} const payload={type:'single', name:d.name||'Termin', date:d.date, color:d.color||'#ff8800'}; const btn=form.querySelector('button[type=submit]'); const done2=setLoading(btn); try{ await postEvent(payload); toast('Termin gespeichert','success'); form.reset(); loadEvents(); }catch(e){ toast(e.message||'Fehler','error'); } finally { done2(); } }
  function collectWeekdays(form){ return Array.from(form.querySelectorAll('input[name=wd]:checked')).map(i=>parseInt(i.value)); }
  async function submitSeries(form){ const d=Object.fromEntries(new FormData(form).entries()); const wds=collectWeekdays(form); if(d.id){ const payload={}; const btn=form.querySelector('button[type=submit]'); const done=setLoading(btn); if(d.name) payload.name=d.name; if(d.recur) payload.recur=d.recur; if(wds.length) payload.weekdays=wds; if(d.color) payload.color=d.color; if(d.recur==='monthly' && d.monthly_pos) payload.monthly_pos=parseInt(d.monthly_pos); try{ await putEvent(d.id,payload); toast('Aktualisiert','success'); State.editEvent=null; loadEvents(); form.reset(); }catch(e){ toast(e.message||'Fehler','error'); } finally { done(); } return; }
    if(!wds.length){ toast('Mindestens ein Wochentag','warn'); return; } const payload={type:'series', name:d.name||'Serie', recur:d.recur||'weekly', weekdays:wds, color:d.color||'#33aaff'}; if(d.recur==='monthly' && d.monthly_pos) payload.monthly_pos=parseInt(d.monthly_pos); const btn=form.querySelector('button[type=submit]'); const done2=setLoading(btn); try{ await postEvent(payload); toast('Serie gespeichert','success'); form.reset(); toggleMonthlyPos(form); loadEvents(); }catch(e){ toast(e.message||'Fehler','error'); } finally { done2(); } }
  async function putEvent(id,obj){ try{ let r= await fetch('/api/events?id='+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)}); if(!r.ok){ const payload='body='+encodeURIComponent(JSON.stringify(obj)); r= await fetch('/api/events?id='+id,{method:'PUT',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:payload}); } if(!r.ok) throw new Error('HTTP '+r.status); return true; }catch(e){ console.error('[Events] put fail',e); throw e; } }
  async function deleteEvent(id){ if(!confirm('Löschen?')) return; try{ await fetch('/api/events?id='+id,{method:'DELETE'}); toast('Gelöscht','success'); loadEvents(); }catch(e){ toast('Löschen fehlgeschlagen','error'); } }
  function toggleMonthlyPos(form){ const sel=form.querySelector('select[name=recur]'); const mp=form.querySelector('select[name=monthly_pos]'); if(!sel||!mp) return; if(sel.value==='monthly'){ mp.style.display=''; } else { mp.style.display='none'; mp.value=''; } }

  // Wizard-specific helpers for events
  function fieldInline(label,name,type,value){ return h('label',{class:'field'},label,h('input',{name,type,value:value||''})); }
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
    box.style.marginTop='12px';
    box.style.padding='10px';
    box.style.border='1px solid #f0ad4e';
    box.style.background='#fff8e5';
    box.style.borderRadius='6px';
    box.style.fontSize='0.85rem';
    box.innerHTML='<strong>Neustart erforderlich:</strong> Die neuen MQTT Einstellungen werden erst nach einem Neustart aktiv. ';
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
  function pushAppState(){ history.replaceState({app:1, step:State.step, view:State.view, sub:State.subView, wizard:State.wizardMode},''); }
  window.addEventListener('popstate',e=>{
    if(e.state && e.state.app){
      State.wizardMode=e.state.wizard;
      State.step=e.state.step;
      State.view=e.state.view;
      State.subView=e.state.sub;
      render();
    } else {
      // stay inside app
      pushAppState();
    }
  });
  if(localStorage.getItem('rcWizardDone')==='1') { State.wizardMode=false; State.view='Dashboard'; }
  if(localStorage.getItem('rcSkipWaste')==='1') { State.skipWaste=true; }
  pollForStage();
  refreshDashboard(true);
  render();
  pushAppState();
  startDashboardLoop();
  // --- Global input activity tracking to prevent focus loss ---
  document.addEventListener('focusin',e=>{ if(e.target && ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){ State.editingActive=true; }});
  document.addEventListener('focusout',e=>{ if(e.target && ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){ setTimeout(()=>{ if(!document.activeElement || !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) State.editingActive=false; },120); }});
  document.addEventListener('input',e=>{ if(e.target && ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){ State.lastInputActivity=Date.now(); }});

  // Generic loading helper
  function setLoading(btn){
    if(!btn) return ()=>{};
    const oldTxt=btn.textContent; btn.disabled=true; btn.classList.add('loading'); btn.textContent='...';
    return ()=>{ btn.disabled=false; btn.classList.remove('loading'); btn.textContent=oldTxt; };
  }
})();
