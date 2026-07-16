<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Generate admin password hash</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/bcryptjs/2.4.3/bcrypt.min.js"></script>
<style>
  body{font-family:sans-serif;max-width:520px;margin:60px auto;padding:0 20px;color:#222;}
  h1{font-size:20px;}
  p{color:#555;line-height:1.5;}
  input{width:100%;padding:10px;font-size:15px;margin:14px 0;box-sizing:border-box;}
  button{padding:10px 20px;font-size:15px;cursor:pointer;}
  #result{margin-top:20px;padding:14px;background:#f2f2f2;border-radius:6px;
    word-break:break-all;font-family:monospace;font-size:13px;display:none;}
  .note{font-size:13px;color:#777;margin-top:24px;}
</style>
</head>
<body>
  <h1>Generate your PaikallisCanvas admin password hash</h1>
  <p>This runs entirely in your own browser — nothing here is sent anywhere, including to me.
  Nobody but you ever sees the real password, only the hash it produces below.</p>

  <input type="password" id="pw" placeholder="Choose your admin password" />
  <button onclick="generate()">Generate hash</button>

  <div id="result"></div>

  <p class="note">Copy the hash it shows, then paste it into Vercel as the
  <code>ADMIN_PASSWORD_HASH</code> environment variable. This file itself doesn't need to be
  uploaded anywhere — just open it locally whenever you want to set or change the password.</p>

  <hr style="margin:40px 0;border:none;border-top:1px solid #ddd;">

  <h1>Generate ADMIN_TOKEN_SECRET</h1>
  <p>This one isn't a password — just a long random string. Click the button, copy the result,
  paste it into Vercel as <code>ADMIN_TOKEN_SECRET</code>. You'll never need to type or remember it.</p>
  <button onclick="generateSecret()">Generate random secret</button>
  <div id="secretResult"></div>

<script>
function generateSecret(){
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const box = document.getElementById('secretResult');
  box.textContent = hex;
  box.style.display = 'block';
  box.style.marginTop = '20px';
  box.style.padding = '14px';
  box.style.background = '#f2f2f2';
  box.style.borderRadius = '6px';
  box.style.wordBreak = 'break-all';
  box.style.fontFamily = 'monospace';
  box.style.fontSize = '13px';
}
</script>

<script>
function generate(){
  const pw = document.getElementById('pw').value;
  if (!pw){ alert('Type a password first.'); return; }
  const hash = dcodeIO.bcrypt.hashSync(pw, 12);
  const box = document.getElementById('result');
  box.textContent = hash;
  box.style.display = 'block';
}
</script>
</body>
</html>
