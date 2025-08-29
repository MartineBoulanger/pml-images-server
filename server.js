import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const domainUrl = 'https://pml-images-server.onrender.com';

// ===== Config =====
const PORT = 4000; // use 4000 to avoid Next.js 3000
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_FILE = path.join(DATA_DIR, 'images.json');
const CORS_ORIGINS = (
  process.env.CORS_ORIGINS || 'http://localhost:4000'
).split(',');
const API_KEY = process.env.API_KEY || ''; // optional simple auth

// ===== Bootstrapping =====
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDirSync(DATA_DIR);
ensureDirSync(UPLOADS_DIR);
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf-8');

async function readDB() {
  const raw = await fsp.readFile(DATA_FILE, 'utf-8');
  return JSON.parse(raw);
}
async function writeDB(data) {
  const tmp = DATA_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, DATA_FILE);
}

// ===== Express app =====
const app = express();
app.use(express.json());
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // allow server-to-server or curl
      const ok = CORS_ORIGINS.includes(origin);
      cb(ok ? null : new Error('CORS blocked'), ok);
    },
    credentials: false,
  })
);

// optional, simple API key check (set API_KEY to enable)
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const key = req.header('x-api-key');
  if (key && key === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
});

// Serve static images
app.use('/uploads', express.static(UPLOADS_DIR));

// ===== Multer (upload) =====
const allowedTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/svg+xml',
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, '_');
      cb(null, safeName);
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (allowedTypes.has(file.mimetype)) cb(null, true);
    else cb(new Error('Unsupported file type'));
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ===== Helpers =====
function normalizeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags))
    return tags
      .map(String)
      .map((t) => t.trim())
      .filter(Boolean);
  if (typeof tags === 'string')
    return tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

function toPublicUrl(filename) {
  return `${domainUrl}/uploads/${filename}`; // behind a proxy, prefix with your domain
}

// ===== Routes =====
// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Upload image + metadata
app.post('/api/images', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const {
      width = 0,
      height = 0,
      alt = '',
      tags = [],
      custom = {},
    } = req.body;
    const record = {
      id: randomUUID(),
      filename: req.file.filename,
      url: toPublicUrl(req.file.filename),
      title: req.file.filename.split('.')[0],
      alt: String(alt),
      tags: normalizeTags(tags),
      custom: (() => {
        try {
          return typeof custom === 'string' ? JSON.parse(custom) : custom;
        } catch {
          return {};
        }
      })(),
      size: req.file.size,
      width: String(width),
      height: String(height),
      mimetype: req.file.mimetype,
      uploadedAt: new Date().toISOString(),
    };

    const db = await readDB();
    db.push(record);
    await writeDB(db);

    res.status(201).json(record);
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Upload failed' });
  }
});

// List images with basic search/pagination
app.get('/api/images', async (req, res) => {
  const { search = '', tag = '', page = '1', limit = '20' } = req.query;
  const p = Math.max(1, parseInt(page));
  const l = Math.min(100, Math.max(1, parseInt(limit)));

  const db = await readDB();
  let items = db;
  if (search) {
    const q = String(search).toLowerCase();
    items = items.filter(
      (r) =>
        r.title?.toLowerCase().includes(q) ||
        r.alt?.toLowerCase().includes(q) ||
        r.tags?.some((t) => t.toLowerCase().includes(q))
    );
  }
  if (tag) {
    const t = String(tag).toLowerCase();
    items = items.filter((r) =>
      r.tags?.map((x) => x.toLowerCase()).includes(t)
    );
  }
  const total = items.length;
  const start = (p - 1) * l;
  const paged = items.slice(start, start + l);

  res.json({ items: paged, total, page: p, limit: l });
});

// Get one
app.get('/api/images/:id', async (req, res) => {
  const db = await readDB();
  const item = db.find((r) => r.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

// Update metadata
app.patch('/api/images/:id', async (req, res) => {
  const db = await readDB();
  const idx = db.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const body = req.body || {};
  const curr = db[idx];
  const next = {
    ...curr,
    title: body.title !== undefined ? String(body.title) : curr.title,
    alt: body.alt !== undefined ? String(body.alt) : curr.alt,
    tags: body.tags !== undefined ? normalizeTags(body.tags) : curr.tags,
    custom: body.custom !== undefined ? body.custom : curr.custom,
    updatedAt: new Date().toISOString(),
  };

  db[idx] = next;
  await writeDB(db);
  res.json(next);
});

// Replace image file (optional separate endpoint)
app.post('/api/images/:id/file', upload.single('image'), async (req, res) => {
  const db = await readDB();
  const idx = db.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // delete old file (best-effort)
  const prev = db[idx];
  try {
    await fsp.unlink(path.join(UPLOADS_DIR, prev.filename));
  } catch {}

  prev.filename = req.file.filename;
  prev.url = toPublicUrl(req.file.filename);
  prev.size = req.file.size;
  prev.mimetype = req.file.mimetype;
  prev.updatedAt = new Date().toISOString();

  db[idx] = prev;
  await writeDB(db);
  res.json(prev);
});

// Delete
app.delete('/api/images/:id', async (req, res) => {
  const db = await readDB();
  const idx = db.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [removed] = db.splice(idx, 1);
  await writeDB(db);

  // best-effort remove the file
  try {
    await fsp.unlink(path.join(UPLOADS_DIR, removed.filename));
  } catch {}

  res.json({ ok: true, id: removed.id });
});

app.listen(PORT, () => {
  console.log(
    `✅ Image CMS API running on ${domainUrl} or http://localhost:${PORT}`
  );
});
