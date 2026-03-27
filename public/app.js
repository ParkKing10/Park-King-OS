// ═══════════════════════════════════════════════════════════════════════════
//  Park King OS — App Logic (Offline-First PWA)
// ═══════════════════════════════════════════════════════════════════════════

let authToken=localStorage.getItem('pp_token')||'',currentUser=null,currentCompany=localStorage.getItem('pp_company')||'parkking';
let allBookings=[],allTasks=[],openEditorIdx=-1,printedIds=JSON.parse(localStorage.getItem('pp_printed')||'{}');
let scheduleWeekOffset=0,shiftTemplates=[],allUsers=[];
let isOffline = !navigator.onLine;
let syncInProgress = false;
let currentBookingDate = new Date().toISOString().split('T')[0];

// ─── Service Worker Registration ────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    console.log('[App] SW registered');
    // Listen for SW messages
    navigator.serviceWorker.addEventListener('message', handleSWMessage);
    // Request periodic sync if available
    if ('periodicSync' in reg) {
      reg.periodicSync.register('parkking-refresh', { minInterval: 60 * 60 * 1000 }).catch(() => {});
    }
  }).catch(e => console.warn('[App] SW registration failed:', e));
}

// ─── Online/Offline Detection ───────────────────────────────────────────
window.addEventListener('online', () => { isOffline = false; updateOfflineUI(); autoSync(); });
window.addEventListener('offline', () => { isOffline = true; updateOfflineUI(); });

function updateOfflineUI() {
  const bar = document.getElementById('offlineBar');
  const dot = document.getElementById('connDot');
  if (isOffline) {
    bar.className = 'offline-bar offline show';
    bar.textContent = '📴 Offline-Modus — Änderungen werden beim Verbinden synchronisiert';
    dot.className = 'offline-indicator offline';
  } else {
    dot.className = 'offline-indicator online';
    // Hide bar after a short delay
    bar.className = 'offline-bar synced show';
    bar.textContent = '✓ Wieder online';
    setTimeout(() => { bar.classList.remove('show'); }, 2000);
  }
  updateSyncBadge();
}

async function updateSyncBadge() {
  try {
    const count = await OfflineStore.getQueueLength();
    const btn = document.getElementById('syncBtn');
    const badge = document.getElementById('syncCount');
    if (count > 0) {
      btn.style.display = '';
      badge.textContent = count;
    } else {
      btn.style.display = 'none';
    }
  } catch(e) {}
}

// ─── SW Message Handler ─────────────────────────────────────────────────
function handleSWMessage(event) {
  const data = event.data;
  if (!data) return;
  if (data.type === 'QUEUE_OFFLINE_ACTION') {
    // Queue the failed action
    OfflineStore.queueAction({
      method: data.method,
      url: data.url,
      body: data.body,
      timestamp: data.timestamp,
      description: describeAction(data.method, data.url)
    }).then(() => {
      // Apply change to local cache
      return OfflineStore.applyOfflineAction(data);
    }).then(() => {
      updateSyncBadge();
      showToast('Offline gespeichert ✓');
    });
  }
  if (data.type === 'TRIGGER_SYNC') {
    autoSync();
  }
}

function describeAction(method, url) {
  if (url.includes('/checkin')) return 'Check-in';
  if (url.includes('/checkout')) return 'Check-out';
  if (url.includes('/pay')) return 'Zahlung';
  if (url.includes('/noshow')) return 'No-Show';
  if (url.includes('/key')) return 'Schlüssel';
  if (url.includes('/phone')) return 'Telefonat';
  if (url.includes('/toggle')) return 'Aufgabe';
  if (method === 'PUT' && url.includes('/bookings/')) return 'Buchung bearbeiten';
  if (method === 'POST' && url.includes('/labels')) return 'Label';
  return method + ' ' + url;
}

// ─── Auto Sync ──────────────────────────────────────────────────────────
async function autoSync() {
  if (isOffline || syncInProgress) return;
  const count = await OfflineStore.getQueueLength();
  if (count === 0) return;
  await doSync();
}

async function manualSync() {
  if (isOffline) { showToast('Kein Internet ⚠️'); return; }
  await doSync();
  // Reload current data
  loadBookings(false);
}

async function doSync() {
  if (syncInProgress) return;
  syncInProgress = true;
  const bar = document.getElementById('offlineBar');
  bar.className = 'offline-bar syncing show';
  bar.textContent = '⟳ Synchronisiere...';
  try {
    const result = await OfflineStore.syncAll(authToken);
    syncInProgress = false;
    if (result.synced > 0) {
      bar.className = 'offline-bar synced show';
      bar.textContent = `✓ ${result.synced} Änderung${result.synced > 1 ? 'en' : ''} synchronisiert`;
      showToast(`${result.synced} synchronisiert ✓`);
      setTimeout(() => bar.classList.remove('show'), 2500);
    }
    if (result.failed > 0) {
      bar.className = 'offline-bar offline show';
      bar.textContent = `⚠️ ${result.failed} fehlgeschlagen`;
      setTimeout(() => bar.classList.remove('show'), 4000);
    }
    if (result.synced === 0 && result.failed === 0) {
      bar.classList.remove('show');
    }
  } catch(e) {
    syncInProgress = false;
    bar.classList.remove('show');
  }
  updateSyncBadge();
}

// ─── Offline-Aware Fetch Wrapper ────────────────────────────────────────
async function offlineFetch(url, options = {}) {
  try {
    const response = await fetch(url, options);
    const isOfflineResponse = response.headers.get('X-Offline') === 'true';
    if (isOfflineResponse) {
      // SW returned offline marker — serve from cache
      return { ok: false, _offline: true };
    }
    return response;
  } catch(e) {
    return { ok: false, _offline: true };
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  INIT & AUTH — same as before but with offline support
// ═══════════════════════════════════════════════════════════════════════

if(authToken){initApp();}else{document.getElementById('loginScreen').style.display='flex';}
document.getElementById('loginPass').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
document.getElementById('loginUser').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('loginPass').focus();});

function ah(){return{'Authorization':'Bearer '+authToken,'Content-Type':'application/json'};}

async function doLogin(){
  const u=document.getElementById('loginUser').value.trim(),p=document.getElementById('loginPass').value.trim();
  if(!u||!p)return;
  try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});const d=await r.json();if(d.token){authToken=d.token;currentUser=d.user;localStorage.setItem('pp_token',authToken);initApp();}else showErr(d.error||'Ungültige Zugangsdaten');}catch(e){
    // Try offline login with cached token
    if(authToken){initApp();}else{showErr('Offline — Login nicht möglich');}
  }
}

function doLogout(){authToken='';currentUser=null;localStorage.removeItem('pp_token');document.getElementById('app').classList.remove('active');document.body.classList.remove('is-admin');document.getElementById('loginScreen').style.display='flex';}

async function initApp(){
  document.getElementById('loginScreen').style.display='none';document.getElementById('app').classList.add('active');
  updateOfflineUI();
  try{
    const r=await fetch('/api/auth/me',{headers:ah()});
    if(r.status===401){doLogout();return;}
    const d=await r.json();
    if(d._offline) {
      // Offline — use cached user from localStorage
      const cachedUser = localStorage.getItem('pp_user');
      if(cachedUser) currentUser = JSON.parse(cachedUser);
      if(currentUser && currentUser.role==='admin') document.body.classList.add('is-admin');
    } else {
      currentUser=d.user;
      localStorage.setItem('pp_user', JSON.stringify(currentUser));
      if(currentUser.role==='admin')document.body.classList.add('is-admin');else document.body.classList.remove('is-admin');
    }
  }catch(e){
    // Offline fallback
    const cachedUser = localStorage.getItem('pp_user');
    if(cachedUser) { currentUser = JSON.parse(cachedUser); if(currentUser.role==='admin') document.body.classList.add('is-admin'); }
    else { doLogout(); return; }
  }
  // Preload templates and users
  try{const[tR,uR]=await Promise.all([fetch('/api/shift-templates',{headers:ah()}),fetch('/api/users',{headers:ah()}).catch(()=>({json:async()=>[]}))]);shiftTemplates=await tR.json();try{allUsers=await uR.json();}catch(e){allUsers=[];}}catch(e){}
  selectCompany(currentCompany);
  // Auto sync queued actions
  autoSync();
  updateSyncBadge();
}

function showErr(m){const e=document.getElementById('loginError');e.textContent=m;e.style.display='block';setTimeout(()=>e.style.display='none',3000);}

function switchTab(tab){
  document.querySelectorAll('.tab-page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  if(tab==='bookings'){document.getElementById('tabBookings').classList.add('active');document.getElementById('navBookings').classList.add('active');}
  else if(tab==='gps'){document.getElementById('tabGps').classList.add('active');document.getElementById('navGps').classList.add('active');}
  else if(tab==='tasks'){document.getElementById('tabTasks').classList.add('active');document.getElementById('navTasks').classList.add('active');loadTasks();}
  else if(tab==='schedule'){document.getElementById('tabSchedule').classList.add('active');document.getElementById('navSchedule').classList.add('active');loadSchedule();}
  else if(tab==='damages'){document.getElementById('tabDamages').classList.add('active');document.getElementById('navDamages').classList.add('active');loadDamages();}
  else if(tab==='admin'){document.getElementById('tabAdmin').classList.add('active');document.getElementById('navAdmin').classList.add('active');loadAdminData();}
}

function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function showToast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200);}

// ═══════════════════════════════════════════════════════════════════════
//  BOOKINGS — Offline-First
// ═══════════════════════════════════════════════════════════════════════

function selectCompany(id){currentCompany=id;localStorage.setItem('pp_company',id);document.querySelectorAll('.company-btn').forEach(b=>b.classList.remove('active'));document.getElementById('btn-'+id).classList.add('active');loadBookings(false);}

// ─── Date navigation ─────────────────────────────────────────────────
function updateDatePicker(){
  const picker=document.getElementById('bookingDatePicker');
  if(picker) picker.value=currentBookingDate;
}
function goToday(){
  currentBookingDate=new Date().toISOString().split('T')[0];
  updateDatePicker();
  loadBookings(false);
}
function goToDate(dateStr){
  if(dateStr){currentBookingDate=dateStr;loadBookings(false);}
}
function goDateOffset(offset){
  const d=new Date(currentBookingDate+'T12:00:00');
  d.setDate(d.getDate()+offset);
  currentBookingDate=d.toISOString().split('T')[0];
  updateDatePicker();
  loadBookings(false);
}

async function loadBookings(refresh){
  const list=document.getElementById('bookingList'),ld=document.getElementById('loadingState'),er=document.getElementById('errorState');
  list.innerHTML='';ld.style.display='flex';er.style.display='none';document.getElementById('searchInput').value='';document.getElementById('statusBar').innerHTML='';openEditorIdx=-1;

  const dateStr=currentBookingDate;
  updateDatePicker();
  const today=new Date().toISOString().split('T')[0];

  // Try scrape first if refresh requested and online and looking at today
  if(refresh && !isOffline && dateStr===today){
    try{await fetch('/api/scrape',{method:'POST',headers:ah(),body:JSON.stringify({company:currentCompany})});}catch(e){}
  }

  try{
    const r=await fetch('/api/bookings?company='+currentCompany+'&date='+dateStr,{headers:ah()});

    // Check if offline response from SW
    const isOfflineResp = r.headers && r.headers.get('X-Offline') === 'true';

    if(r.status===401){doLogout();return;}

    if(isOfflineResp) {
      // Serve from IndexedDB cache
      const cached = await OfflineStore.getCachedBookings(currentCompany, dateStr);
      if(cached) {
        allBookings = cached.bookings || [];
        ld.style.display='none';
        const cn=currentCompany==='parkking'?'Biemann':'Hasloh';
        const ins=allBookings.filter(b=>b.type==='in').length,outs=allBookings.filter(b=>b.type==='out').length;
        document.getElementById('statusBar').innerHTML=`<div class="status-chip chip-company">${cn}</div><div class="status-chip chip-blue">${dateStr}</div><div class="status-chip" style="background:var(--orange-bg);color:var(--orange)">📴 Offline</div><div class="status-chip chip-green">▶ ${ins} Annahmen</div>${outs?`<div class="status-chip" style="background:var(--red-bg);color:var(--red)">◀ ${outs} Rückgaben</div>`:''}`;
        if(!allBookings.length){er.textContent='Keine gecachten Buchungen.';er.style.display='block';return;}
        renderBookings(allBookings);
        showToast('Offline-Daten geladen');
        return;
      } else {
        ld.style.display='none';
        er.innerHTML='<div style="margin-bottom:8px">📴 Offline — Keine gecachten Daten</div><div style="font-size:12px;color:var(--text3)">Lade die Buchungen einmal mit Internet,<br>dann funktioniert alles offline.</div>';
        er.style.display='block';
        return;
      }
    }

    const d=await r.json();
    if(d.error)throw new Error(d.error);
    allBookings=d.bookings||[];
    ld.style.display='none';

    // ★ Cache for offline use
    await OfflineStore.cacheBookings(currentCompany, dateStr, d);

    const cn=currentCompany==='parkking'?'Biemann':'Hasloh';
    const ins=allBookings.filter(b=>b.type==='in').length,outs=allBookings.filter(b=>b.type==='out').length;
    const dateLabel=dateStr===today?dateStr:formatDateLabel(dateStr);
    document.getElementById('statusBar').innerHTML=`<div class="status-chip chip-company">${cn}</div><div class="status-chip chip-blue">${dateLabel}</div><div class="status-chip chip-green">▶ ${ins} Annahmen</div>${outs?`<div class="status-chip" style="background:var(--red-bg);color:var(--red)">◀ ${outs} Rückgaben</div>`:''}`;
    if(!allBookings.length){er.textContent='Keine Buchungen für '+dateLabel+'.';er.style.display='block';return;}
    renderBookings(allBookings);showToast(allBookings.length+' Buchungen geladen ✓');
  }catch(e){
    // Network error fallback
    const cached = await OfflineStore.getCachedBookings(currentCompany, dateStr);
    ld.style.display='none';
    if(cached && cached.bookings && cached.bookings.length) {
      allBookings = cached.bookings;
      const cn=currentCompany==='parkking'?'Biemann':'Hasloh';
      const ins=allBookings.filter(b=>b.type==='in').length,outs=allBookings.filter(b=>b.type==='out').length;
      document.getElementById('statusBar').innerHTML=`<div class="status-chip chip-company">${cn}</div><div class="status-chip chip-blue">${dateStr}</div><div class="status-chip" style="background:var(--orange-bg);color:var(--orange)">📴 Cache</div><div class="status-chip chip-green">▶ ${ins}</div>${outs?`<div class="status-chip" style="background:var(--red-bg);color:var(--red)">◀ ${outs}</div>`:''}`;
      renderBookings(allBookings);
      showToast('Offline-Cache geladen');
    } else {
      er.innerHTML=`<div style="margin-bottom:8px">⚠️ ${e.message||'Verbindungsfehler'}</div><button class="btn btn-accent btn-sm" onclick="loadBookings(true)">Nochmal</button>`;
      er.style.display='block';
    }
  }
}

function formatDateLabel(d){const p=d.split('-');return p[2]+'.'+p[1]+'.'+p[0];}

function filterBookings(){const q=document.getElementById('searchInput').value.trim().toLowerCase();const f=q?allBookings.filter(b=>(b.plate||'').toLowerCase().includes(q)||(b.name||'').toLowerCase().includes(q)):allBookings;renderBookings(f);}
function markPrinted(idx){const b=allBookings[idx];if(b&&b.id){printedIds[b.id]=true;localStorage.setItem('pp_printed',JSON.stringify(printedIds));}}

function renderBookings(list){
  const el=document.getElementById('bookingList');if(!list.length){el.innerHTML='<div class="empty">Keine Treffer.</div>';return;}
  const cn=currentCompany==='parkking'?'Biemann':'Hasloh';
  
  // Status Labels für Cards
  const statusLabels = {
    'angerufen_unterwegs': '📞 Unterwegs',
    'wartet_parkplatz': '🅿️ Wartet',
    'gelandet_gepaeck': '✈️ Gelandet',
    'terminal2_sofort': '🚨 T2 Sofort!'
  };
  const statusColors = {
    'angerufen_unterwegs': 'var(--blue)',
    'wartet_parkplatz': 'var(--green)',
    'gelandet_gepaeck': 'var(--orange)',
    'terminal2_sofort': 'var(--red)'
  };
  
  el.innerHTML=list.map((b,i)=>{
    const idx=allBookings.indexOf(b);
    const isIn=b.type==='in';
    const time=b.time_in||b.time_out||'';
    const flight=b.flight_code&&b.flight_code!=='TO BE UPDATED'?b.flight_code:'';
    const printed=printedIds[b.id];
    const checked=b.status==='checked';
    const providerTag=b.provider&&b.provider!=='Park King'?`<span class="bcard-badge provider">${esc(b.provider)}</span>`:'';
    
    // Status-Tags für beide: Check-in UND Check-out
    let statusTags = '';
    if (b.checkin_status && statusLabels[b.checkin_status]) {
      statusTags += `<div class="bcard-status-tag" style="background:${statusColors[b.checkin_status]};color:#fff">${statusLabels[b.checkin_status]}</div>`;
    }
    if (b.checkout_status && statusLabels[b.checkout_status]) {
      statusTags += `<div class="bcard-status-tag" style="background:${statusColors[b.checkout_status]};color:#fff">${statusLabels[b.checkout_status]}</div>`;
    }
    
    return`<div class="bcard type-${isIn?'in':'out'}${checked?' checked':''}" style="animation-delay:${Math.min(i,20)*0.02}s"><div class="bcard-row" onclick="openBookingDetail(${idx})"><div class="bcard-time">${checked?'<div class="bt-checked">✔</div>':''}<div class="bt-icon">🚐</div><div class="bt-time">${esc(time)||'—'}</div>${flight?`<div class="bt-flight">${esc(flight)}</div>`:''}</div><div class="bcard-body"><div class="bcard-top"><span class="bcard-badge pk">${cn}</span>${providerTag}${statusTags}</div><div><span class="bcard-plate">${esc(b.plate)||'—'}</span>${b.external_id?`<span class="bcard-code">#${esc(b.external_id)}</span>`:''}</div><div class="bcard-name">${esc(b.name)||'—'}</div>${b.car?`<div class="bcard-meta">🚗 ${esc(b.car)}</div>`:''}</div><div class="bcard-right">${b.pax?`<div class="bcard-pax">${b.pax} 👥</div>`:''}${printed?'<div class="bcard-printed">🖨</div>':''}${b.price?`<div class="bcard-price">${b.price.toFixed(2)}€</div>`:'<div class="bcard-price">0,00€</div>'}</div></div></div>`;
  }).join('');
}

// ─── Booking Detail View ──────────────────────────────────────────────
let currentDetailIdx = -1;

function openBookingDetail(idx) {
  currentDetailIdx = idx;
  const b = allBookings[idx];
  if (!b) return;

  const overlay = document.getElementById('bookingDetailOverlay');
  const cn = currentCompany === 'parkking' ? 'Biemann' : 'Hasloh';
  const isIn = b.type === 'in';
  const flightIn = b.flight_code && b.flight_code !== 'TO BE UPDATED' ? b.flight_code : '';
  const flightOut = b.flight_out || '';
  const checkedIn = b.checked_in_at;
  const checkedOut = b.checked_out_at;
  const checkinTime = checkedIn ? new Date(checkedIn).toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit'}) : '';
  const checkoutTime = checkedOut ? new Date(checkedOut).toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit'}) : '';
  const isAdmin = currentUser && currentUser.role === 'admin';

  // Status Labels
  const checkinStatusLabels = {
    'angerufen_unterwegs': '📞 Hat angerufen & auf m Weg',
    'wartet_parkplatz': '🅿️ Wartet auf dem Parkplatz'
  };
  const checkoutStatusLabels = {
    'gelandet_gepaeck': '✈️ Gelandet & wartet auf Gepäck',
    'terminal2_sofort': '🚨 Terminal 2 - Sofort abholen!'
  };

  overlay.innerHTML = `
    <div class="bd-header">
      <button class="bd-back" onclick="closeBookingDetail()">‹</button>
      <div class="bd-title">Buchung #${esc(b.external_id || b.uid || '')}</div>
      <div class="bd-actions">
        <button class="bd-action-btn" onclick="openLabelEditor(${idx})">🖨️</button>
      </div>
    </div>

    ${b.external_id ? `<div class="bd-ext-id">Externe ID: ${esc(b.external_id)}</div>` : ''}

    <div class="bd-section">
      <div class="bd-info-grid">
        <div>
          <div class="bd-info-label">Name</div>
          <div class="bd-info-value" style="font-weight:800">${esc(b.name) || '—'}</div>
          ${b.phone ? `<div style="margin-top:4px"><a href="tel:${esc(b.phone)}" style="color:var(--blue);font-size:13px;font-weight:600;text-decoration:none">${esc(b.phone)}</a></div>` : ''}
          ${b.pax ? `<div style="color:var(--accent);font-size:13px;font-weight:600;margin-top:2px">${b.pax} Personen</div>` : ''}
        </div>
        <div>
          <div class="bd-info-label">Auto</div>
          <div class="bd-info-value" style="font-weight:800;font-family:'JetBrains Mono',monospace">${esc(b.plate) || '—'}</div>
          ${b.car ? `<div style="font-size:13px;color:var(--text2);margin-top:2px">${esc(b.car)}</div>` : ''}
        </div>
      </div>
    </div>

    <div class="bd-dates">
      <div class="bd-date-col arrival">
        <div class="bd-date-header">🚗 Parkdatum</div>
        <div class="bd-date-val">${b.date_in ? formatDateNice(b.date_in) : '—'}</div>
        <div class="bd-date-time">${esc(b.time_in) || '—'}</div>
        ${checkedIn ? `
          <div class="bd-checked-info">
            <div style="color:#fff;font-weight:700;font-size:13px">✅ Eingecheckt: ${checkinTime}</div>
          </div>
          ${isAdmin ? `<button class="bd-undo-btn" onclick="undoCheckin(${idx})">↩️ Rückgängig</button>` : ''}
        ` : `
          <button class="bd-check-btn checkin" onclick="doCheckin(${idx})">☐ Check-in</button>
        `}
      </div>
      <div class="bd-date-col departure">
        <div class="bd-date-header">🚗 Datum Retour</div>
        <div class="bd-date-val">${b.date_out ? formatDateNice(b.date_out) : '—'}</div>
        <div class="bd-date-time">${esc(b.time_out) || '—'}</div>
        ${checkedOut ? `
          <div class="bd-checked-info">
            <div style="color:#fff;font-weight:700;font-size:13px">✅ Ausgecheckt: ${checkoutTime}</div>
          </div>
          ${isAdmin ? `<button class="bd-undo-btn" onclick="undoCheckout(${idx})">↩️ Rückgängig</button>` : ''}
        ` : `
          <button class="bd-check-btn checkout" onclick="doCheckout(${idx})">☐ Check-out</button>
        `}
      </div>
    </div>

    <!-- STATUS SECTION - nur 1 Status aktiv -->
    <div class="bd-status-section">
      <div class="bd-status-header">📍 Kunden-Status</div>
      ${(b.checkin_status || b.checkout_status) ? `
        <!-- Ein Status ist aktiv - zeige ihn mit Löschen-Button -->
        <div class="bd-status-active-row">
          ${b.checkin_status ? `
            <div class="bd-status-active ${b.checkin_status}">${checkinStatusLabels[b.checkin_status] || b.checkin_status}</div>
          ` : `
            <div class="bd-status-active ${b.checkout_status}">${checkoutStatusLabels[b.checkout_status] || b.checkout_status}</div>
          `}
          <button class="bd-status-clear-btn" onclick="${b.checkin_status ? `clearCheckinStatus(${idx})` : `clearCheckoutStatus(${idx})`}">✕ Entfernen</button>
        </div>
      ` : `
        <!-- Kein Status aktiv - zeige alle 4 Optionen -->
        <div class="bd-status-all-btns">
          <button class="bd-status-btn" onclick="setCheckinStatus(${idx}, 'angerufen_unterwegs')">📞 Hat angerufen & auf m Weg</button>
          <button class="bd-status-btn" onclick="setCheckinStatus(${idx}, 'wartet_parkplatz')">🅿️ Wartet auf dem Parkplatz</button>
          <button class="bd-status-btn" onclick="setCheckoutStatus(${idx}, 'gelandet_gepaeck')">✈️ Gelandet & wartet auf Gepäck</button>
          <button class="bd-status-btn urgent" onclick="setCheckoutStatus(${idx}, 'terminal2_sofort')">🚨 Terminal 2 - Sofort abholen!</button>
        </div>
      `}
    </div>

    <div class="bd-flight-row">
      <div class="bd-flight-col dep">
        <div>
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;opacity:.7;margin-bottom:2px">✈ Abflug</div>
          <div class="bd-flight-code">${flightIn || 'TO BE UPDATED'}</div>
        </div>
      </div>
      <div class="bd-flight-col arr">
        <div>
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;opacity:.7;margin-bottom:2px">✈ Ankunft</div>
          <div class="bd-flight-code">${flightOut || b.flight_code || '—'}</div>
        </div>
      </div>
    </div>

    ${b.phone ? `
    <div style="margin:0 16px 16px">
      <a href="tel:${esc(b.phone)}" style="display:flex;align-items:center;justify-content:center;gap:8px;padding:14px;background:var(--surface);border:1.5px solid var(--border);border-radius:var(--r);color:var(--blue);font-size:15px;font-weight:700;text-decoration:none;box-shadow:var(--shadow)">📞 ${esc(b.phone)}</a>
    </div>` : ''}

    <!-- Aktivitäts-Log -->
    <div class="bd-log-section">
      <div class="bd-log-header">📋 Aktivitäten</div>
      <div class="bd-log-list" id="bookingLogList">
        <div class="bd-log-loading">Lade...</div>
      </div>
    </div>

    <div style="height:40px"></div>
  `;

  overlay.classList.add('open');
  
  // Lade das Log
  loadBookingLog(b.id);
}

async function loadBookingLog(bookingId) {
  const logList = document.getElementById('bookingLogList');
  try {
    const r = await fetch('/api/bookings/' + bookingId + '/log', { headers: ah() });
    if (!r.ok) throw new Error('Fehler');
    const logs = await r.json();
    
    if (!logs.length) {
      logList.innerHTML = '<div class="bd-log-empty">Keine Aktivitäten</div>';
      return;
    }
    
    const actionLabels = {
      'checked_in': '✅ Eingecheckt',
      'checked_out': '✅ Ausgecheckt',
      'undo_checkin': '↩️ Check-in rückgängig',
      'undo_checkout': '↩️ Check-out rückgängig',
      'label_printed': '🖨️ Label gedruckt',
      'status_changed': '📍 Status geändert',
      'edited': '✏️ Bearbeitet',
      'created': '➕ Erstellt',
      'paid': '💰 Bezahlt',
      'noshow': '❌ No-Show',
      'key_in': '🔑 Schlüssel abgegeben',
      'key_out': '🔑 Schlüssellos',
      'phone_called': '📞 Angerufen'
    };
    
    logList.innerHTML = logs.map(log => {
      const time = log.created_at ? new Date(log.created_at).toLocaleString('de-DE', {
        day: '2-digit', month: '2-digit', year: '2-digit',
        hour: '2-digit', minute: '2-digit'
      }) : '';
      const action = actionLabels[log.action] || log.action;
      const user = log.display_name || 'System';
      let details = '';
      if (log.details) {
        try {
          const d = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
          if (d.status) details = ` (${d.status})`;
          if (d.checkin_status) details = ` → ${d.checkin_status}`;
          if (d.checkout_status) details = ` → ${d.checkout_status}`;
        } catch {}
      }
      return `<div class="bd-log-item">
        <div class="bd-log-action">${action}${details}</div>
        <div class="bd-log-meta">${user} · ${time}</div>
      </div>`;
    }).join('');
  } catch (e) {
    logList.innerHTML = '<div class="bd-log-empty">Log nicht verfügbar</div>';
  }
}

function closeBookingDetail() {
  document.getElementById('bookingDetailOverlay').classList.remove('open');
  currentDetailIdx = -1;
}

function formatDateNice(d) {
  if (!d) return '—';
  try {
    let dateStr = String(d).trim();
    // Handle DD.MM.YYYY or DD.MM.YYYY HH:MM format
    const dotParts = dateStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (dotParts) {
      dateStr = `${dotParts[3]}-${dotParts[2].padStart(2,'0')}-${dotParts[1].padStart(2,'0')}`;
    }
    // Handle YYYY-MM-DD (may have time appended)
    const isoParts = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!isoParts) return d;
    const date = new Date(parseInt(isoParts[1]), parseInt(isoParts[2]) - 1, parseInt(isoParts[3]));
    if (isNaN(date.getTime())) return d;
    const days = ['So','Mo','Di','Mi','Do','Fr','Sa'];
    const months = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
    return `${days[date.getDay()]}. ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
  } catch { return d; }
}

// ─── Direct Check-in/Check-out (ohne Modal) ────────────────────────────
async function doCheckin(idx) {
  const b = allBookings[idx];
  if (!b || !b.id) return;
  try {
    await fetch('/api/bookings/' + b.id + '/checkin', { method: 'POST', headers: ah(), body: JSON.stringify({}) });
    b.checked_in_at = new Date().toISOString();
    b.status = 'checked';
    showToast('Check-in erfolgreich ✓');
    openBookingDetail(idx);
    filterBookings();
  } catch (e) { showToast('Fehler ⚠️'); }
}

async function doCheckout(idx) {
  const b = allBookings[idx];
  if (!b || !b.id) return;
  try {
    await fetch('/api/bookings/' + b.id + '/checkout', { method: 'POST', headers: ah(), body: JSON.stringify({}) });
    b.checked_out_at = new Date().toISOString();
    b.status = 'checked';
    showToast('Check-out erfolgreich ✓');
    openBookingDetail(idx);
    filterBookings();
  } catch (e) { showToast('Fehler ⚠️'); }
}

// ─── Status setzen (separat von Check-in/out) ──────────────────────────
// Nur 1 Status kann aktiv sein - beim Setzen wird der andere gelöscht
async function setCheckinStatus(idx, status) {
  const b = allBookings[idx];
  if (!b || !b.id) return;
  try {
    // Setze checkin_status UND lösche checkout_status
    await fetch('/api/bookings/' + b.id + '/status', { method: 'PUT', headers: ah(), body: JSON.stringify({ checkin_status: status, checkout_status: null }) });
    b.checkin_status = status;
    b.checkout_status = null;
    showToast('Status gesetzt ✓');
    openBookingDetail(idx);
    filterBookings();
  } catch (e) { showToast('Fehler ⚠️'); }
}

async function setCheckoutStatus(idx, status) {
  const b = allBookings[idx];
  if (!b || !b.id) return;
  try {
    // Setze checkout_status UND lösche checkin_status
    await fetch('/api/bookings/' + b.id + '/status', { method: 'PUT', headers: ah(), body: JSON.stringify({ checkout_status: status, checkin_status: null }) });
    b.checkout_status = status;
    b.checkin_status = null;
    showToast('Status gesetzt ✓');
    openBookingDetail(idx);
    filterBookings();
  } catch (e) { showToast('Fehler ⚠️'); }
}

async function clearCheckinStatus(idx) {
  const b = allBookings[idx];
  if (!b || !b.id) return;
  try {
    await fetch('/api/bookings/' + b.id + '/status', { method: 'PUT', headers: ah(), body: JSON.stringify({ checkin_status: null }) });
    b.checkin_status = null;
    showToast('Status entfernt ✓');
    openBookingDetail(idx);
    filterBookings();
  } catch (e) { showToast('Fehler ⚠️'); }
}

async function clearCheckoutStatus(idx) {
  const b = allBookings[idx];
  if (!b || !b.id) return;
  try {
    await fetch('/api/bookings/' + b.id + '/status', { method: 'PUT', headers: ah(), body: JSON.stringify({ checkout_status: null }) });
    b.checkout_status = null;
    showToast('Status entfernt ✓');
    openBookingDetail(idx);
    filterBookings();
  } catch (e) { showToast('Fehler ⚠️'); }
}

async function undoCheckin(idx) {
  const b = allBookings[idx];
  if (!b || !b.id) return;
  if (!confirm('Check-in rückgängig machen?')) return;
  try {
    await fetch('/api/bookings/' + b.id + '/checkin', { method: 'DELETE', headers: ah() });
    b.checked_in_at = null;
    b.checkin_status = null;
    b.status = b.checked_out_at ? 'checked' : 'new';
    showToast('Check-in rückgängig ✓');
    openBookingDetail(idx);
    filterBookings();
  } catch (e) { showToast('Fehler ⚠️'); }
}

async function undoCheckout(idx) {
  const b = allBookings[idx];
  if (!b || !b.id) return;
  if (!confirm('Check-out rückgängig machen?')) return;
  try {
    await fetch('/api/bookings/' + b.id + '/checkout', { method: 'DELETE', headers: ah() });
    b.checked_out_at = null;
    b.checkout_status = null;
    b.status = b.checked_in_at ? 'checked' : 'new';
    showToast('Check-out rückgängig ✓');
    openBookingDetail(idx);
    filterBookings();
  } catch (e) { showToast('Fehler ⚠️'); }
}

// ─── Label Editor (opens as modal from detail view) ───────────────────
function openLabelEditor(idx) {
  const b = allBookings[idx];
  if (!b) return;
  const cn = currentCompany === 'parkking' ? 'Biemann' : 'Hasloh';
  const content = document.getElementById('modalContent');
  content.innerHTML = `
    <div class="modal-title">🖨️ Label drucken <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="ed-row"><div class="ed-col"><div class="ed-label">Kundenname</div><input class="ed-input" id="en-${idx}" value="${esc(b.name)}" oninput="rl(${idx})"></div></div>
    <div class="ed-row"><div class="ed-col"><div class="ed-label">Rückgabe Datum</div><input class="ed-input" id="ed-${idx}" value="${esc(b.date_out)}" oninput="rl(${idx})"></div><div class="ed-col"><div class="ed-label">Uhrzeit</div><input class="ed-input" id="et-${idx}" value="${esc(b.time_out)}" oninput="rl(${idx})"></div></div>
    <div class="ed-row"><div class="ed-col"><div class="ed-label">Fahrzeug</div><input class="ed-input" id="ec-${idx}" value="${esc(b.car)}" oninput="rl(${idx})"></div><div class="ed-col"><div class="ed-label">Kennzeichen</div><input class="ed-input plate" id="ep-${idx}" value="${esc(b.plate)}" oninput="this.value=this.value.toUpperCase();rl(${idx})"></div></div>
    <div class="ed-row"><div class="ed-col"><div class="ed-label">Stellplatz (optional)</div><input class="ed-input" id="es-${idx}" placeholder="z.B. Straße rechts, Reihe 3..." oninput="rl(${idx})"></div></div>
    <div class="label-preview"><canvas id="cv-${idx}"></canvas></div>
    <div class="ed-btns">
      <button class="btn btn-accent btn-sm" onclick="printL(${idx})">🖨 Drucken</button>
      <button class="btn btn-white btn-sm" onclick="downloadL(${idx})">📲 Speichern</button>
      <button class="btn btn-outline btn-sm" onclick="shareL(${idx})">↗ Teilen</button>
      <button class="btn btn-ghost btn-sm" onclick="saveLabelEdits(${idx})">✓ Fertig</button>
    </div>`;
  document.getElementById('modalOverlay').classList.add('open');
  setTimeout(() => rl(idx), 100);
}

async function saveLabelEdits(idx) {
  const b = allBookings[idx];
  if (b && b.id) {
    const u = {
      name: document.getElementById('en-' + idx).value.trim(),
      plate: document.getElementById('ep-' + idx).value.trim().toUpperCase(),
      car: document.getElementById('ec-' + idx).value.trim(),
      date_out: document.getElementById('ed-' + idx).value.trim(),
      time_out: document.getElementById('et-' + idx).value.trim()
    };
    try {
      await fetch('/api/bookings/' + b.id, { method: 'PUT', headers: ah(), body: JSON.stringify(u) });
      Object.assign(allBookings[idx], u);
    } catch (e) {
      await OfflineStore.queueAction({ method: 'PUT', url: '/api/bookings/' + b.id, body: JSON.stringify(u), timestamp: Date.now(), description: 'Buchung bearbeiten' });
      Object.assign(allBookings[idx], u, { _offlineEdited: true });
      showToast('Offline gespeichert ✓');
    }
  }
  closeModal();
  if (currentDetailIdx === idx) openBookingDetail(idx);
  filterBookings();
}

// ─── Label rendering (unchanged, works 100% offline) ────────────────────
function rl(idx){const name=(document.getElementById('en-'+idx)?.value||'').trim(),retDate=(document.getElementById('ed-'+idx)?.value||'').trim(),retTime=(document.getElementById('et-'+idx)?.value||'').trim(),car=(document.getElementById('ec-'+idx)?.value||'').trim(),plate=(document.getElementById('ep-'+idx)?.value||'').trim().toUpperCase(),spot=(document.getElementById('es-'+idx)?.value||'').trim(),cn=currentCompany==='parkking'?'Biemann':'Hasloh';
const W=673,H=378,cv=document.getElementById('cv-'+idx);if(!cv)return;
cv.width=W;cv.height=H;cv.style.width='100%';cv.style.maxWidth='300px';cv.style.height='auto';
const c=cv.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,W,H);c.fillStyle='#000';c.textAlign='center';
let f1=32;c.font=`700 ${f1}px "Helvetica Neue",Arial,sans-serif`;while(c.measureText(name||'—').width>W-10&&f1>14){f1-=2;c.font=`700 ${f1}px "Helvetica Neue",Arial,sans-serif`;}
let fp=44;c.font=`900 ${fp}px "JetBrains Mono",monospace`;while(c.measureText(plate||'—').width>W-10&&fp>20){fp-=2;c.font=`900 ${fp}px "JetBrains Mono",monospace`;}
let f2=96;c.font=`900 ${f2}px "Helvetica Neue",Arial,sans-serif`;while(c.measureText(retDate||'—').width>W-8&&f2>40){f2-=4;c.font=`900 ${f2}px "Helvetica Neue",Arial,sans-serif`;}
let f3=76;c.font=`900 ${f3}px "Helvetica Neue",Arial,sans-serif`;while(c.measureText(retTime||'—').width>W-8&&f3>30){f3-=4;c.font=`900 ${f3}px "Helvetica Neue",Arial,sans-serif`;}
let fs=spot?24:0;if(spot){c.font=`800 ${fs}px "Helvetica Neue",Arial,sans-serif`;while(c.measureText(spot).width>W-10&&fs>12){fs-=2;c.font=`800 ${fs}px "Helvetica Neue",Arial,sans-serif`;}}
let fb=28;const botLine=cn+(car?' · '+car:'');c.font=`800 ${fb}px "Helvetica Neue",Arial,sans-serif`;while(c.measureText(botLine).width>W-10&&fb>12){fb-=2;c.font=`800 ${fb}px "Helvetica Neue",Arial,sans-serif`;}
const gap=2;const totalH=f1+gap+fp+gap+f2+gap+f3+(spot?gap+fs:0)+gap+fb;
let y=Math.max(4,Math.floor((H-totalH)/2));
c.textBaseline='top';
c.font=`700 ${f1}px "Helvetica Neue",Arial,sans-serif`;c.fillText(name||'—',W/2,y);y+=f1+gap;
c.font=`900 ${fp}px "JetBrains Mono",monospace`;c.fillText(plate||'—',W/2,y);y+=fp+gap;
c.font=`900 ${f2}px "Helvetica Neue",Arial,sans-serif`;c.fillText(retDate||'—',W/2,y);y+=f2+gap;
c.font=`900 ${f3}px "Helvetica Neue",Arial,sans-serif`;c.fillText(retTime||'—',W/2,y);y+=f3+gap;
if(spot){c.font=`800 ${fs}px "Helvetica Neue",Arial,sans-serif`;c.fillText(spot,W/2,y);y+=fs+gap;}
c.fillStyle='#333';c.font=`800 ${fb}px "Helvetica Neue",Arial,sans-serif`;c.fillText(botLine,W/2,y);
c.textAlign='left';}

function gc(i){return document.getElementById('cv-'+i);}

// ─── Print / Download / Share (100% offline — canvas-based) ─────────────
function printL(i){const cv=gc(i);if(!cv)return;markPrinted(i);filterBookings();
const rc=document.createElement('canvas');rc.width=cv.height;rc.height=cv.width;const rx=rc.getContext('2d');rx.translate(rc.width/2,rc.height/2);rx.rotate(Math.PI/2);rx.drawImage(cv,-cv.width/2,-cv.height/2);
rc.toBlob(blob=>{
  const url=URL.createObjectURL(blob);const a=document.createElement('a');
  const p=(document.getElementById('ep-'+i)?.value||'label').trim().toUpperCase().replace(/[\s\.]/g,'-');
  a.download=`label-${p}.png`;a.href=url;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
  // Also save to IndexedDB for offline label history
  OfflineStore.saveLabel(allBookings[i]?.id, p, rc.toDataURL('image/png')).catch(()=>{});
  // Log label print
  const b = allBookings[i];
  if (b && b.id) {
    fetch('/api/bookings/' + b.id + '/log-action', { 
      method: 'POST', 
      headers: ah(), 
      body: JSON.stringify({ action: 'label_printed' }) 
    }).catch(() => {});
  }
  showToast('Label gespeichert → aus Fotos drucken ✓');
},'image/png');}

function downloadL(i){const cv=gc(i);if(!cv)return;
const rc=document.createElement('canvas');rc.width=cv.height;rc.height=cv.width;const rx=rc.getContext('2d');rx.translate(rc.width/2,rc.height/2);rx.rotate(Math.PI/2);rx.drawImage(cv,-cv.width/2,-cv.height/2);
const p=(document.getElementById('ep-'+i)?.value||'label').trim().toUpperCase().replace(/[\s\.]/g,'-');const a=document.createElement('a');a.download=`label-${p}.png`;a.href=rc.toDataURL('image/png');a.click();showToast('Gespeichert ✓');}

async function shareL(i){const cv=gc(i);if(!cv)return;try{
const rc=document.createElement('canvas');rc.width=cv.height;rc.height=cv.width;const rx=rc.getContext('2d');rx.translate(rc.width/2,rc.height/2);rx.rotate(Math.PI/2);rx.drawImage(cv,-cv.width/2,-cv.height/2);
const b=await new Promise(r=>rc.toBlob(r,'image/png'));const f=new File([b],'label.png',{type:'image/png'});if(navigator.canShare?.({files:[f]})){await navigator.share({files:[f],title:'Label'});}else{downloadL(i);}}catch(e){downloadL(i);}}

// ═══════════════════════════════════════════════════════════════════════
//  TASKS — Offline-First
// ═══════════════════════════════════════════════════════════════════════

async function loadTasks(){
  const today=new Date().toISOString().split('T')[0];
  document.getElementById('tasksDate').textContent=new Date().toLocaleDateString('de-DE',{weekday:'long',day:'numeric',month:'long'});
  document.getElementById('taskLoading').style.display='flex';document.getElementById('taskList').innerHTML='';
  try{
    const r=await fetch('/api/tasks?date='+today,{headers:ah()});
    if(r.status===401){doLogout();return;}
    const isOfflineResp = r.headers && r.headers.get('X-Offline') === 'true';
    if(isOfflineResp) {
      const cached = await OfflineStore.getCachedTasks(today);
      document.getElementById('taskLoading').style.display='none';
      if(cached) { allTasks = cached.tasks || []; renderTasks(); }
      else { document.getElementById('taskList').innerHTML='<div class="task-empty">📴 Offline — keine gecachten Aufgaben</div>'; }
      return;
    }
    const d=await r.json();allTasks=d.tasks||[];
    await OfflineStore.cacheTasks(today, allTasks);
    document.getElementById('taskLoading').style.display='none';renderTasks();
  }catch(e){
    const cached = await OfflineStore.getCachedTasks(today);
    document.getElementById('taskLoading').style.display='none';
    if(cached) { allTasks = cached.tasks || []; renderTasks(); showToast('Offline-Cache geladen'); }
    else { document.getElementById('taskList').innerHTML='<div class="task-empty">⚠️ Fehler beim Laden</div>'; }
  }
}

function renderTasks(){
  const el=document.getElementById('taskList'),prog=document.getElementById('tasksProgress');
  if(!allTasks.length){el.innerHTML='<div class="task-empty">Keine Aufgaben definiert.<br>Ein Admin kann Aufgaben im Admin-Panel anlegen.</div>';prog.style.display='none';return;}
  const done=allTasks.filter(t=>t.completed_by_id).length,total=allTasks.length,pct=Math.round((done/total)*100);
  prog.style.display='flex';document.getElementById('progressFill').style.width=pct+'%';document.getElementById('progressText').textContent=`${done}/${total}`;
  el.innerHTML=allTasks.map((t,i)=>{const isDone=!!t.completed_by_id;return`<div class="task-card ${isDone?'done':''}" style="animation-delay:${i*0.04+0.05}s" onclick="toggleTask(${t.id})"><div class="task-check">${isDone?'✓':''}</div><div class="task-info"><div class="task-title">${esc(t.title)}</div>${t.description?`<div class="task-desc">${esc(t.description)}</div>`:''}${isDone?`<div class="task-meta">✓ ${esc(t.completed_by_name)} · ${formatTime(t.completed_at)}</div>`:''}</div></div>`;}).join('');
}

async function toggleTask(taskId){
  try{
    const r=await fetch('/api/tasks/'+taskId+'/toggle',{method:'POST',headers:ah()});
    const isOfflineResp = r.headers && r.headers.get('X-Offline') === 'true';
    if(isOfflineResp) {
      // Already queued by SW, update local
      await OfflineStore.applyOfflineAction({ method:'POST', url:'/api/tasks/'+taskId+'/toggle', body:'{}' });
      const today=new Date().toISOString().split('T')[0];
      const cached = await OfflineStore.getCachedTasks(today);
      if(cached) { allTasks = cached.tasks; }
      showToast('Offline gespeichert ✓');
      renderTasks();
      updateSyncBadge();
      return;
    }
    const d=await r.json();showToast(d.message);loadTasks();
  }catch(e){
    // Manual offline queue
    await OfflineStore.queueAction({ method:'POST', url:'/api/tasks/'+taskId+'/toggle', body:'{}', timestamp:Date.now(), description:'Aufgabe' });
    await OfflineStore.applyOfflineAction({ method:'POST', url:'/api/tasks/'+taskId+'/toggle', body:'{}' });
    const today=new Date().toISOString().split('T')[0];
    const cached = await OfflineStore.getCachedTasks(today);
    if(cached) { allTasks = cached.tasks; }
    showToast('Offline gespeichert ✓');
    renderTasks();
    updateSyncBadge();
  }
}
function formatTime(dt){if(!dt)return'';try{const d=new Date(dt+'Z');return d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});}catch{return'';}}

// ═══════════════════════════════════════════════════════════════════════
//  SCHEDULE — mostly online, cache for read
// ═══════════════════════════════════════════════════════════════════════

function getWeekDates(offset){
  const now=new Date();now.setDate(now.getDate()+offset*7);
  const day=now.getDay();const mondayOffset=day===0?-6:1-day;
  const mon=new Date(now);mon.setDate(now.getDate()+mondayOffset);
  const days=[];for(let i=0;i<7;i++){const d=new Date(mon);d.setDate(mon.getDate()+i);days.push(d);}
  return days;
}

const DAY_NAMES=['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'];

function getKW(date){const d=new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate()));const dayNum=d.getUTCDay()||7;d.setUTCDate(d.getUTCDate()+4-dayNum);const yearStart=new Date(Date.UTC(d.getUTCFullYear(),0,1));return Math.ceil(((d-yearStart)/86400000+1)/7);}

async function loadSchedule(){
  const days=getWeekDates(scheduleWeekOffset);const weekStart=days[0].toISOString().split('T')[0];
  const kw=getKW(days[0]);
  document.getElementById('weekLabel').innerHTML=`KW ${kw}<span>${days[0].toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'})} – ${days[6].toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'})}</span>`;
  document.getElementById('scheduleLoading').style.display='flex';document.getElementById('scheduleGrid').innerHTML='';document.getElementById('hoursSummary').style.display='none';
  
  const cacheKey = '/api/shifts?date=' + weekStart;
  
  try{
    const r=await fetch(cacheKey,{headers:ah()});
    if(r.status===401){doLogout();return;}
    const isOfflineResp = r.headers && r.headers.get('X-Offline') === 'true';
    let data;
    if(isOfflineResp) {
      const cached = await OfflineStore.getCachedApiResponse(cacheKey);
      if(cached) { data = cached.data; }
      else { document.getElementById('scheduleLoading').style.display='none'; document.getElementById('scheduleGrid').innerHTML='<div class="task-empty">📴 Offline — kein Cache</div>'; return; }
    } else {
      data=await r.json();
      await OfflineStore.cacheApiResponse(cacheKey, data);
    }
    document.getElementById('scheduleLoading').style.display='none';
    renderSchedule(days, data);
  }catch(e){
    const cached = await OfflineStore.getCachedApiResponse(cacheKey);
    document.getElementById('scheduleLoading').style.display='none';
    if(cached) { renderSchedule(days, cached.data); }
    else { document.getElementById('scheduleGrid').innerHTML='<div class="task-empty">⚠️ Fehler beim Laden</div>'; }
  }
}

function renderSchedule(days, data) {
  const today=new Date().toISOString().split('T')[0];const isAdmin=currentUser&&currentUser.role==='admin';
  const grid=document.getElementById('scheduleGrid');
  
  // Finde meine Schicht heute
  const myShiftToday = (data.shifts||[]).find(s => s.date === today && s.user_id === currentUser?.id);
  renderMyShiftToday(myShiftToday);
  
  grid.innerHTML=days.map((day,di)=>{
    const dateStr=day.toISOString().split('T')[0];const isToday=dateStr===today;
    const dayShifts=(data.shifts||[]).filter(s=>s.date===dateStr);
    return`<div class="day-row"><div class="day-header ${isToday?'today':''}"><span class="day-name">${DAY_NAMES[di]}</span><span class="day-date">${day.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'})}</span></div><div class="day-shifts">${dayShifts.length?dayShifts.map(s=>{
      const color=s.template_color||'#CC6CE7';const hrs=calcHours(s.start_time,s.end_time,s.break_min);
      const checkedIn = s.actual_start ? `<span style="font-size:10px;opacity:0.7"> ✓${s.actual_start}</span>` : '';
      const checkedOut = s.actual_end ? `<span style="font-size:10px;opacity:0.7"> →${s.actual_end}</span>` : '';
      const lateTag = s.was_late ? `<span style="font-size:9px;background:#dc2626;color:#fff;padding:1px 4px;border-radius:3px;margin-left:4px">⚠️ Verspätet</span>` : '';
      return`<div class="shift-pill" style="background:${color}20;color:${color};border-left:3px solid ${color}"><span class="shift-time">${s.start_time}–${s.end_time}${checkedIn}${checkedOut}</span><span class="shift-user">${esc(s.user_name)}${lateTag}</span><span class="shift-hours">${hrs.toFixed(1)}h</span>${isAdmin?`<button class="shift-del" onclick="event.stopPropagation();deleteShift(${s.id})">✕</button>`:''}</div>`;
    }).join(''):'<div class="day-empty">Keine Schichten</div>'}${isAdmin?`<button class="day-add" onclick="openModal('addShift',{date:'${dateStr}',dayName:'${DAY_NAMES[di]} ${day.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'})}'})">+ Schicht</button>`:''}</div></div>`;
  }).join('');
  if(data.hoursByUser&&Object.keys(data.hoursByUser).length){
    document.getElementById('hoursSummary').style.display='block';
    document.getElementById('hoursRows').innerHTML=Object.values(data.hoursByUser).sort((a,b)=>b.hours-a.hours).map(u=>`<div class="hours-row"><span class="hours-user">${esc(u.name)} <span style="font-size:11px;color:var(--text3);font-weight:400">(${u.shifts} Schichten)</span></span><span class="hours-val">${u.hours.toFixed(1)} Std</span></div>`).join('');
  }
}

// ─── Meine Schicht Heute Rendern ──────────────────────────────────────────
function renderMyShiftToday(shift) {
  const box = document.getElementById('myShiftToday');
  if (!shift) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'block';
  const info = document.getElementById('myShiftInfo');
  const actions = document.getElementById('myShiftActions');
  
  const now = new Date();
  const nowTime = now.toTimeString().slice(0, 5);
  const [startH, startM] = shift.start_time.split(':').map(Number);
  const scheduledStart = new Date(now); scheduledStart.setHours(startH, startM, 0, 0);
  const isLate = now > scheduledStart && !shift.actual_start;
  const minutesLate = Math.floor((now - scheduledStart) / 60000);
  
  info.innerHTML = `
    <div class="my-shift-time">${shift.start_time} – ${shift.end_time}</div>
    <div class="my-shift-status">
      ${shift.actual_start ? `✅ Eingecheckt: ${shift.actual_start}` : ''}
      ${shift.actual_end ? ` · Ausgecheckt: ${shift.actual_end}` : ''}
      ${shift.was_late ? ` · ⚠️ Verspätet` : ''}
    </div>
  `;
  
  if (shift.actual_start && shift.actual_end) {
    // Schicht beendet
    actions.innerHTML = `<div class="shift-checked-in">✅ Schicht beendet</div>`;
  } else if (shift.actual_start) {
    // Eingecheckt, noch nicht ausgecheckt
    actions.innerHTML = `<button class="shift-checkin-btn end" onclick="shiftCheckout(${shift.id})">🏁 Schicht beenden</button>`;
  } else {
    // Noch nicht eingecheckt
    let warningHtml = '';
    if (isLate) {
      warningHtml = `
        <div class="shift-late-warning">
          <div class="warning-title">⚠️ Du bist ${minutesLate} Minuten zu spät!</div>
          <div>Pünktlichkeit ist wichtig. Deine Startzeit wird auf ${nowTime} korrigiert.</div>
          <div class="warning-quote">„Bester Beweis einer guten Erziehung ist die Pünktlichkeit."</div>
        </div>
      `;
    }
    actions.innerHTML = `
      ${warningHtml}
      <button class="shift-checkin-btn start" onclick="shiftCheckin(${shift.id}, ${isLate})">▶️ Schicht starten</button>
    `;
  }
}

// ─── GPS Standort Check ────────────────────────────────────────────────────
const WORK_LOCATION = { lat: 53.6847, lng: 9.8908 }; // Klövesteen 21, 25474 Hasloh
const MAX_DISTANCE_METERS = 200; // 200m Toleranz

function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Erdradius in Metern
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

async function checkLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('GPS nicht verfügbar'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const dist = getDistanceFromLatLonInMeters(
          pos.coords.latitude, pos.coords.longitude,
          WORK_LOCATION.lat, WORK_LOCATION.lng
        );
        if (dist <= MAX_DISTANCE_METERS) {
          resolve({ ok: true, distance: dist });
        } else {
          resolve({ ok: false, distance: dist });
        }
      },
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

// ─── Schicht Check-in/out ─────────────────────────────────────────────────
async function shiftCheckin(shiftId, isLate) {
  try {
    // GPS Check
    showToast('📍 Standort wird geprüft...');
    const loc = await checkLocation();
    if (!loc.ok) {
      alert(`❌ Du bist nicht am Arbeitsort!\n\nDu bist ${Math.round(loc.distance)}m entfernt.\nCheck-in nur möglich bei: Klövesteen 21, 25474 Hasloh`);
      return;
    }
    
    const r = await fetch('/api/shifts/' + shiftId + '/checkin', { 
      method: 'POST', 
      headers: ah(), 
      body: JSON.stringify({ is_late: isLate }) 
    });
    const data = await r.json();
    if (data.error) {
      showToast(data.error + ' ⚠️');
      return;
    }
    showToast('✅ Schicht gestartet');
    loadSchedule();
  } catch (e) {
    if (e.message.includes('GPS') || e.code === 1) {
      alert('❌ GPS-Zugriff verweigert!\n\nBitte erlaube den Standortzugriff um einzuchecken.');
    } else {
      showToast('Fehler: ' + e.message + ' ⚠️');
    }
  }
}

async function shiftCheckout(shiftId) {
  try {
    // GPS Check
    showToast('📍 Standort wird geprüft...');
    const loc = await checkLocation();
    if (!loc.ok) {
      alert(`❌ Du bist nicht am Arbeitsort!\n\nDu bist ${Math.round(loc.distance)}m entfernt.\nCheck-out nur möglich bei: Klövesteen 21, 25474 Hasloh`);
      return;
    }
    
    const r = await fetch('/api/shifts/' + shiftId + '/checkout', { 
      method: 'POST', 
      headers: ah() 
    });
    const data = await r.json();
    if (data.error) {
      showToast(data.error + ' ⚠️');
      return;
    }
    showToast('✅ Schicht beendet');
    loadSchedule();
  } catch (e) {
    if (e.message.includes('GPS') || e.code === 1) {
      alert('❌ GPS-Zugriff verweigert!\n\nBitte erlaube den Standortzugriff um auszuchecken.');
    } else {
      showToast('Fehler: ' + e.message + ' ⚠️');
    }
  }
}

function changeWeek(dir){scheduleWeekOffset+=dir;loadSchedule();}
function calcHours(s,e,brk){const[sh,sm]=s.split(':').map(Number),[eh,em]=e.split(':').map(Number);let st=sh*60+sm,en=eh*60+em;if(en<=st)en+=1440;return Math.max(0,(en-st-(brk||0))/60);}
async function deleteShift(id){if(!confirm('Schicht löschen?'))return;try{await fetch('/api/shifts/'+id,{method:'DELETE',headers:ah()});showToast('Schicht gelöscht ✓');loadSchedule();}catch(e){showToast('Fehler ⚠️');}}

// ═══════════════════════════════════════════════════════════════════════
//  ADMIN (online-only, with cache fallback for reads)
// ═══════════════════════════════════════════════════════════════════════

async function loadAdminData(){await Promise.all([loadUsers(),loadAdminTasks(),loadAdminTemplates(),loadMonthlyHours()]);}

async function loadUsers(){try{const r=await fetch('/api/users',{headers:ah()});if(r.status===403)return;allUsers=await r.json();renderUsers(allUsers);}catch(e){}}

function renderUsers(users){
  document.getElementById('userList').innerHTML=users.map(u=>{const initials=(u.display_name||u.username).split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);const roleCls=u.role==='admin'?'role-admin':'role-staff';const roleLabel=u.role==='admin'?'Admin':'Mitarbeiter';
  return`<div class="admin-card" ${!u.active?'style="opacity:0.5"':''}><div class="admin-card-row"><div class="admin-avatar">${initials}</div><div class="admin-card-info"><div class="admin-card-name">${esc(u.display_name)} ${!u.active?'<span class="role-badge role-inactive">Inaktiv</span>':''}</div><div class="admin-card-sub">@${esc(u.username)} · <span class="role-badge ${roleCls}">${roleLabel}</span></div></div></div>${currentUser&&u.id!==currentUser.id?`<div class="admin-actions"><button class="btn btn-white btn-xs" onclick="openEditUser(${u.id},${JSON.stringify(u.display_name).replace(/"/g,'&quot;')},${JSON.stringify(u.role).replace(/"/g,'&quot;')},${u.active})">Bearbeiten</button>${u.active?`<button class="btn btn-xs" style="background:var(--red-bg);color:var(--red);border:none" onclick="deactivateUser(${u.id},${JSON.stringify(u.display_name).replace(/"/g,'&quot;')})">Deaktivieren</button>`:`<button class="btn btn-xs" style="background:var(--green-bg);color:var(--green);border:none" onclick="reactivateUser(${u.id})">Aktivieren</button>`}</div>`:''}</div>`;}).join('');
}

async function loadAdminTasks(){try{const r=await fetch('/api/tasks',{headers:ah()});const d=await r.json();renderAdminTasks(d.tasks||[]);}catch(e){}}
function renderAdminTasks(tasks){if(!tasks.length){document.getElementById('adminTaskList').innerHTML='<div class="task-empty">Noch keine Aufgaben.</div>';return;}document.getElementById('adminTaskList').innerHTML=tasks.map(t=>`<div class="admin-card"><div class="admin-card-row"><div class="admin-avatar" style="background:var(--orange-bg);color:var(--orange)">📋</div><div class="admin-card-info"><div class="admin-card-name">${esc(t.title)}</div>${t.description?`<div class="admin-card-sub">${esc(t.description)}</div>`:''}</div></div><div class="admin-actions"><button class="btn btn-white btn-xs" onclick="openEditTask(${t.id},${JSON.stringify(t.title).replace(/"/g,'&quot;')},${JSON.stringify(t.description||'').replace(/"/g,'&quot;')})">Bearbeiten</button><button class="btn btn-xs" style="background:var(--red-bg);color:var(--red);border:none" onclick="deleteTask(${t.id},${JSON.stringify(t.title).replace(/"/g,'&quot;')})">Entfernen</button></div></div>`).join('');}

async function loadAdminTemplates(){try{const r=await fetch('/api/shift-templates',{headers:ah()});shiftTemplates=await r.json();renderAdminTemplates();}catch(e){}}
function renderAdminTemplates(){if(!shiftTemplates.length){document.getElementById('adminTemplateList').innerHTML='<div class="task-empty">Keine Vorlagen.</div>';return;}document.getElementById('adminTemplateList').innerHTML=shiftTemplates.map(t=>`<div class="admin-card"><div class="admin-card-row"><div class="admin-avatar" style="background:${t.color}20;color:${t.color}">🕐</div><div class="admin-card-info"><div class="admin-card-name">${esc(t.name)}</div><div class="admin-card-sub">${t.start_time} – ${t.end_time} · ${calcHours(t.start_time,t.end_time,0).toFixed(1)} Std</div></div></div><div class="admin-actions"><button class="btn btn-xs" style="background:var(--red-bg);color:var(--red);border:none" onclick="deleteTemplate(${t.id})">Entfernen</button></div></div>`).join('');}

async function loadMonthlyHours(){
  const month=new Date().toISOString().slice(0,7);
  try{const r=await fetch('/api/shifts/hours?month='+month,{headers:ah()});const d=await r.json();const entries=Object.values(d.summary||{});
  if(!entries.length){document.getElementById('monthlyHours').innerHTML='<div class="task-empty">Keine Daten für diesen Monat.</div>';return;}
  document.getElementById('monthlyHours').innerHTML=`<div style="font-size:12px;color:var(--text3);margin-bottom:8px">${new Date().toLocaleDateString('de-DE',{month:'long',year:'numeric'})}</div>`+entries.sort((a,b)=>b.totalHours-a.totalHours).map(u=>`<div class="hours-row"><span class="hours-user">${esc(u.name)} <span style="font-size:11px;color:var(--text3);font-weight:400">${u.totalShifts} Schichten</span></span><span class="hours-val">${u.totalHours.toFixed(1)} Std</span></div>`).join('');
  }catch(e){}
}

// ═══════════════════════════════════════════════════════════════════════
//  MODALS — same as before
// ═══════════════════════════════════════════════════════════════════════

function openModal(type,data){
  const overlay=document.getElementById('modalOverlay'),content=document.getElementById('modalContent');
  if(type==='addUser'){content.innerHTML=`<div class="modal-title">Neuer Benutzer <button class="modal-close" onclick="closeModal()">✕</button></div><div class="form-group"><label class="form-label">Anzeigename</label><input class="form-input" id="muName" placeholder="z.B. Max Mustermann"></div><div class="form-group"><label class="form-label">Benutzername</label><input class="form-input" id="muUsername" placeholder="z.B. max"></div><div class="form-group"><label class="form-label">Passwort</label><input class="form-input" id="muPassword" type="password" placeholder="Min. 6 Zeichen"></div><div class="form-group"><label class="form-label">Rolle</label><select class="form-input" id="muRole"><option value="staff">Mitarbeiter</option><option value="admin">Admin</option></select></div><button class="btn btn-accent btn-full" onclick="createUser()">Benutzer erstellen</button>`;}
  else if(type==='addTask'){content.innerHTML=`<div class="modal-title">Neue Tagesaufgabe <button class="modal-close" onclick="closeModal()">✕</button></div><div class="form-group"><label class="form-label">Titel</label><input class="form-input" id="mtTitle" placeholder="z.B. Parkplatz kontrollieren"></div><div class="form-group"><label class="form-label">Beschreibung (optional)</label><input class="form-input" id="mtDesc" placeholder="Details..."></div><button class="btn btn-accent btn-full" onclick="createTask()">Aufgabe erstellen</button>`;}
  else if(type==='editUser'){content.innerHTML=`<div class="modal-title">Benutzer bearbeiten <button class="modal-close" onclick="closeModal()">✕</button></div><div class="form-group"><label class="form-label">Anzeigename</label><input class="form-input" id="euName" value="${esc(data.name)}"></div><div class="form-group"><label class="form-label">Neues Passwort (leer = unverändert)</label><input class="form-input" id="euPassword" type="password"></div><div class="form-group"><label class="form-label">Rolle</label><select class="form-input" id="euRole"><option value="staff" ${data.role==='staff'?'selected':''}>Mitarbeiter</option><option value="admin" ${data.role==='admin'?'selected':''}>Admin</option></select></div><button class="btn btn-accent btn-full" onclick="updateUser(${data.id})">Speichern</button>`;}
  else if(type==='editTask'){content.innerHTML=`<div class="modal-title">Aufgabe bearbeiten <button class="modal-close" onclick="closeModal()">✕</button></div><div class="form-group"><label class="form-label">Titel</label><input class="form-input" id="etTitle" value="${esc(data.title)}"></div><div class="form-group"><label class="form-label">Beschreibung</label><input class="form-input" id="etDesc" value="${esc(data.description)}"></div><button class="btn btn-accent btn-full" onclick="updateTask(${data.id})">Speichern</button>`;}
  else if(type==='addTemplate'){content.innerHTML=`<div class="modal-title">Neue Schichtvorlage <button class="modal-close" onclick="closeModal()">✕</button></div><div class="form-group"><label class="form-label">Name</label><input class="form-input" id="stName" placeholder="z.B. Frühschicht"></div><div class="form-group"><label class="form-label">Startzeit</label><input class="form-input" id="stStart" type="time" value="03:00"></div><div class="form-group"><label class="form-label">Endzeit</label><input class="form-input" id="stEnd" type="time" value="12:00"></div><div class="form-group"><label class="form-label">Farbe</label><input type="color" id="stColor" value="#CC6CE7" style="width:100%;height:44px;border:1.5px solid var(--border);border-radius:10px;cursor:pointer"></div><button class="btn btn-accent btn-full" onclick="createTemplate()">Vorlage erstellen</button>`;}
  else if(type==='addShift'){
    const activeUsers=(allUsers||[]).filter(u=>u.active);
    const tplOptions=shiftTemplates.map(t=>`<option value="${t.id}" data-start="${t.start_time}" data-end="${t.end_time}">${t.name} (${t.start_time}–${t.end_time})</option>`).join('');
    content.innerHTML=`<div class="modal-title">Schicht: ${data.dayName} <button class="modal-close" onclick="closeModal()">✕</button></div><div class="form-group"><label class="form-label">Mitarbeiter</label><select class="form-input" id="shUser">${activeUsers.map(u=>`<option value="${u.id}">${esc(u.display_name)}</option>`).join('')}</select></div><div class="form-group"><label class="form-label">Vorlage (optional)</label><select class="form-input" id="shTpl" onchange="applyTemplate()"><option value="">— Individuelle Zeit —</option>${tplOptions}</select></div><div class="form-group"><label class="form-label">Startzeit</label><input class="form-input" id="shStart" type="time" value="03:00"></div><div class="form-group"><label class="form-label">Endzeit</label><input class="form-input" id="shEnd" type="time" value="12:00"></div><div class="form-group"><label class="form-label">Pause (Minuten)</label><input class="form-input" id="shBreak" type="number" value="0" min="0" max="120"></div><div class="form-group"><label class="form-label">Notiz (optional)</label><input class="form-input" id="shNote" placeholder="z.B. Shuttle-Dienst"></div><input type="hidden" id="shDate" value="${data.date}"><button class="btn btn-accent btn-full" onclick="createShift()">Schicht eintragen</button>`;
  }
  else if(type==='addDamage'){
    const now=new Date();const timeStr=now.toTimeString().slice(0,5);
    content.innerHTML=`<div class="modal-title">Schaden protokollieren <button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="form-group"><label class="form-label">Vorname *</label><input class="form-input" id="dmFirstName" placeholder="Vorname des Kunden"></div>
      <div class="form-group"><label class="form-label">Nachname *</label><input class="form-input" id="dmLastName" placeholder="Nachname"></div>
      <div class="form-group"><label class="form-label">Kennzeichen *</label><input class="form-input" id="dmPlate" placeholder="z.B. HH-AB 1234" style="text-transform:uppercase;font-family:'JetBrains Mono',monospace;font-weight:700" oninput="this.value=this.value.toUpperCase()"></div>
      <div style="display:flex;gap:8px"><div class="form-group" style="flex:1"><label class="form-label">Automarke</label><input class="form-input" id="dmBrand" placeholder="z.B. VW Golf"></div><div class="form-group" style="flex:1"><label class="form-label">Farbe</label><input class="form-input" id="dmColor" placeholder="z.B. Schwarz"></div></div>
      <div class="form-group"><label class="form-label">Uhrzeit</label><input class="form-input" id="dmTime" type="time" value="${timeStr}"></div>
      <div class="form-group"><label class="form-label">Beschreibung des Schadens *</label><textarea class="form-input" id="dmDesc" rows="4" placeholder="Was ist passiert? Wo ist der Schaden?" style="resize:vertical;font-family:'Outfit',sans-serif"></textarea></div>
      <div class="form-group"><label class="form-label">Fotos (optional)</label>
        <div class="dmg-upload-area" id="dmUploadArea" onclick="document.getElementById('dmPhotos').click()" ondragover="event.preventDefault();this.classList.add('dragover')" ondragleave="this.classList.remove('dragover')" ondrop="event.preventDefault();this.classList.remove('dragover');handleDmgFiles(event.dataTransfer.files)">
          <input type="file" id="dmPhotos" multiple accept="image/*" onchange="handleDmgFiles(this.files)">
          <div class="dmg-upload-text">📸 <span>Fotos auswählen</span> oder hierher ziehen</div>
        </div>
        <div id="dmPhotoPreview" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"></div>
      </div>
      <button class="btn btn-accent btn-full" onclick="createDamage()">Schaden protokollieren</button>`;
  }
  else if(type==='addPhotos'){
    content.innerHTML=`<div class="modal-title">Fotos hinzufügen <button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="form-group"><label class="form-label">Bezeichnung</label><select class="form-input" id="apLabel"><option value="front">Vorne</option><option value="back">Hinten</option><option value="left">Links</option><option value="right">Rechts</option><option value="detail">Detail</option><option value="other" selected>Sonstige</option></select></div>
      <div class="dmg-upload-area" onclick="document.getElementById('apFiles').click()" ondragover="event.preventDefault();this.classList.add('dragover')" ondragleave="this.classList.remove('dragover')" ondrop="event.preventDefault();this.classList.remove('dragover');handleApFiles(event.dataTransfer.files)">
        <input type="file" id="apFiles" multiple accept="image/*" onchange="handleApFiles(this.files)">
        <div class="dmg-upload-text">📸 <span>Fotos auswählen</span></div>
      </div>
      <div id="apPreview" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"></div>
      <input type="hidden" id="apDamageId" value="${data.id}">
      <button class="btn btn-accent btn-full" style="margin-top:12px" onclick="uploadMorePhotos()">Hochladen</button>`;
  }
  overlay.classList.add('open');
}

function closeModal(){document.getElementById('modalOverlay').classList.remove('open');}
function applyTemplate(){const sel=document.getElementById('shTpl');const opt=sel.options[sel.selectedIndex];if(opt.dataset.start){document.getElementById('shStart').value=opt.dataset.start;document.getElementById('shEnd').value=opt.dataset.end;}}

// ─── Action handlers ───
async function createUser(){const name=document.getElementById('muName').value.trim(),username=document.getElementById('muUsername').value.trim(),password=document.getElementById('muPassword').value,role=document.getElementById('muRole').value;if(!name||!username||!password){showToast('Alle Felder ausfüllen ⚠️');return;}if(password.length<6){showToast('Passwort min. 6 Zeichen ⚠️');return;}try{const r=await fetch('/api/users',{method:'POST',headers:ah(),body:JSON.stringify({username,password,display_name:name,role})});const d=await r.json();if(d.error){showToast(d.error+' ⚠️');return;}showToast('Benutzer erstellt ✓');closeModal();loadUsers();}catch(e){showToast('Fehler ⚠️');}}
function openEditUser(id,name,role,active){openModal('editUser',{id,name,role,active});}
async function updateUser(id){const updates={display_name:document.getElementById('euName').value.trim(),role:document.getElementById('euRole').value};const pw=document.getElementById('euPassword').value;if(pw)updates.password=pw;try{await fetch('/api/users/'+id,{method:'PUT',headers:ah(),body:JSON.stringify(updates)});showToast('Benutzer aktualisiert ✓');closeModal();loadUsers();}catch(e){showToast('Fehler ⚠️');}}
async function deactivateUser(id,name){if(!confirm('Benutzer "'+name+'" deaktivieren?'))return;try{await fetch('/api/users/'+id,{method:'DELETE',headers:ah()});showToast('Deaktiviert ✓');loadUsers();}catch(e){showToast('Fehler ⚠️');}}
async function reactivateUser(id){try{await fetch('/api/users/'+id,{method:'PUT',headers:ah(),body:JSON.stringify({active:true})});showToast('Aktiviert ✓');loadUsers();}catch(e){showToast('Fehler ⚠️');}}

async function createTask(){const title=document.getElementById('mtTitle').value.trim(),description=document.getElementById('mtDesc').value.trim();if(!title){showToast('Titel erforderlich ⚠️');return;}try{const r=await fetch('/api/tasks',{method:'POST',headers:ah(),body:JSON.stringify({title,description})});const d=await r.json();if(d.error){showToast(d.error+' ⚠️');return;}showToast('Aufgabe erstellt ✓');closeModal();loadAdminTasks();}catch(e){showToast('Fehler ⚠️');}}
function openEditTask(id,title,description){openModal('editTask',{id,title,description});}
async function updateTask(id){const title=document.getElementById('etTitle').value.trim(),description=document.getElementById('etDesc').value.trim();if(!title){showToast('Titel erforderlich ⚠️');return;}try{await fetch('/api/tasks/'+id,{method:'PUT',headers:ah(),body:JSON.stringify({title,description})});showToast('Aktualisiert ✓');closeModal();loadAdminTasks();}catch(e){showToast('Fehler ⚠️');}}
async function deleteTask(id,title){if(!confirm('Aufgabe "'+title+'" entfernen?'))return;try{await fetch('/api/tasks/'+id,{method:'DELETE',headers:ah()});showToast('Entfernt ✓');loadAdminTasks();}catch(e){showToast('Fehler ⚠️');}}

async function createTemplate(){const name=document.getElementById('stName').value.trim(),start_time=document.getElementById('stStart').value,end_time=document.getElementById('stEnd').value,color=document.getElementById('stColor').value;if(!name||!start_time||!end_time){showToast('Alle Felder ausfüllen ⚠️');return;}try{await fetch('/api/shift-templates',{method:'POST',headers:ah(),body:JSON.stringify({name,start_time,end_time,color})});showToast('Vorlage erstellt ✓');closeModal();loadAdminTemplates();}catch(e){showToast('Fehler ⚠️');}}
async function deleteTemplate(id){if(!confirm('Vorlage löschen?'))return;try{await fetch('/api/shift-templates/'+id,{method:'DELETE',headers:ah()});showToast('Entfernt ✓');loadAdminTemplates();}catch(e){showToast('Fehler ⚠️');}}

async function createShift(){const user_id=parseInt(document.getElementById('shUser').value),date=document.getElementById('shDate').value,start_time=document.getElementById('shStart').value,end_time=document.getElementById('shEnd').value,break_min=parseInt(document.getElementById('shBreak').value)||0,note=document.getElementById('shNote').value.trim();const tplSel=document.getElementById('shTpl');const template_id=tplSel.value?parseInt(tplSel.value):null;if(!user_id||!date||!start_time||!end_time){showToast('Alle Pflichtfelder ausfüllen ⚠️');return;}try{await fetch('/api/shifts',{method:'POST',headers:ah(),body:JSON.stringify({user_id,date,template_id,start_time,end_time,break_min,note})});showToast('Schicht eingetragen ✓');closeModal();loadSchedule();}catch(e){showToast('Fehler ⚠️');}}

// ═══════════════════════════════════════════════════════════════════════
//  DAMAGES — online-first with cache fallback
// ═══════════════════════════════════════════════════════════════════════

let allDamages=[], dmgPendingFiles=[], apPendingFiles=[];

async function loadDamages(){
  document.getElementById('dmgLoading').style.display='flex';
  document.getElementById('dmgList').innerHTML='';
  document.getElementById('dmgDetail').style.display='none';
  document.getElementById('dmgSearch').closest('.dmg-search')||document.getElementById('dmgSearch').parentElement;
  try{document.getElementById('dmgSearch').closest('.dmg-search').style.display='';document.querySelector('.dmg-top').style.display='';}catch(e){}
  
  const cacheKey = '/api/damages';
  try{
    const r=await fetch('/api/damages',{headers:ah()});
    if(r.status===401){doLogout();return;}
    const isOfflineResp = r.headers && r.headers.get('X-Offline') === 'true';
    if(isOfflineResp) {
      const cached = await OfflineStore.getCachedApiResponse(cacheKey);
      document.getElementById('dmgLoading').style.display='none';
      if(cached) { allDamages = cached.data; renderDamages(allDamages); }
      else { document.getElementById('dmgList').innerHTML='<div class="task-empty">📴 Offline — kein Cache</div>'; }
      return;
    }
    const data=await r.json();
    document.getElementById('dmgLoading').style.display='none';
    if(r.ok&&Array.isArray(data)){allDamages=data;await OfflineStore.cacheApiResponse(cacheKey, data);renderDamages(allDamages);}
    else{allDamages=[];document.getElementById('dmgList').innerHTML=`<div class="task-empty">⚠️ ${data.error||'Fehler beim Laden'}</div>`;}
  }catch(e){
    const cached = await OfflineStore.getCachedApiResponse(cacheKey);
    document.getElementById('dmgLoading').style.display='none';
    if(cached) { allDamages = cached.data; renderDamages(allDamages); showToast('Offline-Cache geladen'); }
    else { document.getElementById('dmgList').innerHTML=`<div class="task-empty">⚠️ Verbindungsfehler</div>`; }
  }
}

function filterDamages(){
  const q=document.getElementById('dmgSearch').value.trim().toLowerCase();
  const f=q?allDamages.filter(d=>(d.plate||'').toLowerCase().includes(q)||(d.first_name||'').toLowerCase().includes(q)||(d.last_name||'').toLowerCase().includes(q)||(d.damage_number||'').toLowerCase().includes(q)):allDamages;
  renderDamages(f);
}

function renderDamages(list){
  const el=document.getElementById('dmgList');
  if(!list.length){el.innerHTML='<div class="task-empty">Keine Schäden protokolliert.</div>';return;}
  const statusLabels={open:'Offen',in_progress:'In Bearbeitung',closed:'Erledigt'};
  el.innerHTML=list.map((d,i)=>`<div class="dmg-card" style="animation-delay:${i*0.04+0.05}s" onclick="showDamageDetail(${d.id})">
    <div class="dmg-card-top"><span class="dmg-number">${esc(d.damage_number)}</span><span class="dmg-status ${d.status}">${statusLabels[d.status]||d.status}</span></div>
    <div class="dmg-card-plate">${esc(d.plate)}</div>
    <div class="dmg-card-name">${esc(d.first_name)} ${esc(d.last_name)}${d.car_brand?' · '+esc(d.car_brand):''}</div>
    <div class="dmg-card-meta"><span>📅 ${esc(d.incident_date)}</span>${d.incident_time?`<span>🕐 ${esc(d.incident_time)}</span>`:''}<span>📸 ${d.photo_count||0}</span><span>👤 ${esc(d.created_by_name||'')}</span></div>
  </div>`).join('');
}

async function showDamageDetail(id){
  try{document.getElementById('dmgSearch').closest('.dmg-search').style.display='none';}catch(e){}
  try{document.querySelector('.dmg-top').style.display='none';}catch(e){}
  document.getElementById('dmgList').innerHTML='';
  const detail=document.getElementById('dmgDetail');
  detail.style.display='block';
  detail.innerHTML='<div class="loading" style="display:flex"><div class="spinner"></div><div class="loading-text">Wird geladen...</div></div>';
  try{
    const r=await fetch('/api/damages/'+id,{headers:ah()});
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const data=await r.json();
    const d=data.damage,photos=data.photos||[];
    if(!d) throw new Error('Schaden nicht gefunden');
    const statusLabels={open:'Offen',in_progress:'In Bearbeitung',closed:'Erledigt'};
    const isAdmin=currentUser&&currentUser.role==='admin';
    detail.innerHTML=`
      <button class="btn btn-ghost" onclick="loadDamages()" style="margin-bottom:12px">← Zurück zur Liste</button>
      <div class="dmg-detail">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div class="dmg-number" style="font-size:16px">${esc(d.damage_number)}</div>
          <span class="dmg-status ${d.status}">${statusLabels[d.status]}</span>
        </div>
        <div class="dmg-detail-title" style="font-family:'JetBrains Mono',monospace;font-size:20px">${esc(d.plate)}</div>
        <div class="dmg-detail-field"><strong>Kunde:</strong> ${esc(d.first_name)} ${esc(d.last_name)}</div>
        ${d.car_brand?`<div class="dmg-detail-field"><strong>Fahrzeug:</strong> ${esc(d.car_brand)}${d.car_color?' ('+esc(d.car_color)+')':''}</div>`:''}
        <div class="dmg-detail-field"><strong>Datum:</strong> ${esc(d.incident_date)}${d.incident_time?' um '+esc(d.incident_time)+' Uhr':''}</div>
        <div class="dmg-detail-field"><strong>Erfasst von:</strong> ${esc(d.created_by_name||'—')}</div>
        <div class="dmg-detail-desc">${esc(d.description)}</div>
        ${isAdmin?`<div style="display:flex;gap:8px;margin-top:12px">
          <select class="form-input" id="dmgStatusSel" style="flex:1"><option value="open" ${d.status==='open'?'selected':''}>Offen</option><option value="in_progress" ${d.status==='in_progress'?'selected':''}>In Bearbeitung</option><option value="closed" ${d.status==='closed'?'selected':''}>Erledigt</option></select>
          <button class="btn btn-accent btn-sm" onclick="updateDamageStatus(${d.id})">Status ändern</button>
        </div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
          <button class="btn btn-sm" style="background:var(--red);color:#fff;width:100%" onclick="deleteDamage(${d.id},'${esc(d.damage_number)}')">🗑 Schaden löschen</button>
        </div>`:''}
      </div>
      <div class="dmg-detail" style="margin-top:0">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">📸 Fotos (${photos.length})</div>
          <button class="btn btn-outline btn-xs" onclick="openModal('addPhotos',{id:${d.id}})">+ Fotos</button>
        </div>
        ${photos.length?`<div class="dmg-photos">${photos.map(p=>{
          const labelNames={front:'Vorne',back:'Hinten',left:'Links',right:'Rechts',detail:'Detail',other:'Sonstige'};
          const src=p.filepath.startsWith('http')?p.filepath:'/api'+p.filepath;
          return`<div class="dmg-photo"><img src="${src}" alt="${esc(p.label)}" onclick="window.open(this.src,'_blank')" loading="lazy"><div class="dmg-photo-label">${labelNames[p.label]||p.label} · ${p.created_at?p.created_at.slice(0,16).replace('T',' '):''}</div></div>`;
        }).join('')}</div>`:'<div class="task-empty" style="padding:16px">Noch keine Fotos hochgeladen.</div>'}
      </div>
      <div style="background:var(--surface2);border-radius:var(--r);padding:14px;margin-top:8px">
        <div style="font-size:12px;color:var(--text3)">Schadensnummer für den Kunden:</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:800;color:var(--red);margin-top:4px;text-align:center;padding:8px;background:var(--surface);border-radius:8px;border:1.5px solid var(--border)">${esc(d.damage_number)}</div>
      </div>`;
  }catch(e){
    detail.innerHTML=`<button class="btn btn-ghost" onclick="loadDamages()" style="margin-bottom:12px">← Zurück zur Liste</button><div class="task-empty">⚠️ Fehler beim Laden: ${e.message}</div>`;
  }
}

async function deleteDamage(id, number) {
  if (!confirm(`Schaden ${number} wirklich löschen?\n\nDas kann nicht rückgängig gemacht werden.`)) return;
  try {
    const r = await fetch('/api/damages/' + id, { method: 'DELETE', headers: ah() });
    if (!r.ok) throw new Error('Fehler');
    showToast('Schaden gelöscht ✓');
    loadDamages();
  } catch (e) { showToast('Fehler beim Löschen ⚠️'); }
}

async function updateDamageStatus(id){
  const status=document.getElementById('dmgStatusSel').value;
  try{await fetch('/api/damages/'+id,{method:'PUT',headers:ah(),body:JSON.stringify({status})});showToast('Status aktualisiert ✓');showDamageDetail(id);}catch(e){showToast('Fehler ⚠️');}
}

function handleDmgFiles(files){
  dmgPendingFiles=[...dmgPendingFiles,...files];
  const prev=document.getElementById('dmPhotoPreview');
  prev.innerHTML=dmgPendingFiles.map((f,i)=>`<div style="width:60px;height:60px;border-radius:8px;overflow:hidden;border:1.5px solid var(--border);position:relative"><img src="${URL.createObjectURL(f)}" style="width:100%;height:100%;object-fit:cover"><div style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,0.5);color:#fff;width:18px;height:18px;border-radius:50%;font-size:11px;display:grid;place-items:center;cursor:pointer" onclick="removeDmgFile(${i})">✕</div></div>`).join('');
}
function removeDmgFile(i){dmgPendingFiles.splice(i,1);handleDmgFiles([]);}
function handleApFiles(files){
  apPendingFiles=[...apPendingFiles,...files];
  const prev=document.getElementById('apPreview');
  prev.innerHTML=apPendingFiles.map((f,i)=>`<div style="width:60px;height:60px;border-radius:8px;overflow:hidden;border:1.5px solid var(--border)"><img src="${URL.createObjectURL(f)}" style="width:100%;height:100%;object-fit:cover"></div>`).join('');
}

async function createDamage(){
  const first_name=document.getElementById('dmFirstName').value.trim();
  const last_name=document.getElementById('dmLastName').value.trim();
  const plate=document.getElementById('dmPlate').value.trim().toUpperCase();
  const car_brand=document.getElementById('dmBrand').value.trim();
  const car_color=document.getElementById('dmColor').value.trim();
  const incident_time=document.getElementById('dmTime').value;
  const description=document.getElementById('dmDesc').value.trim();
  if(!first_name||!last_name||!plate||!description){showToast('Pflichtfelder ausfüllen ⚠️');return;}
  try{
    const r=await fetch('/api/damages',{method:'POST',headers:ah(),body:JSON.stringify({first_name,last_name,plate,car_brand,car_color,incident_time,description})});
    const d=await r.json();
    if(d.error){showToast(d.error+' ⚠️');return;}
    if(dmgPendingFiles.length>0){
      const fd=new FormData();
      dmgPendingFiles.forEach(f=>fd.append('photos',f));
      fd.append('label','other');
      await fetch('/api/damages/'+d.id+'/photos',{method:'POST',headers:{'Authorization':'Bearer '+authToken},body:fd});
    }
    dmgPendingFiles=[];
    showToast('Schaden '+d.damage_number+' protokolliert ✓');
    closeModal();loadDamages();
    setTimeout(()=>showDamageDetail(d.id),500);
  }catch(e){showToast('Fehler ⚠️');}
}

async function uploadMorePhotos(){
  const damageId=document.getElementById('apDamageId').value;
  const label=document.getElementById('apLabel').value;
  if(!apPendingFiles.length){showToast('Keine Fotos ausgewählt ⚠️');return;}
  const fd=new FormData();
  apPendingFiles.forEach(f=>fd.append('photos',f));
  fd.append('label',label);
  try{
    await fetch('/api/damages/'+damageId+'/photos',{method:'POST',headers:{'Authorization':'Bearer '+authToken},body:fd});
    apPendingFiles=[];
    showToast('Fotos hochgeladen ✓');
    closeModal();showDamageDetail(parseInt(damageId));
  }catch(e){showToast('Fehler ⚠️');}
}

// ═══════════════════════════════════════════════════════════════════════
//  DAILY SCRAPE — Manual trigger
// ═══════════════════════════════════════════════════════════════════════

async function dailyScrape(companyId) {
  const statusDiv = document.getElementById('dailyScrapeStatus');
  const btn = companyId === 'parkking' ? document.getElementById('dailyScrapePK') : document.getElementById('dailyScrapePSF');
  const companyName = companyId === 'parkking' ? 'Biemann' : 'Hasloh';

  btn.disabled = true;
  btn.textContent = '⏳ Scrapt...';
  statusDiv.innerHTML = `<span style="color:var(--accent)">⏳ ${companyName} wird gescrapt...</span>`;

  try {
    const r = await fetch('/api/scrape', {
      method: 'POST',
      headers: ah(),
      body: JSON.stringify({ company: companyId })
    });
    const data = await r.json();

    if (data.error) {
      statusDiv.innerHTML = `<span style="color:var(--red)">❌ ${data.error}: ${data.detail || ''}</span>`;
    } else if (data.inProgress) {
      statusDiv.innerHTML = `<span style="color:var(--orange)">⏳ ${companyName}: Scrape läuft bereits...</span>`;
    } else {
      statusDiv.innerHTML = `<span style="color:var(--green)">✅ ${companyName}: ${data.total} Buchungen, ${data.created} neu, ${data.updated} aktualisiert (${Math.round(data.duration / 1000)}s)</span>`;
      showToast(`${companyName} Scrape fertig ✓`);
      // Reload bookings if on bookings tab
      if (currentCompany === companyId) loadBookings(false);
    }
  } catch (e) {
    statusDiv.innerHTML = `<span style="color:var(--red)">❌ Fehler: ${e.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = companyId === 'parkking' ? '🅿️ Biemann scrapen' : '✈️ Hasloh scrapen';
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  YEAR SCRAPE — One-time full import
// ═══════════════════════════════════════════════════════════════════════

async function yearScrape(companyId) {
  const statusDiv = document.getElementById('yearScrapeStatus');
  const btn = companyId === 'parkking' ? document.getElementById('yearScrapePK') : document.getElementById('yearScrapePSF');
  const companyName = companyId === 'parkking' ? 'Biemann' : 'Hasloh';

  if (!confirm(`Alle Buchungen von ${companyName} aus der Jahresansicht importieren?\n\nDas kann einige Minuten dauern.`)) return;

  btn.disabled = true;
  btn.textContent = '⏳ Importiert...';
  statusDiv.innerHTML = `<span style="color:var(--accent)">⏳ ${companyName} wird importiert... Bitte warten.</span>`;

  try {
    const r = await fetch('/api/scrape/year', {
      method: 'POST',
      headers: ah(),
      body: JSON.stringify({ company: companyId })
    });
    const data = await r.json();

    if (data.error) {
      statusDiv.innerHTML = `<span style="color:var(--red)">❌ ${data.error}: ${data.detail || ''}</span>`;
    } else {
      statusDiv.innerHTML = `<span style="color:var(--green)">✅ ${companyName}: ${data.total} Buchungen gefunden, ${data.created} neu, ${data.updated} aktualisiert (${Math.round(data.duration / 1000)}s)</span>`;
      showToast(`${companyName} Import fertig ✓`);
    }
  } catch (e) {
    statusDiv.innerHTML = `<span style="color:var(--red)">❌ Fehler: ${e.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = companyId === 'parkking' ? '🅿️ Biemann importieren' : '✈️ Hasloh importieren';
  }
}

// ─── Lightbox (same as before) ──────────────────────────────────────────
function closeLightbox(){document.getElementById('lightbox').classList.remove('open');}
