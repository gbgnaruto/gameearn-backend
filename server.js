const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json()); // Essential for parsing POST bodies

// Ensure the root public directory exists
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir);
}
app.use('/public', express.static(publicDir));

// Keep-Alive Pulse Route
app.get('/', (req, res) => {
    res.status(200).send('SyncTube Backend is Awake and Running! 🚀');
});

// In-memory job store — tracks all active/completed conversions
const jobs = {};

// How many 6-second segments must exist before we tell the frontend to start playing
// 5 segments = 30 seconds of buffer — enough to start smoothly
const LIVE_START_SEGMENTS = 5;

// --- STEP 1: Start live-streaming conversion, return job ID immediately ---
app.post('/api/convert', (req, res) => {
    const { videoUrl } = req.body;

    if (!videoUrl || typeof videoUrl !== 'string') {
        return res.status(400).json({ error: 'Valid Video URL required' });
    }
    try {
        new URL(videoUrl);
    } catch (_) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    const jobId    = `job_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const streamId = `stream_${Date.now()}`;
    const streamDir = path.join(publicDir, streamId);
    if (!fs.existsSync(streamDir)) fs.mkdirSync(streamDir, { recursive: true });

    const outputPath = path.join(streamDir, 'playlist.m3u8');

    // Register job immediately
    jobs[jobId] = {
        status: 'pending',
        streamId,
        streamDir,
        manifestUrl: `/public/${streamId}/playlist.m3u8`,
        startedAt: Date.now(),
        segments: 0
    };

    // Reply instantly — frontend polls status
    res.json({ status: 'queued', jobId });

    // Probe the file first to count audio streams
    // Then build separate var_stream_map entries so HLS.js sees real alternate audio renditions
    let numAudio = 1;
    try {
        const { execSync } = require('child_process');
        const probe = execSync(
            `ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "${videoUrl.replace(/"/g,'\"')}"`,
            { timeout: 15000 }
        ).toString().trim();
        numAudio = probe.split('\n').filter(Boolean).length || 1;
        console.log(`[FFmpeg] Job ${jobId}: detected ${numAudio} audio stream(s)`);
    } catch(e) {
        console.log('[FFmpeg] ffprobe failed, assuming 1 audio stream');
    }

    // Build map args and var_stream_map for multi-audio HLS
    const mapArgs = ['-map', '0:v:0'];
    let varStreamMap = 'v:0';
    for (let i = 0; i < numAudio; i++) {
        mapArgs.push('-map', `0:a:${i}`);
        varStreamMap += `,a:${i},agroup:audio,language:track${i+1},default:${i===0?'yes':'no'}`;
    }

    const args = [
        '-y',
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        '-headers', 'Referer: https://www.google.com/\r\nAccept: */*\r\nAccept-Language: en-US,en;q=0.9\r\n',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', videoUrl,
        ...mapArgs,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-ac', '2',
        '-b:a', '192k',
        '-max_muxing_queue_size', '9999',
        '-f', 'hls',
        '-hls_time', '6',
        '-hls_list_size', '0',
        '-hls_flags', 'append_list+independent_segments',
        // var_stream_map tells FFmpeg to write separate audio playlists
        // which is what HLS.js reads to populate its audioTracks array
        ...(numAudio > 1 ? ['-var_stream_map', varStreamMap,
            '-master_pl_name', 'playlist.m3u8',
            '-hls_segment_filename', path.join(streamDir, 'seg_%v_%03d.ts'),
            path.join(streamDir, 'stream_%v.m3u8')]
          : ['-hls_segment_filename', path.join(streamDir, 'seg_%03d.ts'), outputPath])
    ];

    console.log(`[FFmpeg] Live job ${jobId} started for: ${videoUrl}`);
    const proc = spawn('ffmpeg', args);

    // Watch for new segment files — update segment count in real time
    const segWatcher = fs.watch(streamDir, (event, filename) => {
        if (filename && filename.endsWith('.ts')) {
            const segs = fs.readdirSync(streamDir).filter(f => f.endsWith('.ts')).length;
            jobs[jobId].segments = segs;

            // Once we have enough buffer, tell the frontend it can start playing
            if (jobs[jobId].status === 'pending' && segs >= LIVE_START_SEGMENTS) {
                console.log(`[FFmpeg] Job ${jobId} live — ${segs} segments ready, signalling frontend`);
                jobs[jobId].status = 'live';
            }
        }
    });

    proc.stderr.on('data', d => {
        const line = d.toString().trim();
        if (line && line.includes('time=')) {
            // Only log progress lines to avoid flooding
            console.log(`[FFmpeg ${jobId}] ${line}`);
        }
    });

    proc.on('close', code => {
        segWatcher.close();
        if (code === 0) {
            console.log(`[FFmpeg] Job ${jobId} fully done ✅`);
            jobs[jobId].status = 'done';
        } else {
            console.error(`[FFmpeg] Job ${jobId} failed with code ${code}`);
            // Only mark as error if we never went live — if we did go live,
            // the user is already watching and partial content is fine
            if (jobs[jobId].status === 'pending') {
                jobs[jobId].status = 'error';
                jobs[jobId].error  = `FFmpeg exited with code ${code}`;
            }
        }
    });

    proc.on('error', err => {
        segWatcher.close();
        console.error(`[FFmpeg] Job ${jobId} spawn error:`, err);
        if (jobs[jobId].status === 'pending') {
            jobs[jobId].status = 'error';
            jobs[jobId].error  = err.message;
        }
    });
});

// --- STEP 2: Frontend polls this every 3s ---
// Returns 'pending' until 30s of video is ready, then 'Success' to start playback
// FFmpeg keeps writing segments in the background while the user watches
app.get('/api/convert/status/:jobId', (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (job.status === 'live' || job.status === 'done') {
        // Return the manifest URL — HLS.js will load it and find segments already there
        return res.json({
            status: 'Success',
            manifestUrl: job.manifestUrl,
            segments: job.segments,
            live: job.status === 'live'  // frontend can show "⚡ Live Processing" badge
        });
    }
    if (job.status === 'error') {
        return res.json({ status: 'Error', error: job.error });
    }
    // Still buffering initial segments
    res.json({ status: 'pending', segments: job.segments || 0 });
});

// Health check — confirms FFmpeg is present
app.get('/api/health', (req, res) => {
    const { execSync } = require('child_process');
    try {
        const ver = execSync('ffmpeg -version 2>&1').toString().split('\n')[0];
        res.json({ status: 'ok', ffmpeg: ver });
    } catch (e) {
        res.status(500).json({ status: 'error', ffmpeg: 'NOT FOUND' });
    }
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    emitActiveRooms();

    socket.on('join_room', (data, callback) => {
        const { roomId, roomName, password, username, userId, photo } = data;

        if (rooms[roomId] && rooms[roomId].password && rooms[roomId].password !== password) {
            return callback({ success: false, message: "Incorrect password." });
        }

        if (!rooms[roomId]) {
            rooms[roomId] = {
                id: roomId, name: roomName, password: password || null,
                host: null, users: [], playlist: [], currentVideo: null
            };
        }

        const room = rooms[roomId];

        // FIXED GHOST CLONE LOGIC: Scan the entire user array, including disconnected entries waiting out their timer
        const existingUserIndex = room.users.findIndex(u => u.userId === userId);
        let assignHost = false;
        let assignCoHost = false;
        let isARefresh = false;

        if (existingUserIndex !== -1) {
            isARefresh = true;
            const oldUserInstance = room.users[existingUserIndex];

            if (oldUserInstance.timeoutId) {
                clearTimeout(oldUserInstance.timeoutId);
            }

            assignHost = oldUserInstance.isHost;
            assignCoHost = oldUserInstance.isCoHost;

            // Purge the old socket profile placeholder
            room.users.splice(existingUserIndex, 1);
        } else if (room.users.filter(u => !u.isPendingRemoval).length === 0) {
            assignHost = true;
        }

        const userObj = { 
            socketId: socket.id, 
            userId, 
            username, 
            photo, 
            isHost: assignHost, 
            isCoHost: assignCoHost,
            isPendingRemoval: false,
            timeoutId: null 
        };

        room.users.push(userObj);

        if (assignHost) room.host = socket.id;

        socket.join(roomId);
        callback({ success: true });

        socket.emit('room_data', { isHost: assignHost, isCoHost: assignCoHost, playlist: room.playlist, currentVideo: room.currentVideo });
        io.to(roomId).emit('update_users', room.users.filter(u => !u.isPendingRemoval));

        if (!isARefresh) {
            io.to(roomId).emit('chat_message', { system: true, text: `${username} joined the party 🍿` });
        }

        emitActiveRooms();
    });

    // --- HOST DELEGATION LOGIC ---
    socket.on('transfer_host', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host === socket.id) {
            room.host = data.targetId;
            room.users.forEach(u => {
                if (u.socketId === socket.id) u.isHost = false;
                if (u.socketId === data.targetId) { u.isHost = true; u.isCoHost = false; }
            });
            io.to(data.roomId).emit('update_users', room.users.filter(u => !u.isPendingRemoval));
            io.to(data.roomId).emit('chat_message', { system: true, text: `👑 The Host Crown was transferred!` });
        }
    });

    socket.on('toggle_cohost', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host === socket.id) {
            const targetUser = room.users.find(u => u.socketId === data.targetId);
            if(targetUser) {
                targetUser.isCoHost = !targetUser.isCoHost;
                io.to(data.roomId).emit('update_users', room.users.filter(u => !u.isPendingRemoval));
                const msg = targetUser.isCoHost ? `⭐ ${targetUser.username} was granted Co-Host power!` : `🔒 ${targetUser.username}'s Co-Host power was revoked.`;
                io.to(data.roomId).emit('chat_message', { system: true, text: msg });
            }
        }
    });

    // --- MEDIA SYNC LOGIC ---
    socket.on('change_video', (data) => {
        const room = rooms[data.roomId];
        const user = room?.users.find(u => u.socketId === socket.id);
        if (room && user && (user.isHost || user.isCoHost)) {
            room.currentVideo = { src: data.src, name: data.name, index: data.index, time: 0, state: 1 };
            io.to(data.roomId).emit('load_video', room.currentVideo);
        }
    });

    socket.on('update_playlist', (data) => {
        const room = rooms[data.roomId];
        const user = room?.users.find(u => u.socketId === socket.id);
        if (room && user && (user.isHost || user.isCoHost)) {
            room.playlist = data.playlist;
            socket.to(data.roomId).emit('sync_playlist', room.playlist);
        }
    });

    socket.on('play_video', (data) => {
        const room = rooms[data.roomId];
        const user = room?.users.find(u => u.socketId === socket.id);
        if (room && user && (user.isHost || user.isCoHost)) socket.to(data.roomId).emit('sync_play', data.time);
    });

    socket.on('pause_video', (data) => {
        const room = rooms[data.roomId];
        const user = room?.users.find(u => u.socketId === socket.id);
        if (room && user && (user.isHost || user.isCoHost)) socket.to(data.roomId).emit('sync_pause', data.time);
    });

    // HEARTBEAT SYNC
    socket.on('broadcast_sync_data', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host === socket.id) {
            if (room.currentVideo) {
                room.currentVideo.time = data.time;
                room.currentVideo.state = data.state;
            }
            socket.to(data.roomId).emit('host_send_sync', { time: data.time, state: data.state });
        }
    });

    // --- CHAT & VOICE ---
    socket.on('chat_message', (data) => { if (rooms[data.roomId]) io.to(data.roomId).emit('chat_message', data); });
    socket.on('voice_join', (data) => { socket.to(data.roomId).emit('voice_user_joined', { socketId: socket.id }); });
    socket.on('webrtc_offer', (data) => { io.to(data.target).emit('webrtc_offer', { sender: socket.id, sdp: data.sdp }); });
    socket.on('webrtc_answer', (data) => { io.to(data.target).emit('webrtc_answer', { sender: socket.id, sdp: data.sdp }); });
    socket.on('webrtc_ice', (data) => { io.to(data.target).emit('webrtc_ice', { sender: socket.id, candidate: data.candidate }); });

    // --- NON-BLOCKING DISCONNECT LOGIC ---
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const userIndex = room.users.findIndex(u => u.socketId === socket.id);

            if (userIndex !== -1) {
                const user = room.users[userIndex];
                socket.to(roomId).emit('voice_user_left', { socketId: socket.id });

                user.isPendingRemoval = true;

                user.timeoutId = setTimeout(() => {
                    const currentRoom = rooms[roomId];
                    if (currentRoom) {
                        const freshInstance = currentRoom.users.find(u => u.userId === user.userId && !u.isPendingRemoval);

                        if (!freshInstance) {
                            currentRoom.users = currentRoom.users.filter(u => u.userId !== user.userId);
                            io.to(roomId).emit('chat_message', { system: true, text: `${user.username} left the party 👋` });

                            if (user.isHost && currentRoom.users.length > 0) {
                                currentRoom.host = currentRoom.users[0].socketId;
                                currentRoom.users[0].isHost = true;
                                currentRoom.users[0].isCoHost = false;
                                io.to(roomId).emit('chat_message', { system: true, text: `👑 ${currentRoom.users[0].username} is the new Room Host` });
                            }

                            io.to(roomId).emit('update_users', currentRoom.users.filter(u => !u.isPendingRemoval));
                        }

                        if (currentRoom.users.length === 0) {
                            delete rooms[roomId];
                        }
                    }
                    emitActiveRooms();
                }, 3000);

                io.to(roomId).emit('update_users', room.users.filter(u => !u.isPendingRemoval));
                break;
            }
        }
    });

    function emitActiveRooms() {
        const publicRooms = Object.values(rooms)
            .filter(r => !r.password)
            .map(r => ({ 
                id: r.id, 
                name: r.name, 
                users: r.users.filter(u => !u.isPendingRemoval).length 
            }));
        io.emit('active_rooms', publicRooms);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`✅ SyncTube Server v33 running on port ${PORT}`); });