const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Keep-Alive Pulse Route
app.get('/', (req, res) => {
    res.status(200).send('SyncTube Backend is Awake and Running! 🚀');
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
                host: socket.id, users: [], playlist: [], currentVideo: null
            };
        }

        const room = rooms[roomId];
        const isHost = room.host === socket.id;

        const userObj = { socketId: socket.id, userId, username, photo, isHost, isCoHost: false };
        room.users.push(userObj);

        socket.join(roomId);
        callback({ success: true });

        socket.emit('room_data', { isHost: isHost, isCoHost: false, playlist: room.playlist, currentVideo: room.currentVideo });
        io.to(roomId).emit('update_users', room.users);
        io.to(roomId).emit('chat_message', { system: true, text: `${username} joined the party 🍿` });
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
            // Single Source of Truth Update
            io.to(data.roomId).emit('update_users', room.users);
            io.to(data.roomId).emit('chat_message', { system: true, text: `👑 The Host Crown was transferred!` });
        }
    });

    socket.on('toggle_cohost', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host === socket.id) {
            const targetUser = room.users.find(u => u.socketId === data.targetId);
            if(targetUser) {
                targetUser.isCoHost = !targetUser.isCoHost;
                io.to(data.roomId).emit('update_users', room.users);
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
            room.currentVideo = { src: data.src, name: data.name, index: data.index };
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

    socket.on('request_sync_from_host', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host) io.to(room.host).emit('viewer_requests_sync');
    });

    socket.on('broadcast_sync_data', (data) => {
        const room = rooms[data.roomId];
        // Ensure only the absolute host broadcasts the heartbeat to prevent conflicts
        if (room && room.host === socket.id) {
            socket.to(data.roomId).emit('host_send_sync', { time: data.time, state: data.state });
        }
    });

    // --- CHAT & VOICE ---
    socket.on('chat_message', (data) => { if (rooms[data.roomId]) io.to(data.roomId).emit('chat_message', data); });
    socket.on('voice_join', (data) => { socket.to(data.roomId).emit('voice_user_joined', { socketId: socket.id }); });
    socket.on('webrtc_offer', (data) => { io.to(data.target).emit('webrtc_offer', { sender: socket.id, sdp: data.sdp }); });
    socket.on('webrtc_answer', (data) => { io.to(data.target).emit('webrtc_answer', { sender: socket.id, sdp: data.sdp }); });
    socket.on('webrtc_ice', (data) => { io.to(data.target).emit('webrtc_ice', { sender: socket.id, candidate: data.candidate }); });

    // --- DISCONNECT LOGIC ---
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const userIndex = room.users.findIndex(u => u.socketId === socket.id);
            
            if (userIndex !== -1) {
                const user = room.users[userIndex];
                socket.to(roomId).emit('voice_user_left', { socketId: socket.id });
                io.to(roomId).emit('chat_message', { system: true, text: `${user.username} left the party 👋` });
                room.users.splice(userIndex, 1);

                if (room.users.length === 0) {
                    delete rooms[roomId];
                } else {
                    if (user.isHost) {
                        room.host = room.users[0].socketId;
                        room.users[0].isHost = true;
                        room.users[0].isCoHost = false;
                        io.to(roomId).emit('chat_message', { system: true, text: `👑 ${room.users[0].username} is the new Room Host` });
                    }
                    io.to(roomId).emit('update_users', room.users);
                }
                emitActiveRooms();
                break;
            }
        }
    });

    function emitActiveRooms() {
        const publicRooms = Object.values(rooms).filter(r => !r.password).map(r => ({ id: r.id, name: r.name, users: r.users.length }));
        io.emit('active_rooms', publicRooms);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`✅ SyncTube Server v28 running on port ${PORT}`); });
