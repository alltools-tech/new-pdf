// Simple frontend with XHR upload + progress for bulk conversions
(function(){
  const chooseBtn = document.getElementById('chooseBtn');
  const fileInput = document.getElementById('fileInput');
  const dropZone = document.getElementById('dropZone');
  const fileInfo = document.getElementById('fileInfo');
  const targetFormat = document.getElementById('targetFormat');
  const quality = document.getElementById('quality');
  const qualityVal = document.getElementById('qualityVal');
  const maxDim = document.getElementById('maxDim');
  const compressPdf = document.getElementById('compressPdf');
  const makeZip = document.getElementById('makeZip');
  const toolForm = document.getElementById('toolForm');
  const processing = document.getElementById('processing');
  const processingText = document.getElementById('processingText');
  const resultArea = document.getElementById('resultArea');
  const resultMsg = document.getElementById('resultMsg');
  const downloadArea = document.getElementById('downloadArea');
  const previewArea = document.getElementById('previewArea');
  const log = document.getElementById('log');

  let files = [];

  quality.addEventListener('input', (e) => qualityVal.innerText = e.target.value);

  chooseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => { if (e.target.files) handleFiles(e.target.files); });

  ['dragenter','dragover'].forEach(ev => dropZone.addEventListener(ev, (e)=>{ e.preventDefault(); dropZone.classList.add('border-primary'); }));
  ['dragleave','drop'].forEach(ev => dropZone.addEventListener(ev, (e)=>{ e.preventDefault(); dropZone.classList.remove('border-primary'); }));
  dropZone.addEventListener('drop', (e)=>{ e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files); });

  function handleFiles(fileList) {
    files = Array.from(fileList);
    if (!files.length) { fileInfo.innerText = ''; return; }
    fileInfo.innerText = files.map(f=>`${f.name} (${(f.size/1024).toFixed(2)} KB)`).join(' ; ');
    previewFiles();
  }

  function previewFiles() {
    previewArea.innerHTML = '';
    for (const f of files.slice(0,6)) {
      const div = document.createElement('div'); div.className = 'mb-2 d-inline-block me-2';
      if (f.type.startsWith('image/')) {
        const img = document.createElement('img'); img.src = URL.createObjectURL(f); img.style.maxWidth = '120px'; img.style.display='block';
        div.appendChild(img);
      } else {
        const span = document.createElement('div'); span.innerText = f.name; span.className='small';
        div.appendChild(span);
      }
      previewArea.appendChild(div);
    }
  }

  toolForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!files || !files.length) { alert('Choose files first'); return; }

    processing.style.display = 'block';
    processingText.innerText = 'Uploading...';
    resultArea.style.display = 'none';
    downloadArea.innerHTML = '';
    resultMsg.innerText = '';
    log.innerText = '';

    const form = new FormData();
    for (const f of files) form.append('files', f);
    form.append('targetFormat', targetFormat.value);
    form.append('quality', quality.value);
    form.append('maxDim', maxDim.value);
    form.append('compress', compressPdf.checked ? 'true' : 'false');
    form.append('zip', makeZip.checked ? 'true' : 'false');

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/convert', true);
      xhr.responseType = 'blob';
      xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) processingText.innerText = `Uploading: ${Math.round(e.loaded / e.total * 100)}%`;
      };
      xhr.timeout = 5 * 60 * 1000; // 5 min
      xhr.ontimeout = () => { processing.style.display='none'; log.innerText='Request timed out'; };
      xhr.onerror = () => { processing.style.display='none'; log.innerText='Network error'; };
      xhr.onload = async () => {
        processing.style.display = 'none';
        if (xhr.status >= 200 && xhr.status < 300) {
          const ct = xhr.getResponseHeader('Content-Type') || '';
          const disp = xhr.getResponseHeader('Content-Disposition') || '';
          const filename = (disp.match(/filename="(.+)"/) || [null, `result_${Date.now()}`])[1];
          const blob = xhr.response;
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = filename; a.className = 'btn btn-success'; a.innerText = 'Download';
          downloadArea.appendChild(a);
          previewArea.innerHTML = '';
          if (ct.startsWith('image/')) {
            const img = document.createElement('img'); img.src = url; img.style.maxWidth = '100%'; previewArea.appendChild(img);
          } else if (ct.includes('pdf') || filename.toLowerCase().endsWith('.pdf')) {
            const embed = document.createElement('embed'); embed.src = url; embed.type = 'application/pdf'; embed.style.width='100%'; embed.style.height='500px';
            previewArea.appendChild(embed);
          } else if (ct.includes('zip')) {
            previewArea.innerText = 'ZIP ready. Use the button to download.';
          } else previewArea.innerText = 'Result ready. Use Download button.';
          resultArea.style.display = 'block';
          resultMsg.innerText = `File ready: ${filename}`;
        } else {
          // try parse JSON error
          let txt = '';
          try { txt = await blobToText(xhr.response); } catch(e){ txt = `HTTP ${xhr.status}`; }
          try { const j = JSON.parse(txt); log.innerText = 'Error: ' + (j.error || j.details || JSON.stringify(j)); } catch (e) { log.innerText = 'Error: ' + txt; }
        }
      };
      xhr.send(form);
    } catch (err) {
      processing.style.display = 'none';
      log.innerText = 'Upload failed: ' + (err && err.message ? err.message : err);
    }
  });

  function blobToText(blob) {
    return new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result);
      reader.onerror = rej;
      reader.readAsText(blob);
    });
  }
})();