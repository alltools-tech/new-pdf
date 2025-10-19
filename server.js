// server.js - Updated converter with verbose CloudConvert fallback, diagnostics and test endpoints.
// Instructions:
// - Place in project root and restart Node app in cPanel.
// - Set CLOUDCONVERT_API_KEY in cPanel environment (no trailing spaces).
// - Run "Run NPM Install" if package.json changed (ensure axios & form-data present).

// Optional dotenv support
try { require('dotenv').config(); } catch (e) { /* ignore if dotenv not installed */ }

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const { PDFDocument } = require('pdf-lib');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Basic health
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    app: 'pdftool-cloudconvert-final',
    uptime_seconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Diagnostic
app.get('/diag', (req, res) => {
  let sharpAvailable = false;
  try { require.resolve('sharp'); sharpAvailable = true; } catch (e) { sharpAvailable = false; }
  res.json({
    ok: true,
    node_version: process.version,
    sharpAvailable,
    cloudconvert_key_present: !!process.env.CLOUDCONVERT_API_KEY,
    MAX_UPLOAD_MB: process.env.MAX_UPLOAD_MB || null,
    MAX_DIMENSION: process.env.MAX_DIMENSION || null,
    timestamp: new Date().toISOString()
  });
});

// Try require sharp
let sharp = null;
let sharpAvailable = false;
try {
  sharp = require('sharp');
  sharpAvailable = true;
  console.log('local sharp available');
} catch (e) {
  console.warn('sharp not available locally:', e && e.message);
  sharpAvailable = false;
}

// Directories
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR);

// Config
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '150', 10);
const MAX_DIMENSION = parseInt(process.env.MAX_DIMENSION || '2480', 10);
const CLOUDCONVERT_API_KEY = process.env.CLOUDCONVERT_API_KEY || null;
const CLOUDCONVERT_BASE = 'https://api.cloudconvert.com/v2';

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 9) + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

// Helpers
function isImageMime(m) { return /^image\//.test(m) || m === 'image/svg+xml'; }
function isHeicByName(name, mimetype) {
  const ext = (name && path.extname(name).toLowerCase()) || '';
  return ['.heic', '.heif'].includes(ext) || ['image/heic','image/heif','application/octet-stream'].includes(mimetype);
}
function isPdfMime(m, name) { return m === 'application/pdf' || (name && path.extname(name).toLowerCase() === '.pdf'); }
function clampQuality(q) { const n = parseInt(q || '80', 10); return Math.max(10, Math.min(95, isNaN(n) ? 80 : n)); }

// ---------------- CloudConvert (verbose, robust) ----------------
// Replace or adjust this function only via careful edits.
async function cloudConvertFallbackConvert(filePath, outputFormat, options = {}) {
  if (!CLOUDCONVERT_API_KEY) throw new Error('CLOUDCONVERT_API_KEY not configured');
  const headers = { Authorization: `Bearer ${CLOUDCONVERT_API_KEY}` };

  // Normalize output format
  let outFmt = String(outputFormat || '').toLowerCase();
  if (outFmt === 'jpeg') outFmt = 'jpg';
  if (!outFmt) outFmt = 'jpg';

  console.log('CloudConvert: creating job for', filePath, '->', outFmt);
  const jobSpec = {
    tasks: {
      'import-my-file': { operation: 'import/upload' },
      'convert-my-file': {
        operation: 'convert',
        input: ['import-my-file'],
        output_format: outFmt,
        ...(options.input_format ? { input_format: options.input_format } : {}),
        ...(options.convertOptions || {})
      },
      'export-my-file': { operation: 'export/url', input: ['convert-my-file'] }
    }
  };

  // create job
  const jobResp = await axios.post(`${CLOUDCONVERT_BASE}/jobs`, jobSpec, { headers, timeout: 120000 })
    .catch(err => {
      console.error('CloudConvert: create job error', err && err.response && err.response.data ? err.response.data : err.message);
      throw new Error('CloudConvert job creation failed: ' + (err && err.message));
    });
  if (!jobResp.data || !jobResp.data.data) throw new Error('CloudConvert: failed to create job');
  const job = jobResp.data.data;
  const jobId = job.id;
  console.log('CloudConvert: job created id=', jobId);
  console.log('CloudConvert: job create response (trimmed):', JSON.stringify(job, null, 2));

  // get upload info
  const importTask = (job.tasks || []).find(t => t.name === 'import-my-file' && t.type === 'import/upload');
  if (!importTask || !importTask.result || !importTask.result.form) {
    console.error('CloudConvert: upload info missing in job create response', job);
    throw new Error('CloudConvert: upload details missing (jobId=' + jobId + ')');
  }
  const uploadUrl = importTask.result.form.url;
  const uploadParams = importTask.result.form.parameters || {};

  // upload file
  console.log('CloudConvert: uploading file to', uploadUrl, 'jobId=', jobId);
  const uploadForm = new FormData();
  Object.keys(uploadParams).forEach(k => uploadForm.append(k, uploadParams[k]));
  uploadForm.append('file', fs.createReadStream(filePath));
  await axios.post(uploadUrl, uploadForm, { headers: uploadForm.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity })
    .catch(err => {
      console.error('CloudConvert: upload error', err && err.response && err.response.data ? err.response.data : err.message, 'jobId=', jobId);
      throw new Error('CloudConvert file upload failed: ' + (err && err.message));
    });
  console.log('CloudConvert: upload complete for job', jobId);

  // poll job
  const pollUrl = `${CLOUDCONVERT_BASE}/jobs/${jobId}`;
  let jobStatus = null;
  const maxPolls = 90;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await axios.get(pollUrl, { headers }).catch(err => {
      console.warn('CloudConvert: poll error', err && err.message, 'jobId=', jobId);
      return null;
    });
    jobStatus = r && r.data && r.data.data;
    if (!jobStatus) continue;
    console.log(`CloudConvert job ${jobId} status: ${jobStatus.status} (poll ${i})`);
    if (jobStatus.status === 'finished') break;
    if (jobStatus.status === 'error' || jobStatus.status === 'failed') {
      console.error('CloudConvert job failed', JSON.stringify(jobStatus, null, 2));
      throw new Error('CloudConvert job failed: ' + JSON.stringify(jobStatus));
    }
  }

  if (!jobStatus || jobStatus.status !== 'finished') {
    console.error('CloudConvert job did not finish or no finished status', jobId, jobStatus && jobStatus.status);
    throw new Error('CloudConvert job timeout or did not finish (jobId=' + jobId + ', status=' + (jobStatus && jobStatus.status) + ')');
  }

  // Log full jobStatus
  console.log('CloudConvert: final jobStatus for', jobId, ':', JSON.stringify(jobStatus, null, 2));

  // find export task/files
  const exportTask = (jobStatus.tasks || []).find(t => t.name === 'export-my-file' && t.status === 'finished');
  if (!exportTask || !exportTask.result || !exportTask.result.files || exportTask.result.files.length === 0) {
    console.error('CloudConvert: no export files', JSON.stringify(jobStatus, null, 2));
    throw new Error('CloudConvert: no export files found (jobId=' + jobId + ')');
  }

  console.log('CloudConvert: export files metadata:', JSON.stringify(exportTask.result.files, null, 2));

  // download outputs
  const downloadedPaths = [];
  for (const fileMeta of exportTask.result.files) {
    const fileUrl = fileMeta.url;
    const extFromName = path.extname(fileMeta.filename) || `.${outFmt}`;
    const tmpOut = path.join(path.dirname(filePath), `${path.parse(filePath).name}_cloudconv_${Date.now()}_${Math.random().toString(36).slice(2,8)}${extFromName}`);
    console.log('CloudConvert: downloading', fileUrl, '->', tmpOut, 'jobId=', jobId);
    const writer = fs.createWriteStream(tmpOut);
    const resp = await axios.get(fileUrl, { responseType: 'stream' }).catch(err => {
      console.error('CloudConvert download error', err && err.message, 'jobId=', jobId);
      throw new Error('CloudConvert download failed: ' + (err && err.message));
    });
    console.log('CloudConvert download response headers:', resp.headers);
    await new Promise((resolve, reject) => {
      resp.data.pipe(writer);
      resp.data.on('end', resolve);
      resp.data.on('error', reject);
    });
    downloadedPaths.push(tmpOut);
    console.log('CloudConvert: downloaded to', tmpOut, 'jobId=', jobId);
  }

  // Sanity: check downloaded extensions not all same as input ext
  try {
    const inputExt = path.extname(filePath).toLowerCase();
    const allSameAsInput = downloadedPaths.every(p => path.extname(p).toLowerCase() === inputExt);
    if (allSameAsInput) {
      console.error('CloudConvert: downloaded files have same extension as input — conversion likely failed', { jobId, inputExt, downloadedPaths });
      throw new Error('CloudConvert produced files with same extension as input (jobId=' + jobId + '). See server logs for jobStatus.');
    }
  } catch (e) {
    console.warn('CloudConvert sanity check triggered:', e && e.message);
  }

  return { downloadedPaths, jobId, jobStatus };
}

// ---------------- Conversion helpers ----------------

// convertImageBufferWithFallback: tries local sharp, or CloudConvert (HEIC forced)
async function convertImageBufferWithFallback(buffer, outFormat, quality, maxDim, originalName = 'input') {
  // Force CloudConvert for HEIC by name if available
  if (isHeicByName(originalName, null) && CLOUDCONVERT_API_KEY) {
    console.log('Forcing CloudConvert for HEIC', originalName);
    const tmpIn = path.join(UPLOAD_DIR, `tmp_in_${Date.now()}${path.extname(originalName) || '.heic'}`);
    fs.writeFileSync(tmpIn, buffer);
    try {
      const { downloadedPaths, jobId } = await cloudConvertFallbackConvert(tmpIn, outFormat, {});
      const outBuf = fs.readFileSync(downloadedPaths[0]);
      const outMime = mime.lookup(downloadedPaths[0]) || 'application/octet-stream';
      for (const p of downloadedPaths) try { fs.unlinkSync(p); } catch (e) {}
      try { fs.unlinkSync(tmpIn); } catch (e) {}
      return { buffer: outBuf, mime: outMime, cloudJobId: jobId };
    } catch (e) {
      try { fs.unlinkSync(tmpIn); } catch (_) {}
      throw e;
    }
  }

  // Try local sharp
  if (sharpAvailable) {
    try {
      let img = sharp(buffer, { animated: false }).rotate();
      try {
        const meta = await img.metadata().catch(()=>null);
        if (meta && Math.max(meta.width||0, meta.height||0) > maxDim) img = img.resize({ width: maxDim, height: maxDim, fit: 'inside' });
      } catch(_) {}
      const q = clampQuality(quality);
      const fmt = (outFormat||'jpeg').toLowerCase();

      if (fmt === 'jpeg' || fmt === 'jpg') {
        const outBuf = await img.flatten({ background: { r:255,g:255,b:255 } }).jpeg({ quality: q, mozjpeg: true }).toBuffer();
        return { buffer: outBuf, mime: 'image/jpeg' };
      }
      if (fmt === 'png') {
        const outBuf = await img.flatten({ background: { r:255,g:255,b:255 } }).png().toBuffer();
        return { buffer: outBuf, mime: 'image/png' };
      }
      if (fmt === 'webp') {
        const outBuf = await img.webp({ quality: q }).toBuffer();
        return { buffer: outBuf, mime: 'image/webp' };
      }
      if (fmt === 'avif') {
        const outBuf = await img.avif({ quality: q }).toBuffer();
        return { buffer: outBuf, mime: 'image/avif' };
      }
      if (fmt === 'tiff') {
        const outBuf = await img.tiff({ quality: q }).toBuffer();
        return { buffer: outBuf, mime: 'image/tiff' };
      }
      if (fmt === 'bmp') {
        const outBuf = await img.bmp().toBuffer();
        return { buffer: outBuf, mime: 'image/bmp' };
      }
      const fallbackBuf = await img.flatten({ background: { r:255,g:255,b:255 } }).png().toBuffer();
      return { buffer: fallbackBuf, mime: 'image/png' };
    } catch (e) {
      console.warn('Local sharp conversion failed, will try CloudConvert fallback:', e && e.message);
    }
  }

  // CloudConvert fallback
  if (!CLOUDCONVERT_API_KEY) throw new Error('No local sharp and CLOUDCONVERT_API_KEY not configured');
  const tmpIn = path.join(UPLOAD_DIR, `tmp_${Date.now()}_${Math.random().toString(36).slice(2,8)}${path.extname(originalName) || '.bin'}`);
  fs.writeFileSync(tmpIn, buffer);
  try {
    const { downloadedPaths, jobId } = await cloudConvertFallbackConvert(tmpIn, outFormat, {});
    if (!downloadedPaths || downloadedPaths.length === 0) throw new Error('CloudConvert produced no files');
    const outBuf = fs.readFileSync(downloadedPaths[0]);
    const outMime = mime.lookup(downloadedPaths[0]) || 'application/octet-stream';
    for (const p of downloadedPaths) try { fs.unlinkSync(p); } catch (e) {}
    try { fs.unlinkSync(tmpIn); } catch (e) {}
    return { buffer: outBuf, mime: outMime, cloudJobId: jobId };
  } catch (e) {
    try { fs.unlinkSync(tmpIn); } catch (_) {}
    throw e;
  }
}

// pdfToImagesBuffersWithFallback returns { bufs, cloudJobId } when using CloudConvert, or { bufs, cloudJobId:null } local
async function pdfToImagesBuffersWithFallback(pdfBuffer, outFormat, quality, maxDim, originalName = 'input.pdf') {
  // Try local sharp rasterization first
  if (sharpAvailable) {
    try {
      const results = [];
      let pageCount = 0;
      try { const doc = await PDFDocument.load(pdfBuffer); pageCount = doc.getPageCount(); } catch (e) { pageCount = 0; }
      if (pageCount <= 0) {
        const img = sharp(pdfBuffer, { density: 150 });
        try {
          const meta = await img.metadata().catch(()=>({}));
          if (meta && Math.max(meta.width||0, meta.height||0) > maxDim) img.resize({ width: maxDim, height: maxDim, fit: 'inside' });
        } catch(_) {}
        const buf = outFormat === 'png' ? await img.png().toBuffer() : await img.jpeg({ quality: clampQuality(quality) }).toBuffer();
        results.push(buf);
        return { bufs: results, cloudJobId: null };
      }
      for (let i = 0; i < pageCount; i++) {
        try {
          const pageImg = sharp(pdfBuffer, { density: 150, page: i });
          const meta = await pageImg.metadata().catch(()=>({}));
          if (meta && Math.max(meta.width||0, meta.height||0) > maxDim) pageImg.resize({ width: maxDim, height: maxDim, fit: 'inside' });
          const buf = outFormat === 'png' ? await pageImg.png().toBuffer() : await pageImg.jpeg({ quality: clampQuality(quality) }).toBuffer();
          results.push(buf);
        } catch (e) {
          console.warn('sharp rasterize page failed at index', i, e && e.message);
          break;
        }
      }
      if (results.length > 0) return { bufs: results, cloudJobId: null };
    } catch (e) {
      console.warn('Local PDF rasterization failed:', e && e.message);
    }
  }

  // CloudConvert fallback (force)
  if (!CLOUDCONVERT_API_KEY) throw new Error('Server cannot rasterize PDF locally and CLOUDCONVERT_API_KEY not configured');
  const tmpIn = path.join(UPLOAD_DIR, `tmp_pdf_${Date.now()}_${Math.random().toString(36).slice(2,8)}.pdf`);
  fs.writeFileSync(tmpIn, pdfBuffer);
  try {
    const { downloadedPaths, jobId } = await cloudConvertFallbackConvert(tmpIn, outFormat === 'png' ? 'png' : 'jpg', {});
    if (!downloadedPaths || downloadedPaths.length === 0) throw new Error('CloudConvert produced no files for PDF');
    const bufs = downloadedPaths.map(p => fs.readFileSync(p));
    for (const p of downloadedPaths) try { fs.unlinkSync(p); } catch (e) {}
    try { fs.unlinkSync(tmpIn); } catch (e) {}
    return { bufs, cloudJobId: jobId };
  } catch (e) {
    try { fs.unlinkSync(tmpIn); } catch (_) {}
    throw e;
  }
}

// imagesToPdf: robust embedding with JPEG then PNG fallback
async function imagesToPdf(buffers, quality, maxDim) {
  const pdfDoc = await PDFDocument.create();
  for (const buf of buffers) {
    let compressed = buf;
    try {
      const conv = await convertImageBufferWithFallback(buf, 'jpeg', quality, maxDim);
      compressed = conv.buffer || buf;
    } catch (e) {
      console.warn('Image conversion for PDF embedding failed, using original buffer:', e && e.message);
      compressed = buf;
    }

    try {
      // try embed as jpg
      try {
        const img = await pdfDoc.embedJpg(compressed);
        const page = pdfDoc.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        continue;
      } catch (jpgErr) {
        console.warn('embedJpg failed:', jpgErr && (jpgErr.message || jpgErr));
      }

      // try PNG re-encode and embed
      try {
        let pngBuf;
        if (sharpAvailable) {
          try {
            pngBuf = await sharp(compressed).flatten({ background: { r:255,g:255,b:255 } }).png().toBuffer();
          } catch (sErr) {
            console.warn('sharp re-encode to PNG failed:', sErr && sErr.message);
            pngBuf = null;
          }
        }
        if (!pngBuf) pngBuf = compressed;
        const imgPng = await pdfDoc.embedPng(pngBuf);
        const page = pdfDoc.addPage([imgPng.width, imgPng.height]);
        page.drawImage(imgPng, { x: 0, y: 0, width: imgPng.width, height: imgPng.height });
        continue;
      } catch (pngErr) {
        console.warn('PNG re-encode or embed failed:', pngErr && (pngErr.message || pngErr));
      }

      // fallback: page with note
      const p = pdfDoc.addPage([600, 800]);
      p.drawText('Could not embed image on this page (conversion failed).', { x: 40, y: 760, size: 10 });
    } catch (err) {
      console.error('Unexpected embed error:', err && (err.message || err));
      const p = pdfDoc.addPage([600, 800]);
      p.drawText('Could not embed image on this page (unexpected).', { x: 40, y: 760, size: 10 });
    }
  }
  return Buffer.from(await pdfDoc.save());
}

// ---------------- API: convert (bulk) ----------------
app.post('/api/convert', upload.array('files', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const targetFormat = (req.body.targetFormat || 'pdf').toLowerCase();
  const quality = clampQuality(req.body.quality || '80');
  const maxDim = parseInt(req.body.maxDim || String(MAX_DIMENSION), 10) || MAX_DIMENSION;
  const makeZip = req.body.zip === 'true' || req.body.zip === true || req.files.length > 1;
  const compressPdf = req.body.compress === 'true' || req.body.compress === true;

  const cloudJobIds = new Set();

  try {
    const outputs = [];
    const onlyImages = req.files.every(f => isImageMime(f.mimetype));

    if (targetFormat === 'pdf' && onlyImages && req.files.length >= 1) {
      const buffers = req.files.map(f => fs.readFileSync(f.path));
      const pdf = await imagesToPdf(buffers, quality, maxDim);
      outputs.push({ name: `${Date.now()}_${uuidv4()}.pdf`, buffer: pdf, mime: 'application/pdf' });
    } else {
      for (const f of req.files) {
        const inputBuffer = fs.readFileSync(f.path);
        const inMime = f.mimetype || mime.lookup(f.path) || 'application/octet-stream';
        const base = path.parse(f.originalname).name;

        if (isImageMime(inMime) || isHeicByName(f.originalname, inMime)) {
          if (targetFormat === 'pdf') {
            const pdf = await imagesToPdf([inputBuffer], quality, maxDim);
            outputs.push({ name: `${base}.pdf`, buffer: pdf, mime: 'application/pdf' });
          } else {
            try {
              const conv = await convertImageBufferWithFallback(inputBuffer, targetFormat, quality, maxDim, f.originalname);
              if (conv.cloudJobId) cloudJobIds.add(conv.cloudJobId);
              const ext = mime.extension(conv.mime) || targetFormat;
              outputs.push({ name: `${base}.${ext}`, buffer: conv.buffer, mime: conv.mime });
            } catch (e) {
              console.error('Image conversion failed for', f.originalname, e && e.message);
              outputs.push({ name: `${base}_original${path.extname(f.originalname)}`, buffer: inputBuffer, mime: inMime, note: e.message });
            }
          }
        } else if (isPdfMime(inMime, f.originalname)) {
          if (targetFormat === 'pdf') {
            if (!compressPdf) {
              outputs.push({ name: `${base}.pdf`, buffer: inputBuffer, mime: 'application/pdf' });
            } else {
              try {
                const { bufs, cloudJobId } = await pdfToImagesBuffersWithFallback(inputBuffer, 'jpg', quality, maxDim, f.originalname);
                if (cloudJobId) cloudJobIds.add(cloudJobId);
                if (!bufs || bufs.length === 0) throw new Error('Cannot rasterize PDF pages');
                const rebuilt = await imagesToPdf(bufs, quality, maxDim);
                outputs.push({ name: `${base}_compressed.pdf`, buffer: rebuilt, mime: 'application/pdf' });
              } catch (e) {
                console.error('PDF compress failed for', f.originalname, e && e.message);
                outputs.push({ name: `${base}_original.pdf`, buffer: inputBuffer, mime: 'application/pdf', note: e.message });
              }
            }
          } else {
            try {
              const { bufs, cloudJobId } = await pdfToImagesBuffersWithFallback(inputBuffer, (targetFormat === 'png' ? 'png' : 'jpg'), quality, maxDim, f.originalname);
              if (cloudJobId) cloudJobIds.add(cloudJobId);
              if (!bufs || bufs.length === 0) throw new Error('Unable to rasterize PDF pages');
              for (let i = 0; i < bufs.length; i++) {
                const ext = (targetFormat === 'png') ? 'png' : 'jpg';
                outputs.push({ name: `${base}_page${i+1}.${ext}`, buffer: bufs[i], mime: (ext === 'png' ? 'image/png' : 'image/jpeg') });
              }
            } catch (e) {
              console.error('PDF->images failed for', f.originalname, e && e.message);
              outputs.push({ name: `${base}_original.pdf`, buffer: inputBuffer, mime: 'application/pdf', note: e.message });
            }
          }
        } else {
          outputs.push({ name: f.originalname, buffer: inputBuffer, mime: inMime, note: 'Unknown input type, returned original.' });
        }
      }
    }

    for (const f of req.files) try { fs.unlinkSync(f.path); } catch (e) {}

    if (cloudJobIds.size > 0) {
      res.setHeader('X-CloudConvert-Jobs', Array.from(cloudJobIds).join(','));
      console.log('CloudConvert jobs used in this request:', Array.from(cloudJobIds));
    }

    if (makeZip || outputs.length > 1) {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="pdftool-${Date.now()}.zip"`);
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', err => { throw err; });
      archive.pipe(res);
      for (const out of outputs) archive.append(out.buffer, { name: out.name });
      await archive.finalize();
      return;
    } else {
      const o = outputs[0];
      res.setHeader('Content-Disposition', `attachment; filename="${o.name}"`);
      res.setHeader('Content-Type', o.mime || 'application/octet-stream');
      if (o.note) res.setHeader('X-Note', o.note);
      return res.send(o.buffer);
    }
  } catch (err) {
    console.error('Processing error:', err && (err.stack || err.message || err));
    try { if (req.files) for (const f of req.files) try { fs.unlinkSync(f.path); } catch(e) {} } catch(e){}
    return res.status(500).json({ error: 'Processing error', details: String(err && err.message ? err.message : err) });
  }
});

// ----- Diagnostics & test endpoints -----
app.get('/sharp-info', async (req, res) => {
  try {
    let info = { sharpInstalled: false };
    try {
      const s = require('sharp');
      info.sharpInstalled = true;
      info.versions = s.versions || {};
      info.formats = s.format || s.formats || null;
      info.vips = (s.versions && s.versions.vips) ? s.versions.vips : (info.versions && info.versions.vips) || null;
    } catch (e) {
      info.error = String(e.message || e);
    }
    return res.json({ ok: true, info });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// test-convert: single file quick test (field 'file', optional 'out')
app.post('/test-convert', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok:false, error: 'No file uploaded (field name must be \"file\")' });
  const outFormat = (req.body.out || 'jpeg').toLowerCase();
  const quality = clampQuality(req.body.quality || '80');
  const maxDim = parseInt(req.body.maxDim || String(MAX_DIMENSION), 10) || MAX_DIMENSION;

  const filePath = req.file.path;
  const originalName = req.file.originalname;
  const inputBuffer = fs.readFileSync(filePath);
  let usedCloudJobs = [];

  try {
    // image -> pdf
    if (outFormat === 'pdf' && isImageMime(req.file.mimetype)) {
      const pdfBuf = await imagesToPdf([inputBuffer], quality, maxDim);
      res.setHeader('Content-Disposition', `attachment; filename="${path.parse(originalName).name}_test.pdf"`);
      res.setHeader('Content-Type', 'application/pdf');
      return res.send(pdfBuf);
    }

    // pdf -> image(s)
    if (isPdfMime(req.file.mimetype, originalName) && outFormat !== 'pdf') {
      const r = await pdfToImagesBuffersWithFallback(inputBuffer, (outFormat === 'png' ? 'png' : 'jpg'), quality, maxDim, originalName);
      const bufs = r && r.bufs ? r.bufs : (Array.isArray(r) ? r : null);
      const cloudJobId = r && r.cloudJobId ? r.cloudJobId : null;
      if (cloudJobId) usedCloudJobs.push(cloudJobId);
      if (!bufs || bufs.length === 0) throw new Error('No image pages produced');
      res.setHeader('X-Test-Pages', String(bufs.length));
      if (usedCloudJobs.length) res.setHeader('X-CloudConvert-Jobs', usedCloudJobs.join(','));
      res.setHeader('Content-Disposition', `attachment; filename="${path.parse(originalName).name}_page1.${outFormat === 'png' ? 'png' : 'jpg'}"`);
      res.setHeader('Content-Type', outFormat === 'png' ? 'image/png' : 'image/jpeg');
      return res.send(bufs[0]);
    }

    // image -> image
    if (isImageMime(req.file.mimetype) || isHeicByName(originalName, req.file.mimetype)) {
      const conv = await convertImageBufferWithFallback(inputBuffer, outFormat, quality, maxDim, originalName);
      if (conv && conv.cloudJobId) usedCloudJobs.push(conv.cloudJobId);
      if (usedCloudJobs.length) res.setHeader('X-CloudConvert-Jobs', usedCloudJobs.join(','));
      res.setHeader('Content-Disposition', `attachment; filename="${path.parse(originalName).name}_test.${outFormat === 'jpg' ? 'jpg' : outFormat}"`);
      res.setHeader('Content-Type', conv.mime || mime.lookup(outFormat) || 'application/octet-stream');
      return res.send(conv.buffer);
    }

    // fallback
    res.setHeader('Content-Disposition', `attachment; filename="${originalName}"`);
    return res.send(inputBuffer);
  } catch (e) {
    console.error('test-convert error:', e && (e.stack || e.message || e));
    try { fs.unlinkSync(filePath); } catch (_) {}
    return res.status(500).json({ ok:false, error: String(e.message || e) });
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`pdftool-cloudconvert-final server listening on port ${PORT}`);
});