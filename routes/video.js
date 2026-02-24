const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// Directories
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const PROCESSED_DIR = path.join(__dirname, '..', 'processed');

// Multer config
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${uuidv4()}${ext}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /video|audio/;
        if (allowed.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only video/audio files are allowed'), false);
        }
    }
});

// Helper: find a system font that works on Windows
function getSystemFont() {
    const candidates = [
        'C:/Windows/Fonts/arial.ttf',
        'C:/Windows/Fonts/segoeui.ttf',
        'C:/Windows/Fonts/tahoma.ttf',
        'C:/Windows/Fonts/verdana.ttf',
        'C:/Windows/Fonts/calibri.ttf',
    ];
    for (const f of candidates) {
        if (fs.existsSync(f)) return f.replace(/\\/g, '/').replace(/:/g, '\\\\:');
    }
    return null;
}

// ─── Upload Video ───
router.post('/upload', upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const filePath = req.file.filename;
    const fullPath = path.join(UPLOADS_DIR, filePath);

    // Get video metadata
    ffmpeg.ffprobe(fullPath, (err, metadata) => {
        if (err) {
            console.warn('FFprobe warning (video still uploaded):', err.message);
            return res.json({
                success: true,
                filename: filePath,
                originalName: req.file.originalname,
                size: req.file.size,
                duration: 0,
                width: 0,
                height: 0
            });
        }

        const videoStream = (metadata.streams || []).find(s => s.codec_type === 'video') || {};
        res.json({
            success: true,
            filename: filePath,
            originalName: req.file.originalname,
            size: req.file.size,
            duration: metadata.format.duration || 0,
            width: videoStream.width || 0,
            height: videoStream.height || 0
        });
    });
});

// ─── Upload Multiple Videos (for merge) ───
router.post('/upload-multiple', upload.array('videos', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }

    const files = req.files.map(f => ({
        filename: f.filename,
        originalName: f.originalname,
        size: f.size
    }));

    res.json({ success: true, files });
});

// ─── Stream Video ───
router.get('/video/:filename', (req, res) => {
    const filePath = path.join(UPLOADS_DIR, req.params.filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = end - start + 1;
        const file = fs.createReadStream(filePath, { start, end });
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
        });
        file.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
        });
        fs.createReadStream(filePath).pipe(res);
    }
});

// ─── Stream Processed Video ───
router.get('/processed-video/:filename', (req, res) => {
    const filePath = path.join(PROCESSED_DIR, req.params.filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = end - start + 1;
        const file = fs.createReadStream(filePath, { start, end });
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
        });
        file.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
        });
        fs.createReadStream(filePath).pipe(res);
    }
});

// ─── Trim Video ───
router.post('/trim', (req, res) => {
    const { filename, startTime, endTime } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const inputPath = path.join(UPLOADS_DIR, filename);
    const outputFilename = `trimmed_${uuidv4()}.mp4`;
    const outputPath = path.join(PROCESSED_DIR, outputFilename);

    if (!fs.existsSync(inputPath)) {
        return res.status(404).json({ error: 'Input file not found' });
    }

    console.log(`✂️ Trimming: ${filename} from ${startTime}s to ${endTime}s`);

    const cmd = ffmpeg(inputPath)
        .setStartTime(startTime || 0)
        .outputOptions(['-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast', '-movflags', '+faststart']);

    if (endTime) {
        cmd.setDuration(endTime - (startTime || 0));
    }

    cmd.output(outputPath)
        .on('progress', (progress) => {
            if (progress.percent) console.log(`  ✂️ Trim progress: ${Math.round(progress.percent)}%`);
        })
        .on('end', () => {
            console.log(`  ✂️ Trim complete: ${outputFilename}`);
            res.json({ success: true, filename: outputFilename, message: 'Video trimmed successfully' });
        })
        .on('error', (err) => {
            console.error('Trim error:', err.message);
            res.status(500).json({ error: 'Failed to trim video', details: err.message });
        })
        .run();
});

// ─── Apply Filter ───
router.post('/filter', (req, res) => {
    const { filename, filter } = req.body;
    if (!filename || !filter) return res.status(400).json({ error: 'filename and filter required' });

    const inputPath = path.join(UPLOADS_DIR, filename);
    const outputFilename = `filtered_${uuidv4()}.mp4`;
    const outputPath = path.join(PROCESSED_DIR, outputFilename);

    if (!fs.existsSync(inputPath)) {
        return res.status(404).json({ error: 'Input file not found' });
    }

    const filterMap = {
        grayscale: 'colorchannelmixer=.3:.4:.3:0:.3:.4:.3:0:.3:.4:.3',
        sepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
        blur: 'boxblur=5:1',
        sharpen: 'unsharp=5:5:1.0:5:5:0.0',
        brightness: 'eq=brightness=0.15',
        contrast: 'eq=contrast=1.5',
        saturate: 'eq=saturation=2.0',
        vignette: 'vignette=PI/4',
        vintage: 'curves=vintage',
        negative: 'negate',
        mirror: 'hflip',
        emboss: 'convolution=-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2'
    };

    const videoFilter = filterMap[filter];
    if (!videoFilter) return res.status(400).json({ error: `Unknown filter: ${filter}` });

    console.log(`🎨 Applying filter '${filter}' to: ${filename}`);

    ffmpeg(inputPath)
        .videoFilters(videoFilter)
        .outputOptions(['-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast', '-movflags', '+faststart'])
        .output(outputPath)
        .on('progress', (progress) => {
            if (progress.percent) console.log(`  🎨 Filter progress: ${Math.round(progress.percent)}%`);
        })
        .on('end', () => {
            console.log(`  🎨 Filter complete: ${outputFilename}`);
            res.json({ success: true, filename: outputFilename, message: `Filter '${filter}' applied successfully` });
        })
        .on('error', (err) => {
            console.error('Filter error:', err.message);
            res.status(500).json({ error: 'Failed to apply filter', details: err.message });
        })
        .run();
});

// ─── Add Text Overlay ───
router.post('/text', (req, res) => {
    const { filename, text, fontSize, fontColor, x, y, startTime, endTime } = req.body;
    if (!filename || !text) return res.status(400).json({ error: 'filename and text required' });

    const inputPath = path.join(UPLOADS_DIR, filename);
    const outputFilename = `text_${uuidv4()}.mp4`;
    const outputPath = path.join(PROCESSED_DIR, outputFilename);

    if (!fs.existsSync(inputPath)) {
        return res.status(404).json({ error: 'Input file not found' });
    }

    const size = fontSize || 32;
    const color = (fontColor || 'white').replace('#', '0x');
    const posX = x || '(w-text_w)/2';
    const posY = y || '(h-text_h)/2';

    // Escape special chars for drawtext filter
    const escapedText = text
        .replace(/\\/g, '\\\\\\\\')
        .replace(/'/g, "'\\\\\\''")
        .replace(/:/g, '\\:')
        .replace(/;/g, '\\;');

    // Build drawtext filter - fontfile is required on Windows
    const fontFile = getSystemFont();
    let drawTextFilter = `drawtext=text='${escapedText}':fontsize=${size}:fontcolor=${color}:x=${posX}:y=${posY}`;

    if (fontFile) {
        drawTextFilter = `drawtext=fontfile='${fontFile}':text='${escapedText}':fontsize=${size}:fontcolor=${color}:x=${posX}:y=${posY}`;
    }

    if (startTime !== undefined && endTime !== undefined) {
        drawTextFilter += `:enable='between(t,${startTime},${endTime})'`;
    }

    console.log(`🔤 Adding text '${text}' to: ${filename}`);

    ffmpeg(inputPath)
        .videoFilters(drawTextFilter)
        .outputOptions(['-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast', '-movflags', '+faststart'])
        .output(outputPath)
        .on('progress', (progress) => {
            if (progress.percent) console.log(`  🔤 Text progress: ${Math.round(progress.percent)}%`);
        })
        .on('end', () => {
            console.log(`  🔤 Text complete: ${outputFilename}`);
            res.json({ success: true, filename: outputFilename, message: 'Text overlay added successfully' });
        })
        .on('error', (err) => {
            console.error('Text error:', err.message);
            res.status(500).json({ error: 'Failed to add text', details: err.message });
        })
        .run();
});

// ─── Merge Videos ───
router.post('/merge', (req, res) => {
    const { filenames } = req.body;
    if (!filenames || filenames.length < 2) {
        return res.status(400).json({ error: 'At least 2 filenames required' });
    }

    // Verify all files exist
    for (const f of filenames) {
        const fp = path.join(UPLOADS_DIR, f);
        if (!fs.existsSync(fp)) {
            return res.status(404).json({ error: `File not found: ${f}` });
        }
    }

    const outputFilename = `merged_${uuidv4()}.mp4`;
    const outputPath = path.join(PROCESSED_DIR, outputFilename);
    const listFilePath = path.join(PROCESSED_DIR, `list_${uuidv4()}.txt`);

    // Create concat file list
    const fileList = filenames.map(f => {
        const fullPath = path.join(UPLOADS_DIR, f).replace(/\\/g, '/');
        return `file '${fullPath}'`;
    }).join('\n');

    fs.writeFileSync(listFilePath, fileList);

    console.log(`🔗 Merging ${filenames.length} videos`);

    ffmpeg()
        .input(listFilePath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast', '-movflags', '+faststart'])
        .output(outputPath)
        .on('progress', (progress) => {
            if (progress.percent) console.log(`  🔗 Merge progress: ${Math.round(progress.percent)}%`);
        })
        .on('end', () => {
            // Clean up list file
            try { if (fs.existsSync(listFilePath)) fs.unlinkSync(listFilePath); } catch (e) { /* ignore */ }
            console.log(`  🔗 Merge complete: ${outputFilename}`);
            res.json({ success: true, filename: outputFilename, message: 'Videos merged successfully' });
        })
        .on('error', (err) => {
            console.error('Merge error:', err.message);
            try { if (fs.existsSync(listFilePath)) fs.unlinkSync(listFilePath); } catch (e) { /* ignore */ }
            res.status(500).json({ error: 'Failed to merge videos', details: err.message });
        })
        .run();
});

// ─── Audio Operations ───
router.post('/audio', (req, res) => {
    const { filename, operation, volume } = req.body;
    if (!filename || !operation) return res.status(400).json({ error: 'filename and operation required' });

    const inputPath = path.join(UPLOADS_DIR, filename);

    if (!fs.existsSync(inputPath)) {
        return res.status(404).json({ error: 'Input file not found' });
    }

    console.log(`🔊 Audio operation '${operation}' on: ${filename}`);

    // Handle extract separately (outputs mp3)
    if (operation === 'extract') {
        const audioFilename = `audio_${uuidv4()}.mp3`;
        const audioPath = path.join(PROCESSED_DIR, audioFilename);
        ffmpeg(inputPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate('192k')
            .output(audioPath)
            .on('progress', (progress) => {
                if (progress.percent) console.log(`  🎵 Extract progress: ${Math.round(progress.percent)}%`);
            })
            .on('end', () => {
                console.log(`  🎵 Audio extracted: ${audioFilename}`);
                res.json({ success: true, filename: audioFilename, message: 'Audio extracted successfully' });
            })
            .on('error', (err) => {
                console.error('Audio extract error:', err.message);
                res.status(500).json({ error: 'Failed to extract audio', details: err.message });
            })
            .run();
        return;
    }

    // Handle fadeOut: need to know duration first
    if (operation === 'fadeOut') {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            const outputFilename = `audio_${uuidv4()}.mp4`;
            const outputPath = path.join(PROCESSED_DIR, outputFilename);
            const duration = (metadata && metadata.format && metadata.format.duration) ? parseFloat(metadata.format.duration) : 30;
            const fadeStart = Math.max(0, duration - 3);

            ffmpeg(inputPath)
                .audioFilters(`afade=t=out:st=${fadeStart}:d=3`)
                .outputOptions(['-c:v', 'libx264', '-preset', 'fast', '-movflags', '+faststart'])
                .output(outputPath)
                .on('progress', (progress) => {
                    if (progress.percent) console.log(`  📉 FadeOut progress: ${Math.round(progress.percent)}%`);
                })
                .on('end', () => {
                    console.log(`  📉 FadeOut complete: ${outputFilename}`);
                    res.json({ success: true, filename: outputFilename, message: `Audio operation 'fadeOut' completed` });
                })
                .on('error', (err) => {
                    console.error('Audio fadeOut error:', err.message);
                    res.status(500).json({ error: 'Failed to process audio', details: err.message });
                })
                .run();
        });
        return;
    }

    // Handle other operations
    const outputFilename = `audio_${uuidv4()}.mp4`;
    const outputPath = path.join(PROCESSED_DIR, outputFilename);
    let cmd = ffmpeg(inputPath);

    switch (operation) {
        case 'mute':
            cmd.noAudio();
            break;
        case 'volume':
            cmd.audioFilters(`volume=${volume || 1.0}`);
            break;
        case 'fadeIn':
            cmd.audioFilters('afade=t=in:st=0:d=3');
            break;
        default:
            return res.status(400).json({ error: `Unknown audio operation: ${operation}` });
    }

    cmd.outputOptions(['-c:v', 'libx264', '-preset', 'fast', '-movflags', '+faststart'])
        .output(outputPath)
        .on('progress', (progress) => {
            if (progress.percent) console.log(`  🔊 Audio progress: ${Math.round(progress.percent)}%`);
        })
        .on('end', () => {
            console.log(`  🔊 Audio '${operation}' complete: ${outputFilename}`);
            res.json({ success: true, filename: outputFilename, message: `Audio operation '${operation}' completed` });
        })
        .on('error', (err) => {
            console.error('Audio error:', err.message);
            res.status(500).json({ error: 'Failed to process audio', details: err.message });
        })
        .run();
});

// ─── Export / Download ───
// Download processed files
router.get('/export/:filename', (req, res) => {
    const filename = req.params.filename;

    // Check processed folder first, then uploads folder
    let filePath = path.join(PROCESSED_DIR, filename);
    if (!fs.existsSync(filePath)) {
        filePath = path.join(UPLOADS_DIR, filename);
    }
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    res.download(filePath, (err) => {
        if (err && !res.headersSent) {
            console.error('Download error:', err.message);
            res.status(500).json({ error: 'Failed to download file' });
        }
    });
});

// Multer error handler
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'File too large. Max size is 500MB.' });
        }
        return res.status(400).json({ error: err.message });
    }
    if (err) {
        return res.status(400).json({ error: err.message });
    }
    next();
});

module.exports = router;
