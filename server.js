// server.js - Clean converter/compressor with CloudConvert fallback for hosts without sharp/libvips
// Paste this file into your project root (overwrite existing server.js).
// Make sure to set CLOUDCONVERT_API_KEY in cPanel env vars and run "Run NPM Install" after updating package.json.

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

// Health route
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    app: 'pdftool-clean-cloudconvert',
    uptime_seconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Try to require sharp; if unavailable we will use CloudConvert fallback
let sharp = null;
let sharpAvailable = false;
try {
  sharp = require('sharp');
  sharpAvailable = true;
} catch (e) {
  console.warn('sharp not available locally:', e.message);
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
function isPdfMime(m, name) { return m === 'application/pdf' || (name && path.extname(name).toLowerCase() === '.pdf'); }
function clampQuality(q) { const n = parseInt(q || '80', 10); return Math.max(10, Math.min(95, isNaN(n) ? 80 : n)); }

// CloudConvert helper: upload -> convert -> download results
// Returns array of output file paths (downloaded to same dir as input)
async function cloudConvertFallbackConvert(filePath, outputFormat, options = {}) {
  if (!CLOUDCONVERT_API_KEY) throw new Error('CLOUDCONVERT_API_KEY not configured');
  const headers = { Authorization: `Bearer ${CLOUDCONVERT_API_KEY}` };

  // 1) create job with import/upload, convert, export/url
  const jobSpec = {
    tasks: {
      'import-my-file': { operation: 'import/upload' },
      'convert-my-file': {
        operation: 'convert',
        input: ['import-my-file'],
        output_format: outputFormat,
        // you can pass more conversion options via options.convertOptions
        ...(options.convertOptions || {})
      },
      'export-my-file': { operation: 'export/url', input: ['convert-my-file'] }
    }
  };

  const jobResp = await axios.post(`${CLOUDCONVERT_BASE}/jobs`, jobSpec, { headers });
  if (!jobResp.data || !jobResp.data.data) throw new Error('CloudConvert: failed to create job');
  const job = jobResp.data.data;

  // find import task upload info
  const importTask = (job.tasks || []).find(t => t.name === 'import-my-file' && t.type === 'import/upload');
  if (!importTask || !importTask.result || !importTask.result.form) throw new Error('CloudConvert: upload details missing');

  const uploadUrl = importTask.result.form.url;
  const uploadParams = importTask.result.form.parameters || {};

  // 2) upload file to provided form
  const uploadForm = new FormData();
  Object.keys(uploadParams).forEach(k => uploadForm.append(k, uploadParams[k]));
  uploadForm.append('file', fs.createReadStream(filePath));

  await axios.post(uploadUrl, uploadForm, { headers: uploadForm.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity });

  // 3) poll job status until finished
  const jobId = job.id;
  const pollUrl = `${CLOUDCONVERT_BASE}/jobs/${jobId}`;
  let finished = false;
  let jobStatus = null;
  const maxPolls = 60; // ~2 minutes
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await axios.get(pollUrl, { headers });
    jobStatus = r.data && r.data.data;
    if (!jobStatus) continue;
    if (jobStatus.status === 'finished') { finished = true; break; }
    if (jobStatus.status === 'error' || jobStatus.status === 'failed') {
      throw new Error('CloudConvert job failed: ' + JSON.stringify(jobStatus));
    }
  }
  if (!finished) throw new Error('CloudConvert job did not finish in time');

  // 4) find export task and download result files
  const exportTask = (jobStatus.tasks || []).find(t => t.name === 'export-my-file' && t.status === 'finished');
  if (!exportTask || !exportTask.result || !exportTask.result.files || exportTask.result.files.length === 0) {
    throw new Error('CloudConvert: no export files found');
  }

  const downloadedPaths = [];
  for (const fileMeta of exportTask.result.files) {
    const fileUrl = fileMeta.url;
    const outExt = path.extname(fileMeta.filename) || `.${outputFormat}`;
    const tmpOut = path.join(path.dirname(filePath), `${path.parse(filePath).name}_cloudconv_${Date.now()}_${Math.random().toString(36).slice(2,8)}${outExt}`);
    const writer = fs.createWriteStream(tmpOut);
    const resp = await axios.get(fileUrl, { responseType: 'stream' });
    await new Promise((resolve, reject) => {
      resp.data.pipe(writer);
      resp.data.on('end', resolve);
      resp.data.on('error', reject);
    });
    downloadedPaths.push(tmpOut);
  }

  return downloadedPaths;
}

// Image conversion using sharp if available, otherwise CloudConvert fallback
async function convertImageBufferWithFallback(buffer, outFormat, quality, maxDim, originalName = 'input') {
  // If sharp available, try local conversion
  if (sharpAvailable) {
    try {
      let img = sharp(buffer, { animated: false }).rotate();
      try {
        const meta = await img.metadata().catch(()=>null);
        if (meta && Math.max(meta.width||0, meta.height||0) > maxDim) img = img.resize({ width: maxDim, height: maxDim, fit: 'inside' });
      } catch (_) {}
      const q = clampQuality(quality);
      const fmt = (outFormat||'jpeg').toLowerCase();
      if (fmt === 'jpeg' || fmt === 'jpg') return { buffer: await img.jpeg({ quality: q }).toBuffer(), mime: 'image/jpeg' };
      if (fmt === 'png') return { buffer: await img.png().toBuffer(), mime: 'image/png' };
      if (fmt === 'webp') return { buffer: await img.webp({ quality: q }).toBuffer(), mime: 'image/webp' };
      if (fmt === 'avif') return { buffer: await img.avif({ quality: q }).toBuffer(), mime: 'image/avif' };
      if (fmt === 'tiff') return { buffer: await img.tiff({ quality: q }).toBuffer(), mime: 'image/tiff' };
      if (fmt === 'bmp') return { buffer: await img.bmp().toBuffer(), mime: 'image/bmp' };
      // fallback
      return { buffer: await img.png().toBuffer(), mime: 'image/png' };
    } catch (e) {
      console.warn('Local sharp conversion failed, falling back to CloudConvert:', e.message);
      // fall through to cloud fallback
    }
  }

  // CloudConvert fallback: write buffer to temp file and convert
  if (!CLOUDCONVERT_API_KEY) throw new Error('No local sharp and CLOUDCONVERT_API_KEY not configured');
  const tmpIn = path.join(UPLOAD_DIR, `tmp_${Date.now()}_${Math.random().toString(36).slice(2,8)}${path.extname(originalName) || '.bin'}`);
  fs.writeFileSync(tmpIn, buffer);
  try {
    const outPaths = await cloudConvertFallbackConvert(tmpIn, outFormat, { convertOptions: {} });
    if (!outPaths || outPaths.length === 0) throw new Error('CloudConvert produced no files');
    const outBuf = fs.readFileSync(outPaths[0]);
    const outMime = mime.lookup(outPaths[0]) || 'application/octet-stream';
    // cleanup downloaded converted files
    for (const p of outPaths) try { fs.unlinkSync(p); } catch (e) {}
    // cleanup tmp input
    try { fs.unlinkSync(tmpIn); } catch (e) {}
    return { buffer: outBuf, mime: outMime };
  } catch (e) {
    // cleanup tmp input on error
    try { fs.unlinkSync(tmpIn); } catch (err) {}
    throw e;
  }
}

// Rasterize PDF pages to image buffers (sharp preferred, otherwise CloudConvert fallback)
async function pdfToImagesBuffersWithFallback(pdfBuffer, outFormat, quality, maxDim, originalName = 'input.pdf') {
  // Try local method first
  if (sharpAvailable) {
    try {
      const results = [];
      // Try to determine page count via pdf-lib
      let pageCount = 0;
      try { const doc = await PDFDocument.load(pdfBuffer); pageCount = doc.getPageCount(); } catch (e) { pageCount = 0; }
      if (pageCount <= 0) {
        // Try one-page rasterize
        const img = sharp(pdfBuffer, { density: 150 });
        try {
          const meta = await img.metadata().catch(()=>({}));
          if (meta && Math.max(meta.width||0, meta.height||0) > maxDim) img.resize({ width: maxDim, height: maxDim, fit: 'inside' });
        } catch(_) {}
        const buf = outFormat === 'png' ? await img.png().toBuffer() : await img.jpeg({ quality: clampQuality(quality) }).toBuffer();
        results.push(buf);
        return results;
      }
      for (let i = 0; i < pageCount; i++) {
        try {
          const pageImg = sharp(pdfBuffer, { density: 150, page: i });
          const meta = await pageImg.metadata().catch(()=>({}));
          if (meta && Math.max(meta.width||0, meta.height||0) > maxDim) pageImg.resize({ width: maxDim, height: maxDim, fit: 'inside' });
          const buf = outFormat === 'png' ? await pageImg.png().toBuffer() : await pageImg.jpeg({ quality: clampQuality(quality) }).toBuffer();
          results.push(buf);
        } catch (e) {
          console.warn('sharp rasterize page failed at index', i, e.message);
          break;
        }
      }
      if (results.length > 0) return results;
    } catch (e) {
      console.warn('Local PDF rasterization failed:', e.message);
    }
  }

  // CloudConvert fallback
  if (!CLOUDCONVERT_API_KEY) throw new Error('Server cannot rasterize PDF locally and CLOUDCONVERT_API_KEY not configured');
  const tmpIn = path.join(UPLOAD_DIR, `tmp_pdf_${Date.now()}_${Math.random().toString(36).slice(2,8)}.pdf`);
  fs.writeFileSync(tmpIn, pdfBuffer);
  try {
    // CloudConvert convert to zip of images; we request "jpg" or "png" output
    const outFormat = (outFormat || 'jpg').toLowerCase();
    const outPaths = await cloudConvertFallbackConvert(tmpIn, outFormat, { convertOptions: {} });
    if (!outPaths || outPaths.length === 0) throw new Error('CloudConvert produced no files');
    const bufs = outPaths.map(p => fs.readFileSync(p));
    // cleanup outPaths and tmpIn
    for (const p of outPaths) try { fs.unlinkSync(p); } catch (e) {}
    try { fs.unlinkSync(tmpIn); } catch (e) {}
    return bufs;
  } catch (e) {
    try { fs.unlinkSync(tmpIn); } catch (err) {}
    throw e;
  }
}

// Build multi-page PDF from image buffers (uses pdf-lib)
async function imagesToPdf(buffers, quality, maxDim) {
  const pdfDoc = await PDFDocument.create();
  for (const buf of buffers) {
    let compressed = buf;
    try {
      const conv = await convertImageBufferWithFallback(buf, 'jpeg', quality, maxDim);
      compressed = conv.buffer;
    } catch (e) {
      // fallback keep original
      compressed = buf;
    }
    try {
      const img = await pdfDoc.embedJpg(compressed).catch(async () => await pdfDoc.embedPng(compressed));
      const page = pdfDoc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    } catch (e) {
      const page = pdfDoc.addPage([600, 800]);
      page.drawText('Could not embed image on this page', { x: 40, y: 760, size: 10 });
    }
  }
  return Buffer.from(await pdfDoc.save());
}

// API: convert (bulk)
app.post('/api/convert', upload.array('files', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const targetFormat = (req.body.targetFormat || 'pdf').toLowerCase();
  const quality = clampQuality(req.body.quality || '80');
  const maxDim = parseInt(req.body.maxDim || String(MAX_DIMENSION), 10) || MAX_DIMENSION;
  const makeZip = req.body.zip === 'true' || req.body.zip === true || req.files.length > 1;
  const compressPdf = req.body.compress === 'true' || req.body.compress === true;

  try {
    const outputs = [];
    const onlyImages = req.files.every(f => isImageMime(f.mimetype));

    // Multiple images -> single multi-page PDF
    if (targetFormat === 'pdf' && onlyImages && req.files.length >= 1) {
      const buffers = req.files.map(f => fs.readFileSync(f.path));
      const pdf = await imagesToPdf(buffers, quality, maxDim);
      const name = `${Date.now()}_${uuidv4()}.pdf`;
      outputs.push({ name, buffer: pdf, mime: 'application/pdf' });
    } else {
      // process each file
      for (const f of req.files) {
        const inputBuffer = fs.readFileSync(f.path);
        const inMime = f.mimetype || mime.lookup(f.path) || 'application/octet-stream';
        const base = path.parse(f.originalname).name;

        if (isImageMime(inMime)) {
          if (targetFormat === 'pdf') {
            const pdf = await imagesToPdf([inputBuffer], quality, maxDim);
            outputs.push({ name: `${base}.pdf`, buffer: pdf, mime: 'application/pdf' });
          } else {
            try {
              const conv = await convertImageBufferWithFallback(inputBuffer, targetFormat, quality, maxDim, f.originalname);
              const ext = mime.extension(conv.mime) || targetFormat;
              outputs.push({ name: `${base}.${ext}`, buffer: conv.buffer, mime: conv.mime });
            } catch (e) {
              outputs.push({ name: `${base}_original${path.extname(f.originalname)}`, buffer: inputBuffer, mime: inMime, note: e.message });
            }
          }
        } else if (isPdfMime(inMime, f.originalname)) {
          if (targetFormat === 'pdf') {
            if (!compressPdf) {
              outputs.push({ name: `${base}.pdf`, buffer: inputBuffer, mime: 'application/pdf' });
            } else {
              try {
                const imgs = await pdfToImagesBuffersWithFallback(inputBuffer, 'jpg', quality, maxDim, f.originalname);
                if (!imgs || imgs.length === 0) throw new Error('Cannot rasterize PDF pages');
                const rebuilt = await imagesToPdf(imgs, quality, maxDim);
                outputs.push({ name: `${base}_compressed.pdf`, buffer: rebuilt, mime: 'application/pdf' });
              } catch (e) {
                outputs.push({ name: `${base}_original.pdf`, buffer: inputBuffer, mime: 'application/pdf', note: e.message });
              }
            }
          } else {
            try {
              const imgs = await pdfToImagesBuffersWithFallback(inputBuffer, (targetFormat === 'png' ? 'png' : 'jpg'), quality, maxDim, f.originalname);
              if (!imgs || imgs.length === 0) throw new Error('Unable to rasterize PDF pages');
              for (let i = 0; i < imgs.length; i++) {
                const ext = (targetFormat === 'png') ? 'png' : 'jpg';
                outputs.push({ name: `${base}_page${i+1}.${ext}`, buffer: imgs[i], mime: (ext === 'png' ? 'image/png' : 'image/jpeg') });
              }
            } catch (e) {
              outputs.push({ name: `${base}_original.pdf`, buffer: inputBuffer, mime: 'application/pdf', note: e.message });
            }
          }
        } else {
          outputs.push({ name: f.originalname, buffer: inputBuffer, mime: inMime, note: 'Unknown input type, returned original.' });
        }
      }
    }

    // cleanup uploaded files
    for (const f of req.files) try { fs.unlinkSync(f.path); } catch (e) {}

    // send outputs
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
    console.error('Processing error:', err);
    try { if (req.files) for (const f of req.files) try { fs.unlinkSync(f.path); } catch(e) {} } catch(e){}
    return res.status(500).json({ error: 'Processing error', details: String(err && err.message ? err.message : err) });
  }
});

// Simple results listing (optional)
app.get('/api/results', (req, res) => {
  try {
    const files = fs.readdirSync(RESULTS_DIR).map(n => {
      const s = fs.statSync(path.join(RESULTS_DIR, n));
      return { name: n, size: s.size, mtime: s.mtime };
    }).sort((a,b) => b.mtime - a.mtime);
    res.json({ ok: true, files });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`pdftool-clean server listening on port ${PORT}`);
});