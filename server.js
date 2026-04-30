const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const rooms = {}; 

function broadcastPublicRooms() {
    const publicRooms = Object.keys(rooms).map(id => ({
        id, name: rooms[id].name, isPrivate: !!rooms[id].password, users: rooms[id].users.length 
    })).filter(r => r.users > 0);
    io.emit('active_rooms', publicRooms);
}

io.on('connection', (socket) => {
    socket.emit('active_rooms', Object.keys(rooms).map(id => ({
        id, name: rooms[id].name, isPrivate: !!rooms[id].password, users: rooms[id].users.length 
    })).filter(r => r.users > 0));

    socket.on('join_room', (data, callback) => {
        const { roomId, roomName, password, username, userId } = data;
        
        if (rooms[roomId]) {
            if (rooms[roomId].password && rooms[roomId].password !== password) return callback({ success: false, message: "Incorrect Password." });
        } else {
            rooms[roomId] = {
                name: roomName || `Room ${roomId.substring(0,4)}`,
                password: password || null,
                hostUserId: userId,
                playlist: [],
                users: [],
                disconnectTimer: null,
                // NEW: Memory tracking for late joiners and refreshes
                currentVideo: null, 
                currentTime: 0,
                isPlaying: false
            };
        }

        socket.join(roomId);
        const room = rooms[roomId];

        if (room.hostUserId === userId && room.disconnectTimer) {
            clearTimeout(room.disconnectTimer);
            room.disconnectTimer = null;
        }

        const isHost = room.hostUserId === userId;
        const newUser = { socketId: socket.id, userId, username: username || "Guest", isHost };
        
        room.users = room.users.filter(u => u.userId !== userId);
        room.users.push(newUser);
        
        // NEW: Send current video state to the person who just joined
        socket.emit('room_data', { 
            isHost, 
            playlist: room.playlist, 
            roomName: room.name,
            currentVideo: room.currentVideo,
            currentTime: room.currentTime,
            isPlaying: room.isPlaying
        });
        
        io.to(roomId).emit('update_users', room.users);
        io.to(roomId).emit('chat_message', { system: true, text: `${newUser.username} joined.` });
        
        broadcastPublicRooms();
        callback({ success: true });
    });

    socket.on('chat_message', (data) => io.to(data.roomId).emit('chat_message', { username: data.username, text: data.text }));

    socket.on('transfer_host', (data) => {
        const room = rooms[data.roomId];
        if (room && room.hostUserId === data.senderUserId) {
            const newHost = room.users.find(u => u.userId === data.newHostUserId);
            if (newHost) {
                room.hostUserId = newHost.userId;
                room.users.forEach(u => u.isHost = (u.userId === newHost.userId));
                io.to(data.roomId).emit('update_users', room.users);
                io.to(newHost.socketId).emit('you_are_host');
                io.to(data.roomId).emit('chat_message', { system: true, text: `👑 ${newHost.username} is the new Host.` });
            }
        }
    });

    // NEW: Update server memory when Host changes video or plays/pauses
    socket.on('change_video', (data) => {
        if(rooms[data.roomId]) { rooms[data.roomId].currentVideo = data; rooms[data.roomId].currentTime = 0; }
        socket.to(data.roomId).emit('load_video', data);
    });
    
    socket.on('play_video', (data) => {
        if(rooms[data.roomId]) { rooms[data.roomId].currentTime = data.time; rooms[data.roomId].isPlaying = true; }
        socket.to(data.roomId).emit('sync_play', data.time);
    });
    
    socket.on('pause_video', (data) => {
        if(rooms[data.roomId]) { rooms[data.roomId].currentTime = data.time; rooms[data.roomId].isPlaying = false; }
        socket.to(data.roomId).emit('sync_pause', data.time);
    });

    socket.on('update_playlist', (data) => { if (rooms[data.roomId]) { rooms[data.roomId].playlist = data.playlist; socket.to(data.roomId).emit('sync_playlist', data.playlist); }});

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const userIndex = room.users.findIndex(u => u.socketId === socket.id);
            if (userIndex !== -1) {
                const user = room.users[userIndex];
                room.users.splice(userIndex, 1);
                io.to(roomId).emit('update_users', room.users);
                io.to(roomId).emit('chat_message', { system: true, text: `${user.username} left.` });

                if (room.users.length === 0) {
                    delete rooms[roomId]; broadcastPublicRooms();
                } else if (user.isHost) {
                    room.disconnectTimer = setTimeout(() => {
                        if (rooms[roomId] && rooms[roomId].users.length > 0) {
                            const newHost = rooms[roomId].users[0];
                            rooms[roomId].hostUserId = newHost.userId; newHost.isHost = true;
                            io.to(roomId).emit('update_users', rooms[roomId].users);
                            io.to(newHost.socketId).emit('you_are_host');
                            io.to(roomId).emit('chat_message', { system: true, text: `👑 Host timed out. ${newHost.username} is Host.` });
                        }
                    }, 60000); 
                }
                broadcastPublicRooms(); break;
            }
        }
    });
});

app.get('/', (req, res) => res.send("SyncTube Master Server v3"));
server.listen(process.env.PORT || 3000, () => console.log(`Server running`));
