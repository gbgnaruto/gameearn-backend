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
                host: null, users: [], playlist: [], currentVideo: null
            };
        }

        const room = rooms[roomId];

        // 🟢 GHOST CLONE FIX: Check if this user is already in the room (e.g. from a page refresh)
        const existingUserIndex = room.users.findIndex(u => u.userId === userId);
        let assignHost = false;
        let assignCoHost = false;

        if (existingUserIndex !== -1) {
            // Inherit the roles from the ghost connection
            assignHost = room.users[existingUserIndex].isHost;
            assignCoHost = room.users[existingUserIndex].isCoHost;
            // Remove the ghost connection
            room.users.splice(existingUserIndex, 1);
        } else if (room.users.length === 0) {
            // First person to join the room gets the crown
            assignHost = true;
        }

        const userObj = { socketId: socket.id, userId, username, photo, isHost: assignHost, isCoHost: assignCoHost };
        room.users.push(userObj);

        // Ensure the room knows who the absolute host is
        if (assignHost) room.host = socket.id;

        socket.join(roomId);
        callback({ success: true });

        socket.emit('room_data', { isHost: assignHost, isCoHost: assignCoHost, playlist: room.playlist, currentVideo: room.currentVideo });
        io.to(roomId).emit('update_users', room.users);
        
        // Only announce in chat if it's a completely new join (not a refresh)
        if (existingUserIndex === -1) {
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

    // 1.0s HEARTBEAT SAVER
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

    // --- DISCONNECT LOGIC ---
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const userIndex = room.users.findIndex(u => u.socketId === socket.id);
            
            if (userIndex !== -1) {
                const user = room.users[userIndex];
                socket.to(roomId).emit('voice_user_left', { socketId: socket.id });
                
                // Set a short timeout to see if they instantly reconnect (page refresh)
                // If they don't reconnect in 3 seconds, announce they left and hand over host.
                setTimeout(() => {
                    const currentRoom = rooms[roomId];
                    if(currentRoom && !currentRoom.users.find(u => u.userId === user.userId)) {
                        io.to(roomId).emit('chat_message', { system: true, text: `${user.username} left the party 👋` });
                        
                        if (user.isHost && currentRoom.users.length > 0) {
                            currentRoom.host = currentRoom.users[0].socketId;
                            currentRoom.users[0].isHost = true;
                            currentRoom.users[0].isCoHost = false;
                            io.to(roomId).emit('chat_message', { system: true, text: `👑 ${currentRoom.users[0].username} is the new Room Host` });
                        }
                        io.to(roomId).emit('update_users', currentRoom.users);
                    }
                    if (currentRoom && currentRoom.users.length === 0) delete rooms[roomId];
                    emitActiveRooms();
                }, 3000);

                room.users.splice(userIndex, 1);
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
server.listen(PORT, () => { console.log(`✅ SyncTube Server v33 running on port ${PORT}`); });
