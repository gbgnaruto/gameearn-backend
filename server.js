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

// Ensure the public directory exists for static playback
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir);
}
app.use('/public', express.static(publicDir));

// Keep-Alive Pulse Route
app.get('/', (req, res) => {
    res.status(200).send('SyncTube Backend is Awake and Running! 🚀');
});

// --- STREAMLINED & SECURED STREAM CONVERSION ENDPOINT ---
app.post('/api/convert', (req, res) => {
    const { videoUrl } = req.body;

    if (!videoUrl || typeof videoUrl !== 'string') {
        return res.status(400).send({ error: 'Valid Video URL required' });
    }

    try {
        new URL(videoUrl); // Validate string structure as a true URI
    } catch (_) {
        return res.status(400).send({ error: 'Invalid URL format' });
    }

    const outputFileName = `stream_${Date.now()}.mpd`;
    const outputPath = path.join(publicDir, outputFileName);

    // Dynamic arguments array passed cleanly to binary execution
    const args = [
        '-y', 
        '-i', videoUrl, 
        '-map', '0:v', 
        '-map', '0:a', 
        '-c:v', 'copy', 
        '-c:a', 'aac', 
        '-f', 'dash', 
        outputPath
    ];

    console.log(`[FFmpeg] Initiating stream allocation for: ${videoUrl}`);

    // Using spawn to avoid maxBuffer overflows on extended media logs
    const ffmpegProcess = spawn('ffmpeg', args);

    // Optional: Log errors or output streams if tracking debugging steps
    ffmpegProcess.stderr.on('data', (data) => {
        // FFmpeg writes progress logs to stderr by design. Keep open for debugging if needed:
        // console.log(`[FFmpeg Progress]: ${data}`);
    });

    ffmpegProcess.on('close', (code) => {
        if (code !== 0) {
            console.error(`[FFmpeg] Process exited with failure code: ${code}`);
            return res.status(500).send({ error: 'Conversion pipeline failed' });
        }
        
        console.log(`[FFmpeg] Successfully generated manifest: ${outputFileName}`);
        res.send({ status: 'Success', manifestUrl: `/public/${outputFileName}` });
    });

    ffmpegProcess.on('error', (err) => {
        console.error(`[FFmpeg] Binary execution failure:`, err);
        res.status(500).send({ error: 'Failed to initialize system transcoder' });
    });
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
            
            // Clear pending removal timer to save state
            if (oldUserInstance.timeoutId) {
                clearTimeout(oldUserInstance.timeoutId);
            }

            assignHost = oldUserInstance.isHost;
            assignCoHost = oldUserInstance.isCoHost;

            // Purge the old socket profile placeholder
            room.users.splice(existingUserIndex, 1);
        } else if (room.users.filter(u => !u.isPendingRemoval).length === 0) {
            // Crown the user if no active users are currently present
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
        
        // Push updated data strictly to active system participants
        io.to(roomId).emit('update_users', room.users.filter(u => !u.isPendingRemoval));

        // Only alert chat rooms on genuine arrivals, ignoring simple page refreshes
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

                // Flag the element instead of instant slicing to preserve state during short drops/refreshes
                user.isPendingRemoval = true;

                user.timeoutId = setTimeout(() => {
                    const currentRoom = rooms[roomId];
                    if (currentRoom) {
                        // Re-verify that user did not return under a clean connection profile
                        const freshInstance = currentRoom.users.find(u => u.userId === user.userId && !u.isPendingRemoval);
                        
                        if (!freshInstance) {
                            // Erase user permanently from memory cache
                            currentRoom.users = currentRoom.users.filter(u => u.userId !== user.userId);
                            
                            io.to(roomId).emit('chat_message', { system: true, text: `${user.username} left the party 👋` });

                            // Dynamic Host Reassignment
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

                // Update room listing state immediately for UI performance feedback
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
