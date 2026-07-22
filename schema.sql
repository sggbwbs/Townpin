<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Manage your PaikallisCanvas listing</title>
<meta name="robots" content="noindex, nofollow" />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/cropper.min.css" />
<script src="https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/cropper.min.js"></script>
<style>
  :root{ --bg-0:#050b14; --paper:#f4efe4; --amber:#f2a65a; --amber-bright:#ffc07e; }
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;background:var(--bg-0);color:#f5f7fb;
    font-family:'IBM Plex Sans',sans-serif;display:flex;align-items:flex-start;justify-content:center;padding:60px 20px;}
  h1{font-family:'Space Grotesk',sans-serif;font-size:20px;margin:0 0 6px;}
  .sub{color:#8fa3bd;font-size:13px;margin:0 0 24px;}
  .card{background:var(--paper);color:#26210f;max-width:520px;width:100%;border-radius:14px;padding:32px;margin-bottom:20px;}
  .card h2{font-family:'Space Grotesk',sans-serif;font-size:16px;margin:0 0 4px;}
  .card .idx{font-size:11.5px;color:#8a8168;margin-bottom:16px;}
  label{display:block;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;
    color:#5c5440;margin:14px 0 5px;}
  input[type=text],input[type=url],textarea{width:100%;padding:10px 12px;border:1px solid #d8cfb4;
    border-radius:7px;font-size:14px;font-family:'IBM Plex Sans',sans-serif;background:#fffdf8;}
  textarea{min-height:60px;resize:vertical;}
  .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;}
  .swatch{width:28px;height:28px;border-radius:6px;cursor:pointer;border:2px solid transparent;}
  .swatch.selected{border-color:#26210f;}
  button{border:none;border-radius:8px;padding:11px 18px;font-family:'Space Grotesk',sans-serif;
    font-weight:700;font-size:13.5px;cursor:pointer;margin-top:8px;margin-right:8px;}
  .primary{background:linear-gradient(135deg,var(--amber-bright),var(--amber));color:#2a1c0d;}
  .secondary{background:#e4dcc4;color:#3a331d;}
  .danger{background:none;color:#b8452f;text-decoration:underline;}
  .saved{color:#4a7a5c;font-size:12.5px;margin-left:8px;display:none;}
  .err{color:#b8452f;font-size:13px;margin:12px 0 0;}
  .blurbBox{background:#efe8d3;border-radius:8px;padding:12px;margin-top:8px;font-size:13px;line-height:1.5;}
  .note{font-size:11.5px;color:#8a8168;margin-top:6px;}
</style>
</head>
<body>

<div id="app">
  <p class="sub" style="color:#8fa3bd;">Loading…</p>
</div>

<script>
const params = new URLSearchParams(location.search);
const token = params.get('token');
const app = document.getElementById('app');
const SWATCHES = ["#f2a65a","#d9694f","#5b8c5a","#3d6b94","#8a6fb0","#2b2718","#e0d9c4"];

if (!token) {
  app.innerHTML = '<div class="card"><h1>Missing link</h1><p>This page needs the edit link from your purchase confirmation — check your email receipt or the success page you saw right after paying.</p></div>';
} else {
  load();
}

async function load(){
  try{
    const res = await fetch(`/api/manage?token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (!res.ok){
      app.innerHTML = `<div class="card"><h1>Link not found</h1><p>${data.error || 'This edit link is no longer valid.'}</p></div>`;
      return;
    }
    render(data.squares, data.towns);
  }catch(e){
    app.innerHTML = '<div class="card"><h1>Network error</h1><p>Please try refreshing.</p></div>';
  }
}

function render(squares, towns){
  const s = squares[0]; // cosmetic fields (logo/tagline/color) are shared across all squares in one purchase
  const townsById = {};
  (towns || []).forEach(t => { townsById[t.id] = t; });

  // group squares by town for an accurate summary when a purchase spans more than one town
  const countsByTown = {};
  squares.forEach(sq => {
    const name = townsById[sq.town_id] ? townsById[sq.town_id].name : 'unknown town';
    countsByTown[name] = (countsByTown[name] || 0) + 1;
  });
  const townSummary = Object.entries(countsByTown).map(([name, n]) => `${n} in ${name}`).join(', ');
  const totalViews = squares.reduce((sum, sq) => sum + (sq.view_count || 0), 0);

  app.innerHTML = `
    <h1>Manage your listing</h1>
    <p class="sub">${s.company_name} — ${squares.length} square${squares.length>1?'s':''} (${townSummary})</p>

    <div class="card" style="text-align:center;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#8a8168;margin-bottom:4px;">Total page views</div>
      <div style="font-size:34px;font-weight:700;font-family:'Space Grotesk',sans-serif;color:#3a331d;">${totalViews.toLocaleString()}</div>
      <p class="sub" style="margin-top:6px;">Every time someone opens your square's page, it counts here — real proof people are actually looking, not just a promise.</p>
    </div>

    <div class="card">
      <h2>Appearance</h2>
      <label>Tagline (shown on your page)</label>
      <p class="note" style="margin:-4px 0 8px;">This is shared across all your squares, even if they're in different towns.</p>
      <input type="text" id="tagline" value="${(s.tagline||'').replace(/"/g,'&quot;')}" placeholder="A short line about your business" maxlength="120" />
      <label>Logo</label>
      <input type="file" id="logoFile" accept="image/png,image/jpeg,image/webp" style="display:none;" />
      <button type="button" class="secondary" id="logoUploadBtn" style="width:auto;">📁 Choose a new image</button>
      <div id="cropperWrap" style="display:none;margin-top:12px;">
        <div style="max-height:280px;overflow:hidden;border-radius:8px;background:#e4dcc4;">
          <img id="cropperImg" style="display:block;max-width:100%;" />
        </div>
        <p class="note">Drag and zoom to fit your square(s)' shape.</p>
        <button type="button" class="primary" id="cropConfirmBtn" style="width:auto;">✓ Use this crop</button>
      </div>
      <div style="margin-top:10px;display:flex;align-items:center;gap:10px;">
        <img id="logoUrlPreview" src="${(s.logo_url||'').replace(/"/g,'&quot;')}" style="width:44px;height:44px;object-fit:contain;border-radius:6px;border:1px solid #d8cfb4;background:#eae3d3;${s.logo_url ? '' : 'display:none;'}" />
        <span class="note" id="currentLogoNote" style="margin:0;">${s.logo_url ? 'Current logo shown above.' : 'No logo set yet.'}</span>
      </div>
      <input type="url" id="logoUrl" value="${(s.logo_url||'').replace(/"/g,'&quot;')}" style="display:none;" />
      <label>Square color (used if no logo)</label>
      <div class="row" id="colorRow"></div>
      <button class="primary" onclick="saveAppearance()">Save appearance</button>
      <span class="saved" id="savedAppearance">✓ Saved</span>
      <div class="err" id="errAppearance"></div>
    </div>

    <div class="card">
      <h2>AI-found "quick info"</h2>
      <p class="sub" style="margin-bottom:10px;">This was automatically found and written by searching the web for your company. You can edit it, ask it to search again, or remove it entirely.</p>
      ${s.ai_blurb_fi ? `<div class="blurbBox"><b>FI:</b> ${s.ai_blurb_fi}</div>` : '<div class="blurbBox">No info currently shown.</div>'}
      ${s.ai_blurb_en ? `<div class="blurbBox"><b>EN:</b> ${s.ai_blurb_en}</div>` : ''}
      <label>Edit Finnish text</label>
      <textarea id="blurbFi">${s.ai_blurb_fi||''}</textarea>
      <label>Edit English text</label>
      <textarea id="blurbEn">${s.ai_blurb_en||''}</textarea>
      <div>
        <button class="secondary" onclick="saveBlurbText()">Save edited text</button>
        <button class="secondary" onclick="regenerateBlurb()">🔎 Search again</button>
        <button class="danger" onclick="clearBlurb()">Remove entirely</button>
      </div>
      <span class="saved" id="savedBlurb">✓ Saved</span>
      <div class="err" id="errBlurb"></div>
    </div>

    ${s.subscription_id ? `
    <div class="card">
      <h2>Cancel subscription</h2>
      <p class="sub" style="margin-bottom:12px;">
        No contract, no notice period. If you cancel, your square(s) stay live and visible for the rest of the period you've already paid for — then they're removed automatically. You won't be charged again.
      </p>
      <button class="danger" style="border:1px solid #c1503a;padding:9px 16px;border-radius:7px;" onclick="cancelSubscription()">Cancel my subscription</button>
      <span class="saved" id="savedCancel">✓ Done</span>
      <div class="err" id="errCancel"></div>
    </div>` : (s.active_until ? `
    <div class="card">
      <h2>Prepaid term</h2>
      <p class="sub">
        This was paid upfront for a fixed term and does not auto-renew. Your square(s) stay live until <b>${new Date(s.active_until).toLocaleDateString()}</b>, then become available for someone else to claim. You can come back and buy again anytime before or after that date.
      </p>
    </div>` : '')}
  `;

  const colorRow = document.getElementById('colorRow');
  let chosenColor = s.color || SWATCHES[0];
  SWATCHES.forEach(c=>{
    const sw = document.createElement('div');
    sw.className = 'swatch' + (c === chosenColor ? ' selected' : '');
    sw.style.background = c;
    sw.addEventListener('click', ()=>{
      chosenColor = c;
      document.querySelectorAll('.swatch').forEach(el=>el.classList.remove('selected'));
      sw.classList.add('selected');
    });
    colorRow.appendChild(sw);
  });
  window._getChosenColor = () => chosenColor;

  // ---- logo upload + crop ----
  let cropper = null;
  const primaryTown = townsById[s.town_id];
  const gridSize = primaryTown ? primaryTown.grid_size : 20;
  // Only squares in the SAME town as the primary square -- squares in a
  // different town use their own independent row/col coordinate system,
  // so mixing them into one bounding box would be meaningless.
  const sameTownSquares = squares.filter(sq => sq.town_id === s.town_id);
  const rows = sameTownSquares.map(sq => Math.floor(sq.idx / gridSize));
  const cols = sameTownSquares.map(sq => sq.idx % gridSize);
  const aspectRatio = (Math.max(...cols) - Math.min(...cols) + 1) / (Math.max(...rows) - Math.min(...rows) + 1);

  document.getElementById('logoUploadBtn').addEventListener('click', ()=>{
    document.getElementById('logoFile').click();
  });
  document.getElementById('logoFile').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev)=>{
      const img = document.getElementById('cropperImg');
      img.src = ev.target.result;
      document.getElementById('cropperWrap').style.display = 'block';
      if (cropper) cropper.destroy();
      cropper = new Cropper(img, {
        aspectRatio,
        viewMode: 0, // lets the image zoom OUT smaller than the crop box, instead of being forced to fill it and cropping off whatever doesn't fit
        autoCropArea: 1,
        background: false,
        ready: function(){
          // Default to showing the WHOLE logo shrunk to fit, not filling
          // the box and cropping off the rest -- see index.html for the
          // full explanation of why this changed.
          const imageData = cropper.getImageData();
          const cropBoxData = cropper.getCropBoxData();
          const fitScale = Math.min(
            cropBoxData.width / imageData.naturalWidth,
            cropBoxData.height / imageData.naturalHeight
          );
          cropper.zoomTo(fitScale);
          const canvasData = cropper.getCanvasData();
          cropper.setCanvasData({
            left: cropBoxData.left - (canvasData.width - cropBoxData.width) / 2,
            top: cropBoxData.top - (canvasData.height - cropBoxData.height) / 2
          });
        }
      });
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('cropConfirmBtn').addEventListener('click', ()=>{
    if (!cropper) return;
    const canvas = cropper.getCroppedCanvas({ maxWidth: 800, maxHeight: 800 });
    const btn = document.getElementById('cropConfirmBtn');
    btn.disabled = true; btn.textContent = 'Uploading…';
    canvas.toBlob((blob)=>{
      const reader = new FileReader();
      reader.onload = async ()=>{
        const base64 = reader.result.split(',')[1];
        try{
          const res = await fetch('/api/upload-logo', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ imageBase64: base64, contentType: 'image/png' })
          });
          const data = await res.json();
          if (!res.ok){ alert(data.error || 'Upload failed.'); btn.disabled = false; btn.textContent = '✓ Use this crop'; return; }
          document.getElementById('logoUrl').value = data.url;
          document.getElementById('logoUrlPreview').src = data.url;
          document.getElementById('logoUrlPreview').style.display = 'inline-block';
          document.getElementById('currentLogoNote').textContent = 'New logo ready — click "Save appearance" below to confirm.';
          document.getElementById('cropperWrap').style.display = 'none';
          cropper.destroy(); cropper = null;
          btn.disabled = false; btn.textContent = '✓ Use this crop';
        }catch(err){
          alert('Network error.');
          btn.disabled = false; btn.textContent = '✓ Use this crop';
        }
      };
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
}

async function post(body){
  const res = await fetch('/api/manage', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ token, ...body })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Save failed.');
  return data;
}

async function saveAppearance(){
  const errBox = document.getElementById('errAppearance');
  errBox.textContent = '';
  try{
    await post({
      tagline: document.getElementById('tagline').value,
      logoUrl: document.getElementById('logoUrl').value,
      color: window._getChosenColor()
    });
    flash('savedAppearance');
  }catch(e){ errBox.textContent = e.message; }
}

async function saveBlurbText(){
  const errBox = document.getElementById('errBlurb');
  errBox.textContent = '';
  try{
    await post({
      aiBlurbFi: document.getElementById('blurbFi').value,
      aiBlurbEn: document.getElementById('blurbEn').value
    });
    flash('savedBlurb');
    load();
  }catch(e){ errBox.textContent = e.message; }
}

async function regenerateBlurb(){
  const errBox = document.getElementById('errBlurb');
  errBox.textContent = '';
  try{
    await post({ action: 'regenerate_blurb' });
    flash('savedBlurb');
    load();
  }catch(e){ errBox.textContent = e.message; }
}

async function clearBlurb(){
  const errBox = document.getElementById('errBlurb');
  errBox.textContent = '';
  try{
    await post({ action: 'clear_blurb' });
    flash('savedBlurb');
    load();
  }catch(e){ errBox.textContent = e.message; }
}

async function cancelSubscription(){
  const errBox = document.getElementById('errCancel');
  errBox.textContent = '';
  if (!confirm('Cancel your subscription? Your square(s) will stay live until the end of your current billing period, then be removed. You will not be charged again.')) return;
  try{
    const data = await post({ action: 'cancel_subscription' });
    const endsDate = data.endsAt ? new Date(data.endsAt * 1000).toLocaleDateString() : 'the end of your current period';
    flash('savedCancel');
    errBox.style.color = '#4a7a5c';
    errBox.textContent = `Cancelled. Your square(s) stay live until ${endsDate}.`;
  }catch(e){ errBox.textContent = e.message; }
}

function flash(id){
  const el = document.getElementById(id);
  el.style.display = 'inline';
  setTimeout(()=> el.style.display = 'none', 2500);
}
</script>
</body>
</html>
