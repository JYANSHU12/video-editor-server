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

// ─── Job Queue: max 1 concurrent FFmpeg job ───
let activeJobs = 0;
const MAX_CONCURRENT_JOBS = 1;
const jobQueue = [];

function enqueueJob(jobFn) {
    return new Promise((resolve, reject) => {
        const run = () => {
            activeJobs++;
            console.log(`⚙️ Job started (active: ${activeJobs})`);
            jobFn()
                .then(resolve)
                .catch(reject)
                .finally(() => {
                    activeJobs--;
                    console.log(`⚙️ Job finished (active: ${activeJobs}, queued: ${jobQueue.length})`);
                    if (jobQueue.length > 0) {
                        const next = jobQueue.shift();
                        next();
                    }
                });
        };

        if (activeJobs < MAX_CONCURRENT_JOBS) {
            run();
        } else {
            console.log(`⏳ Job queued (queue size: ${jobQueue.length + 1})`);
            jobQueue.push(run);
        }
    });
}

// Helper: safely delete a file
function safeDelete(filePath) {
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) { /* ignore */ }
}

// Memory-optimized FFmpeg output options (tuned for Render 512MB free tier)
const FFMPEG_OUTPUT_OPTS = [
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-preset', 'ultrafast',   // minimal RAM usage
    '-crf', '35',             // higher = smaller output, less memory
    '-threads', '1',          // single thread to cap buffer memory
    '-maxrate', '500k',       // limit bitrate to reduce memory
    '-bufsize', '250k',       // small buffer = less RAM
    '-vf', 'scale=480:-2',   // 480px wide, auto height
    '-movflags', '+faststart',
    '-ac', '1',               // mono audio to save memory
    '-ar', '22050'            // lower sample rate
];

const FFMPEG_VIDEO_ONLY_OPTS = [
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '35',
    '-threads', '1',
    '-maxrate', '500k',
    '-bufsize', '250k',
    '-vf', 'scale=480:-2',
    '-movflags', '+faststart'
];

// For operations that already have a -vf (text, filter), use these without the scale filter
const FFMPEG_NO_SCALE_OPTS = [
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-preset', 'ultrafast',
    '-crf', '35',
    '-threads', '1',
    '-maxrate', '500k',
    '-bufsize', '250k',
    '-movflags', '+faststart',
    '-ac', '1',
    '-ar', '22050'
];

// Multer config — reduced limits for free-tier hosting
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${uuidv4()}${ext}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max for Render free tier
    fileFilter: (req, file, cb) => {
        const allowed = /video|audio/;
        if (allowed.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only video/audio files are allowed'), false);
        }
    }
});

// Helper: find a system font (Linux for Render, Windows for local dev)
function getSystemFont() {
    const candidates = [
        // Linux (Render)
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
        // Windows (local dev)
        'C:/Windows/Fonts/arial.ttf',
        'C:/Windows/Fonts/segoeui.ttf',
        'C:/Windows/Fonts/tahoma.ttf',
    ];
    for (const f of candidates) {
        if (fs.existsSync(f)) {
            // Escape path for ffmpeg drawtext: forward slashes, escape colons and backslashes
            return f.replace(/\\/g, '/').replace(/:/g, '\\:');
        }
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
router.post('/upload-multiple', upload.array('videos', 3), (req, res) => { // max 3 files (was 10)
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

    const start = parseFloat(startTime) || 0;
    const end = parseFloat(endTime) || 0;
    const duration = end > start ? end - start : 0;

    console.log(`✂️ Trimming: ${filename} from ${start}s to ${end}s (duration: ${duration}s)`);

    enqueueJob(() => new Promise((resolve, reject) => {
        const cmd = ffmpeg(inputPath)
            .inputOptions(['-ss', String(start)]);

        // Use -t as output option (not input) for reliable duration limiting
        const outOpts = [...FFMPEG_OUTPUT_OPTS];
        if (duration > 0) {
            outOpts.push('-t', String(duration));
        }

        cmd.outputOptions(outOpts)
            .output(outputPath)
            .on('start', (commandLine) => {
                console.log('  ✂️ FFmpeg command:', commandLine);
            })
            .on('stderr', (stderrLine) => {
                if (stderrLine.includes('Error') || stderrLine.includes('error') || stderrLine.includes('Invalid') || stderrLine.includes('failed')) {
                    console.error('  ✂️ FFmpeg stderr:', stderrLine);
                }
            })
            .on('progress', (progress) => {
                if (progress.percent) console.log(`  ✂️ Trim progress: ${Math.round(progress.percent)}%`);
            })
            .on('end', () => {
                console.log(`  ✂️ Trim complete: ${outputFilename}`);
                res.json({ success: true, filename: outputFilename, message: 'Video trimmed successfully' });
                resolve();
            })
            .on('error', (err, stdout, stderr) => {
                console.error('Trim error:', err.message);
                console.error('Trim stderr:', stderr);
                if (!res.headersSent) res.status(500).json({ error: 'Failed to trim video', details: err.message });
                resolve(); // resolve even on FFmpeg error so queue continues
            })
            .run();
    }));
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
        emboss: 'convolution=-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2:5:5:5:5:0:128'
    };

    const videoFilter = filterMap[filter];
    if (!videoFilter) return res.status(400).json({ error: `Unknown filter: ${filter}` });

    console.log(`🎨 Applying filter '${filter}' to: ${filename}`);

    enqueueJob(() => new Promise((resolve) => {
        ffmpeg(inputPath)
            .videoFilters([videoFilter, 'scale=480:-2'])
            .outputOptions(FFMPEG_NO_SCALE_OPTS)
            .output(outputPath)
            .on('progress', (progress) => {
                if (progress.percent) console.log(`  🎨 Filter progress: ${Math.round(progress.percent)}%`);
            })
            .on('end', () => {
                console.log(`  🎨 Filter complete: ${outputFilename}`);
                res.json({ success: true, filename: outputFilename, message: `Filter '${filter}' applied successfully` });
                resolve();
            })
            .on('error', (err) => {
                console.error('Filter error:', err.message);
                if (!res.headersSent) res.status(500).json({ error: 'Failed to apply filter', details: err.message });
                resolve();
            })
            .run();
    }));
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
    // Convert #ffffff to 0xffffff for ffmpeg drawtext, or use color name
    let color = fontColor || 'white';
    if (color.startsWith('#')) {
        color = '0x' + color.slice(1);
    }
    const posX = x || '(w-text_w)/2';
    const posY = y || '(h-text_h)/2';

    // Escape special chars for drawtext filter (minimal escaping)
    const escapedText = text
        .replace(/\\/g, '\\\\')      // escape backslashes
        .replace(/'/g, "\u2019")       // replace single quotes with unicode right single quote
        .replace(/:/g, '\\:')         // escape colons
        .replace(/%/g, '%%')           // escape percent signs
        .replace(/\[/g, '\\[')        // escape brackets
        .replace(/\]/g, '\\]');

    // Build drawtext filter - fontfile is required on Windows
    const fontFile = getSystemFont();
    let drawTextFilter;

    if (fontFile) {
        drawTextFilter = `drawtext=fontfile='${fontFile}':text='${escapedText}':fontsize=${size}:fontcolor=${color}:x=${posX}:y=${posY}`;
    } else {
        drawTextFilter = `drawtext=text='${escapedText}':fontsize=${size}:fontcolor=${color}:x=${posX}:y=${posY}`;
    }

    if (startTime !== undefined && endTime !== undefined) {
        drawTextFilter += `:enable='between(t,${startTime},${endTime})'`;
    }

    console.log(`🔤 Adding text to: ${filename}`);
    console.log(`🔤 Filter: ${drawTextFilter}`);

    enqueueJob(() => new Promise((resolve) => {
        ffmpeg(inputPath)
            .videoFilters([drawTextFilter, 'scale=480:-2'])
            .outputOptions(FFMPEG_NO_SCALE_OPTS)
            .output(outputPath)
            .on('progress', (progress) => {
                if (progress.percent) console.log(`  🔤 Text progress: ${Math.round(progress.percent)}%`);
            })
            .on('end', () => {
                console.log(`  🔤 Text complete: ${outputFilename}`);
                res.json({ success: true, filename: outputFilename, message: 'Text overlay added successfully' });
                resolve();
            })
            .on('error', (err) => {
                console.error('Text error:', err.message);
                if (!res.headersSent) res.status(500).json({ error: 'Failed to add text', details: err.message });
                resolve();
            })
            .run();
    }));
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

    console.log(`🔗 Merging ${filenames.length} videos using concat filter`);

    enqueueJob(() => new Promise((resolve) => {
        const cmd = ffmpeg();

        // Add each input file
        filenames.forEach(f => {
            cmd.input(path.join(UPLOADS_DIR, f));
        });

        // Build the complex filter:
        // 1. Scale + pad each input to 1280x720 with same pixel format
        // 2. Normalize audio to stereo 44100Hz
        // 3. Concat all streams
        const n = filenames.length;
        let filterParts = [];
        let concatInputs = '';

        for (let i = 0; i < n; i++) {
            filterParts.push(
                `[${i}:v]scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v${i}]`
            );
            filterParts.push(
                `[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`
            );
            concatInputs += `[v${i}][a${i}]`;
        }

        filterParts.push(
            `${concatInputs}concat=n=${n}:v=1:a=1[outv][outa]`
        );

        const complexFilter = filterParts.join(';');

        cmd.complexFilter(complexFilter, ['outv', 'outa'])
            .outputOptions([
                '-c:v', 'libx264',
                '-c:a', 'aac',
                '-preset', 'ultrafast',
                '-crf', '28',
                '-threads', '1',
                '-movflags', '+faststart',
                '-shortest'
            ])
            .output(outputPath)
            .on('progress', (progress) => {
                if (progress.percent) console.log(`  🔗 Merge progress: ${Math.round(progress.percent)}%`);
            })
            .on('end', () => {
                console.log(`  🔗 Merge complete: ${outputFilename}`);
                res.json({ success: true, filename: outputFilename, message: 'Videos merged successfully' });
                resolve();
            })
            .on('error', (err) => {
                console.error('Merge error:', err.message);
                if (!res.headersSent) res.status(500).json({ error: 'Failed to merge videos', details: err.message });
                resolve();
            })
            .run();
    }));
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

        enqueueJob(() => new Promise((resolve) => {
            ffmpeg(inputPath)
                .noVideo()
                .audioCodec('libmp3lame')
                .audioBitrate('128k') // reduced from 192k
                .output(audioPath)
                .on('progress', (progress) => {
                    if (progress.percent) console.log(`  🎵 Extract progress: ${Math.round(progress.percent)}%`);
                })
                .on('end', () => {
                    console.log(`  🎵 Audio extracted: ${audioFilename}`);
                    res.json({ success: true, filename: audioFilename, message: 'Audio extracted successfully' });
                    resolve();
                })
                .on('error', (err) => {
                    console.error('Audio extract error:', err.message);
                    if (!res.headersSent) res.status(500).json({ error: 'Failed to extract audio', details: err.message });
                    resolve();
                })
                .run();
        }));
        return;
    }

    // Handle fadeOut: need to know duration first
    if (operation === 'fadeOut') {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            const outputFilename = `audio_${uuidv4()}.mp4`;
            const outputPath = path.join(PROCESSED_DIR, outputFilename);
            const duration = (metadata && metadata.format && metadata.format.duration) ? parseFloat(metadata.format.duration) : 30;
            const fadeStart = Math.max(0, duration - 3);

            enqueueJob(() => new Promise((resolve) => {
                ffmpeg(inputPath)
                    .audioFilters(`afade=t=out:st=${fadeStart}:d=3`)
                    .outputOptions(FFMPEG_OUTPUT_OPTS)
                    .output(outputPath)
                    .on('progress', (progress) => {
                        if (progress.percent) console.log(`  📉 FadeOut progress: ${Math.round(progress.percent)}%`);
                    })
                    .on('end', () => {
                        console.log(`  📉 FadeOut complete: ${outputFilename}`);
                        res.json({ success: true, filename: outputFilename, message: `Audio operation 'fadeOut' completed` });
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error('Audio fadeOut error:', err.message);
                        if (!res.headersSent) res.status(500).json({ error: 'Failed to process audio', details: err.message });
                        resolve();
                    })
                    .run();
            }));
        });
        return;
    }

    // Handle other operations
    const outputFilename = `audio_${uuidv4()}.mp4`;
    const outputPath = path.join(PROCESSED_DIR, outputFilename);
    let cmd = ffmpeg(inputPath);
    // Use the right output options: mute needs no audio codec, all others need it
    let useOutputOpts = FFMPEG_OUTPUT_OPTS;

    switch (operation) {
        case 'mute':
            cmd.noAudio();
            useOutputOpts = FFMPEG_VIDEO_ONLY_OPTS; // no audio codec needed for mute
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

    enqueueJob(() => new Promise((resolve) => {
        cmd.outputOptions(useOutputOpts)
            .output(outputPath)
            .on('progress', (progress) => {
                if (progress.percent) console.log(`  🔊 Audio progress: ${Math.round(progress.percent)}%`);
            })
            .on('end', () => {
                console.log(`  🔊 Audio '${operation}' complete: ${outputFilename}`);
                res.json({ success: true, filename: outputFilename, message: `Audio operation '${operation}' completed` });
                resolve();
            })
            .on('error', (err) => {
                console.error('Audio error:', err.message);
                if (!res.headersSent) res.status(500).json({ error: 'Failed to process audio', details: err.message });
                resolve();
            })
            .run();
    }));
});

// ─── Export / Download ───
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
            return res.status(413).json({ error: 'File too large. Max size is 50MB.' });
        }
        return res.status(400).json({ error: err.message });
    }
    if (err) {
        return res.status(400).json({ error: err.message });
    }
    next();
});

module.exports = router;
