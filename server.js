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

app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(uploadsDir));
app.use('/processed', express.static(processedDir));

// Routes
app.use('/api', videoRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Video Editor API is running',
    ffmpeg: ffmpegPath ? 'configured' : 'missing',
    ffprobe: ffprobePath ? 'configured' : 'missing'
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
});
