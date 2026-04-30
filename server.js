const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// Memory bank to store all active rooms
const rooms = {}; 

io.on('connection', (socket) => {
    
    // 1. User joins a specific private room
    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        
        // If the room doesn't exist yet, create it and make this user the HOST
        if (!rooms[roomId]) {
            rooms[roomId] = { host: socket.id, playlist: [] };
        }
        
        // Tell the user their status (Host or Viewer) and send the current playlist
        const isHost = rooms[roomId].host === socket.id;
        socket.emit('room_data', { isHost: isHost, playlist: rooms[roomId].playlist });
    });

    // 2. Video Controls (Routing to specific rooms only)
    socket.on('change_video', (data) => {
        socket.to(data.roomId).emit('load_video', data);
    });

    socket.on('play_video', (data) => {
        socket.to(data.roomId).emit('sync_play', data.time);
    });

    socket.on('pause_video', (data) => {
        socket.to(data.roomId).emit('sync_pause', data.time);
    });

    // 3. Playlist Synchronization
    socket.on('update_playlist', (data) => {
        if (rooms[data.roomId]) {
            rooms[data.roomId].playlist = data.playlist;
            socket.to(data.roomId).emit('sync_playlist', data.playlist);
        }
    });

    socket.on('disconnect', () => {
        // Advanced: We can add logic here later to assign a new host if the creator leaves
    });
});

app.get('/', (req, res) => res.send("SyncTube Pro Backend Live!"));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
