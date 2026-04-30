const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const rooms = {}; 

io.on('connection', (socket) => {
    
    // 1. JOIN ROOM & USER TRACKING
    socket.on('join_room', (data) => {
        const { roomId, username } = data;
        socket.join(roomId);
        
        if (!rooms[roomId]) { rooms[roomId] = { host: socket.id, playlist: [], users: [] }; }
        
        const isHost = rooms[roomId].host === socket.id;
        const newUser = { id: socket.id, username: username || "Guest", isHost };
        rooms[roomId].users.push(newUser);
        
        socket.emit('room_data', { isHost, playlist: rooms[roomId].playlist });
        io.to(roomId).emit('update_users', rooms[roomId].users);
        io.to(roomId).emit('chat_message', { system: true, text: `${newUser.username} joined the party.` });
    });

    // 2. SOCIAL CHAT
    socket.on('chat_message', (data) => {
        io.to(data.roomId).emit('chat_message', { username: data.username, text: data.text });
    });

    // 3. ROOM MANAGEMENT (PASS THE CROWN)
    socket.on('transfer_host', (data) => {
        if (rooms[data.roomId] && rooms[data.roomId].host === socket.id) {
            rooms[data.roomId].host = data.newHostId;
            rooms[data.roomId].users.forEach(u => u.isHost = (u.id === data.newHostId));
            io.to(data.roomId).emit('update_users', rooms[data.roomId].users);
            io.to(data.newHostId).emit('you_are_host');
            io.to(data.roomId).emit('chat_message', { system: true, text: `👑 A new Host has been crowned.` });
        }
    });

    // 4. VIDEO & PLAYLIST ROUTING
    socket.on('change_video', (data) => socket.to(data.roomId).emit('load_video', data));
    socket.on('play_video', (data) => socket.to(data.roomId).emit('sync_play', data.time));
    socket.on('pause_video', (data) => socket.to(data.roomId).emit('sync_pause', data.time));
    socket.on('update_playlist', (data) => {
        if (rooms[data.roomId]) { rooms[data.roomId].playlist = data.playlist; socket.to(data.roomId).emit('sync_playlist', data.playlist); }
    });

    // 5. DISCONNECT & AUTO-CROWN NEW HOST
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const userIndex = room.users.findIndex(u => u.id === socket.id);
            if (userIndex !== -1) {
                const user = room.users[userIndex];
                room.users.splice(userIndex, 1);
                io.to(roomId).emit('chat_message', { system: true, text: `${user.username} left.` });

                if (room.host === socket.id && room.users.length > 0) {
                    room.host = room.users[0].id; // Give crown to the next oldest user
                    room.users[0].isHost = true;
                    io.to(roomId).emit('update_users', room.users);
                    io.to(room.host).emit('you_are_host');
                    io.to(roomId).emit('chat_message', { system: true, text: `👑 ${room.users[0].username} is the new host.` });
                } else if (room.users.length === 0) {
                    delete rooms[roomId]; 
                } else {
                    io.to(roomId).emit('update_users', room.users);
                }
                break;
            }
        }
    });
});

app.get('/', (req, res) => res.send("SyncTube Pro v3 Backend Live!"));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
