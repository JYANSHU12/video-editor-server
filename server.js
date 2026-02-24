const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Configure FFmpeg paths BEFORE loading routes
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

console.log('📍 FFmpeg path:', ffmpegPath);
console.log('📍 FFprobe path:', ffprobePath);

const videoRoutes = require('./routes/video');

const app = express();
const PORT = process.env.PORT || 5000;

// Ensure directories exist
const uploadsDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'processed');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });

// ─── Auto-cleanup: delete files older than 15 minutes ───
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;   // check every 5 min
const MAX_FILE_AGE_MS = 15 * 60 * 1000;   // delete after 15 min

function cleanupOldFiles(directory) {
  try {
    const files = fs.readdirSync(directory);
    const now = Date.now();
    let cleaned = 0;
    for (const file of files) {
      const filePath = path.join(directory, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && (now - stat.mtimeMs) > MAX_FILE_AGE_MS) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch (e) { /* ignore individual file errors */ }
    }
    if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} old file(s) from ${path.basename(directory)}/`);
  } catch (e) { /* ignore */ }
}

setInterval(() => {
  cleanupOldFiles(uploadsDir);
  cleanupOldFiles(processedDir);
}, CLEANUP_INTERVAL_MS);

// Run once on startup after 60 seconds
setTimeout(() => {
  cleanupOldFiles(uploadsDir);
  cleanupOldFiles(processedDir);
}, 60 * 1000);

// CORS - allow all origins in production (or specific frontend URL)
const allowedOrigins = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3000']
  : '*';

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Range', 'Authorization'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
  credentials: false
}));

// Reduced JSON body limit (commands are tiny, videos go via multer)
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(uploadsDir));
app.use('/processed', express.static(processedDir));

// ─── Memory logging middleware ───
app.use((req, res, next) => {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(1);
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);
  console.log(`📊 [${req.method} ${req.path}] RSS: ${rss}MB | Heap: ${heap}MB`);
  next();
});

// Routes
app.use('/api', videoRoutes);

// Health check
app.get('/api/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    message: 'Video Editor API is running',
    ffmpeg: ffmpegPath ? 'configured' : 'missing',
    ffprobe: ffprobePath ? 'configured' : 'missing',
    memory: {
      rss: `${(mem.rss / 1024 / 1024).toFixed(1)}MB`,
      heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`,
      heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(1)}MB`
    }
  });
});

// Root route
app.get('/', (req, res) => {
  res.json({ message: 'Video Editor API Server', health: '/api/health' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Video Editor Server running on port ${PORT}`);
  console.log(`📁 Uploads dir: ${uploadsDir}`);
  console.log(`📁 Processed dir: ${processedDir}`);
  const mem = process.memoryUsage();
  console.log(`📊 Startup memory — RSS: ${(mem.rss / 1024 / 1024).toFixed(1)}MB | Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`);
});
