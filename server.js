const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// The Universal Sync Hub
io.on('connection', (socket) => {
    console.log(`Agent Connected: ${socket.id}`);

    // Broadcast the new video (Whether it's YouTube or MP4)
    socket.on('change_video', (data) => {
        socket.broadcast.emit('load_video', data);
    });

    // Broadcast PLAY
    socket.on('play_video', (time) => {
        socket.broadcast.emit('sync_play', time);
    });

    // Broadcast PAUSE
    socket.on('pause_video', (time) => {
        socket.broadcast.emit('sync_pause', time);
    });

    socket.on('disconnect', () => {
        console.log(`Agent Disconnected: ${socket.id}`);
    });
});

app.get('/', (req, res) => {
    res.send("Universal Sync Server is Live!");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sync Server running on port ${PORT}`);
});
