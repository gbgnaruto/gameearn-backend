const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// 🟢 THE KEEP-ALIVE PULSE ROUTE
// This responds to cron-job.org every 10 minutes to prevent Render from sleeping
app.get('/', (req, res) => {
    res.status(200).send('SyncTube Backend is Awake and Running! 🚀');
});

const server = http.createServer(app);

// Initialize Socket.IO with permissive CORS for your Firebase frontend
const io = new Server(server, {
    cors: {
        origin: "*", // Allows your gameearnpro.web.app to connect
        methods: ["GET", "POST"]
    }
});

// Central Memory Store for Active Rooms
const rooms = {};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Automatically send the list of public rooms to new connections
    emitActiveRooms();

    /* =========================================
       1. ROOM MANAGEMENT & JOIN LOGIC
       ========================================= */
    socket.on('join_room', (data, callback) => {
        const { roomId, roomName, password, username, userId } = data;

        // If room exists, check password
        if (rooms[roomId] && rooms[roomId].password && rooms[roomId].password !== password) {
            return callback({ success: false, message: "Incorrect password." });
        }

        // Create room if it doesn't exist
        if (!rooms[roomId]) {
            rooms[roomId] = {
                id: roomId,
                name: roomName,
                password: password || null,
                host: socket.id,
                users: [],
                playlist: [],
                currentVideo: null
            };
        }

        const room = rooms[roomId];
        const isHost = room.host === socket.id;

        // Add user to the room array
        const userObj = { socketId: socket.id, userId, username, isHost };
        room.users.push(userObj);

        // Join the Socket.IO network room
        socket.join(roomId);

        // Send success back to the user
        callback({ success: true });

        // Send the initial room state to the user who just joined
        socket.emit('room_data', {
            isHost: isHost,
            playlist: room.playlist,
            currentVideo: room.currentVideo
        });

        // Announce to everyone in the room that the user list updated
        io.to(roomId).emit('update_users', room.users);
        
        // System chat message
        io.to(roomId).emit('chat_message', { system: true, text: `${username} joined the party 🍿` });

        // Update the public lobby list for everyone on the landing page
        emitActiveRooms();
    });

    /* =========================================
       2. MEDIA SYNCHRONIZATION ENGINE
       ========================================= */
    
    // Changing the video (Host only)
    socket.on('change_video', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host === socket.id) {
            room.currentVideo = { src: data.src, name: data.name, index: data.index };
            io.to(data.roomId).emit('load_video', room.currentVideo);
        }
    });

    // Updating the Playlist (Queue)
    socket.on('update_playlist', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host === socket.id) {
            room.playlist = data.playlist;
            // Broadcast to everyone else in the room
            socket.to(data.roomId).emit('sync_playlist', room.playlist);
        }
    });

    // Play Event
    socket.on('play_video', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host === socket.id) {
            socket.to(data.roomId).emit('sync_play', data.time);
        }
    });

    // Pause Event
    socket.on('pause_video', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host === socket.id) {
            socket.to(data.roomId).emit('sync_pause', data.time);
        }
    });

    // Force Sync (Viewer requests exact timestamp from Host)
    socket.on('request_sync_from_host', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host) {
            // Ask the host for their current timestamp
            io.to(room.host).emit('viewer_requests_sync');
        }
    });

    // Host replies with exact timestamp
    socket.on('broadcast_sync_data', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host === socket.id) {
            // Broadcast to all viewers to snap to this time
            socket.to(data.roomId).emit('host_send_sync', { time: data.time, state: data.state });
        }
    });

    /* =========================================
       3. CHAT & SOCIAL ENGINE
       ========================================= */
    socket.on('chat_message', (data) => {
        if (rooms[data.roomId]) {
            io.to(data.roomId).emit('chat_message', data);
        }
    });

    socket.on('emoji_reaction', (data) => {
        if (rooms[data.roomId]) {
            socket.to(data.roomId).emit('emoji_reaction', data.emoji);
        }
    });

    /* =========================================
       4. WEBRTC VOICE LOBBY SIGNALING
       ========================================= */
    socket.on('voice_join', (data) => {
        socket.to(data.roomId).emit('voice_user_joined', { socketId: socket.id });
    });

    socket.on('webrtc_offer', (data) => {
        io.to(data.target).emit('webrtc_offer', { sender: socket.id, sdp: data.sdp });
    });

    socket.on('webrtc_answer', (data) => {
        io.to(data.target).emit('webrtc_answer', { sender: socket.id, sdp: data.sdp });
    });

    socket.on('webrtc_ice', (data) => {
        io.to(data.target).emit('webrtc_ice', { sender: socket.id, candidate: data.candidate });
    });

    /* =========================================
       5. DISCONNECT & CLEANUP LOGIC
       ========================================= */
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        
        // Find which room this user was in
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const userIndex = room.users.findIndex(u => u.socketId === socket.id);
            
            if (userIndex !== -1) {
                const user = room.users[userIndex];
                
                // Alert room for Voice chat teardown
                socket.to(roomId).emit('voice_user_left', { socketId: socket.id });
                
                // System chat message
                io.to(roomId).emit('chat_message', { system: true, text: `${user.username} left the party 👋` });
                
                // Remove user from the room array
                room.users.splice(userIndex, 1);

                // If room is now empty, delete it from RAM
                if (room.users.length === 0) {
                    delete rooms[roomId];
                } else {
                    // If the HOST left, assign the crown to the next person in line
                    if (user.isHost) {
                        room.host = room.users[0].socketId;
                        room.users[0].isHost = true;
                        // Tell the lucky user they are the new host
                        io.to(room.host).emit('you_are_host');
                        io.to(roomId).emit('chat_message', { system: true, text: `👑 ${room.users[0].username} is the new Room Host` });
                    }
                    // Update user list for everyone remaining
                    io.to(roomId).emit('update_users', room.users);
                }
                
                emitActiveRooms();
                break; // User found and handled, exit loop
            }
        }
    });

    /* --- HELPER FUNCTION: Broadcast Public Rooms --- */
    function emitActiveRooms() {
        const publicRooms = Object.values(rooms)
            .filter(r => !r.password) // Only show rooms with no password
            .map(r => ({ id: r.id, name: r.name, users: r.users.length }));
        
        io.emit('active_rooms', publicRooms);
    }
});

// START THE SERVER
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ SyncTube Server is running on port ${PORT}`);
});
