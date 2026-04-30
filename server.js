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
    
    // 1. JOIN ROOM (Now uses Permanent User ID)
    socket.on('join_room', (data) => {
        const { roomId, username, userId } = data;
        socket.join(roomId);
        
        if (!rooms[roomId]) { rooms[roomId] = { hostUserId: userId, playlist: [], users: [], disconnectTimer: null }; }
        
        // If the host refreshed and came back, CANCEL the crown-pass timer!
        if (rooms[roomId].hostUserId === userId && rooms[roomId].disconnectTimer) {
            clearTimeout(rooms[roomId].disconnectTimer);
            rooms[roomId].disconnectTimer = null;
        }

        const isHost = rooms[roomId].hostUserId === userId;
        const newUser = { socketId: socket.id, userId, username: username || "Guest", isHost };
        
        // Remove any ghost clones of this user before adding them
        rooms[roomId].users = rooms[roomId].users.filter(u => u.userId !== userId);
        rooms[roomId].users.push(newUser);
        
        socket.emit('room_data', { isHost, playlist: rooms[roomId].playlist });
        io.to(roomId).emit('update_users', rooms[roomId].users);
        io.to(roomId).emit('chat_message', { system: true, text: `${newUser.username} joined the party.` });
    });

    socket.on('chat_message', (data) => io.to(data.roomId).emit('chat_message', { username: data.username, text: data.text }));

    // 2. TRANSFER HOST (Updated for User IDs)
    socket.on('transfer_host', (data) => {
        const room = rooms[data.roomId];
        const sender = room?.users.find(u => u.socketId === socket.id);
        if (sender && sender.isHost) {
            const newHost = room.users.find(u => u.userId === data.newHostUserId);
            if(newHost) {
                room.hostUserId = newHost.userId;
                room.users.forEach(u => u.isHost = (u.userId === newHost.userId));
                io.to(data.roomId).emit('update_users', room.users);
                io.to(newHost.socketId).emit('you_are_host');
                io.to(data.roomId).emit('chat_message', { system: true, text: `👑 ${newHost.username} is the new host.` });
            }
        }
    });

    socket.on('change_video', (data) => socket.to(data.roomId).emit('load_video', data));
    socket.on('play_video', (data) => socket.to(data.roomId).emit('sync_play', data.time));
    socket.on('pause_video', (data) => socket.to(data.roomId).emit('sync_pause', data.time));
    socket.on('update_playlist', (data) => { if (rooms[data.roomId]) { rooms[data.roomId].playlist = data.playlist; socket.to(data.roomId).emit('sync_playlist', data.playlist); }});

    // 3. DISCONNECT WITH GRACE PERIOD
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const userIndex = room.users.findIndex(u => u.socketId === socket.id);
            
            if (userIndex !== -1) {
                const user = room.users[userIndex];
                room.users.splice(userIndex, 1);
                io.to(roomId).emit('update_users', room.users);
                io.to(roomId).emit('chat_message', { system: true, text: `${user.username} disconnected.` });

                if (room.users.length === 0) {
                    delete rooms[roomId]; 
                } else if (user.isHost) {
                    // Host disconnected! Start a 10-second Grace Period
                    room.disconnectTimer = setTimeout(() => {
                        if (rooms[roomId] && rooms[roomId].users.length > 0) {
                            const newHost = rooms[roomId].users[0];
                            rooms[roomId].hostUserId = newHost.userId;
                            newHost.isHost = true;
                            io.to(roomId).emit('update_users', rooms[roomId].users);
                            io.to(newHost.socketId).emit('you_are_host');
                            io.to(roomId).emit('chat_message', { system: true, text: `👑 Host timed out. ${newHost.username} inherited the crown.` });
                        }
                    }, 10000); 
                }
                break;
            }
        }
    });
});

app.get('/', (req, res) => res.send("SyncTube Pro v4 Backend Live!"));
server.listen(process.env.PORT || 3000, () => console.log(`Server running`));
