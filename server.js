require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50e6 });

// ── Optional Cloudinary setup (falls back to local disk if no credentials or account issue) ──
let cloudinary = null;
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY) {
  const { v2: cld } = require('cloudinary');
  cld.config({
    cloud_name:  process.env.CLOUDINARY_CLOUD_NAME,
    api_key:     process.env.CLOUDINARY_API_KEY,
    api_secret:  process.env.CLOUDINARY_API_SECRET,
  });
  // Test the connection before committing to cloud storage
  cld.api.ping((err) => {
    if (err) {
      console.warn('⚠️  Cloudinary not available (' + (err.message || err) + ') — falling back to local disk storage.');
      cloudinary = null;
    } else {
      cloudinary = cld;
      console.log('✅  Cloudinary connected — PDFs stored in cloud for 30 days');
    }
  });
} else {
  console.log('ℹ️   No Cloudinary credentials — PDFs stored locally.');
}

const rooms = new Map();
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

// ── Helper: create a fresh room object ──
function makeRoom() {
  return {
    users:       new Set(),
    currentPage: 1,
    bookUrl:     null,
    bookPublicId: null,
    bookName:    null,
    createdAt:   Date.now(),
    expiresAt:   Date.now() + THIRTY_DAYS,
  };
}

// Pre-create master room
rooms.set('DEA026', makeRoom());

// ── Upload storage ──
const uploadDir = process.env.VERCEL
  ? '/tmp/uploads'
  : path.join(__dirname, 'uploads');

if (!cloudinary) {
  // Local disk storage fallback
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files allowed'));
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Serve local uploads if not using Cloudinary
if (!cloudinary) {
  app.use('/uploads', express.static(uploadDir));
}

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ── Serve index.html for shareable room links ──
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Upload endpoint ──
app.post('/upload/:roomId', upload.single('book'), async (req, res) => {
  const { roomId } = req.params;
  if (!rooms.has(roomId)) return res.status(400).json({ error: 'Room not found' });
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

  const room = rooms.get(roomId);

  try {
    let bookUrl;
    let bookPublicId;

    if (cloudinary) {
      // Delete old file from Cloudinary
      if (room.bookPublicId) {
        await cloudinary.uploader.destroy(room.bookPublicId, { resource_type: 'raw' }).catch(() => {});
      }

      // Upload buffer to Cloudinary
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'raw',
            folder: 'together-reader',
            public_id: `${roomId}-${Date.now()}`,
            invalidate: true,
          },
          (error, result) => error ? reject(error) : resolve(result)
        );
        const readable = new Readable();
        readable.push(req.file.buffer);
        readable.push(null);
        readable.pipe(stream);
      });

      bookUrl = uploadResult.secure_url;
      bookPublicId = uploadResult.public_id;
    } else {
      // Local disk fallback
      if (room.bookPublicId) {
        try { fs.unlinkSync(path.join(uploadDir, room.bookPublicId)); } catch (e) {}
      }
      const filename = `${Date.now()}-${req.file.originalname}`;
      fs.writeFileSync(path.join(uploadDir, filename), req.file.buffer);
      bookUrl      = `/uploads/${filename}`;
      bookPublicId = filename;
    }

    room.bookUrl      = bookUrl;
    room.bookPublicId = bookPublicId;
    room.bookName     = req.file.originalname.replace(/\.pdf$/i, '');
    room.currentPage  = 1;
    room.expiresAt    = Date.now() + THIRTY_DAYS;

    io.to(roomId).emit('book-updated', {
      bookPath:    room.bookUrl,
      bookName:    room.bookName,
      currentPage: 1,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// ── Socket.io ──
io.on('connection', (socket) => {

  socket.on('create-room', (callback) => {
    // Leave previous room if any
    leaveRoom(socket);

    const roomId = generateRoomId();
    rooms.set(roomId, makeRoom());
    socket.join(roomId);
    socket.roomId = roomId;
    rooms.get(roomId).users.add(socket.id);
    console.log(`[ROOM] User ${socket.id} created room ${roomId}`);
    callback({ roomId });
  });

  socket.on('join-room', ({ roomId }, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback({ error: 'Room not found. Check the code and try again.' });

    // Leave previous room if any
    leaveRoom(socket);

    // Capture existing peer IDs BEFORE adding the new socket
    const existingPeers = [...room.users];

    socket.join(roomId);
    socket.roomId = roomId;
    room.users.add(socket.id);

    console.log(`[ROOM] User ${socket.id} joined room ${roomId}`);

    // Notify existing users that a new peer joined (so they can initiate WebRTC)
    socket.to(roomId).emit('peer-joined', { peerId: socket.id });

    callback({
      success:     true,
      bookPath:    room.bookUrl,
      bookName:    room.bookName,
      currentPage: room.currentPage,
      userCount:   room.users.size,
      peers:       existingPeers,  // used by new joiner to connect to existing users
    });
  });

  function leaveRoom(socket) {
    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    room.users.delete(socket.id);
    socket.leave(roomId);
    io.to(roomId).emit('peer-left', { peerId: socket.id, userCount: room.users.size });
    console.log(`[ROOM] User ${socket.id} left room ${roomId}`);

    // Schedule cleanup for empty non-master rooms
    // NOTE: setTimeout max value is 2,147,483,647 (~24.8 days)
    if (room.users.size === 0 && roomId !== 'DEA026') {
      const timeoutVal = Math.min(THIRTY_DAYS, 2147483647);
      setTimeout(async () => {
        if (!rooms.has(roomId) || rooms.get(roomId).users.size !== 0) return;
        const r = rooms.get(roomId);
        if (cloudinary && r.bookPublicId) {
          await cloudinary.uploader.destroy(r.bookPublicId, { resource_type: 'raw' }).catch(() => {});
        } else if (!cloudinary && r.bookPublicId) {
          try { fs.unlinkSync(path.join(uploadDir, r.bookPublicId)); } catch (e) {}
        }
        rooms.delete(roomId);
        console.log(`[ROOM] Room ${roomId} cleaned up after ${timeoutVal}ms`);
      }, timeoutVal);
    }
    delete socket.roomId;
  }

  socket.on('page-change', ({ page }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.currentPage = page;
    socket.to(socket.roomId).emit('page-synced', { page });
  });

  socket.on('reaction', ({ emoji }) => {
    socket.to(socket.roomId).emit('reaction', { emoji });
  });

  socket.on('switch-book', ({ bookPath, bookName, currentPage }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.bookUrl     = bookPath;
    room.bookName    = bookName;
    room.currentPage = currentPage;
    socket.to(socket.roomId).emit('book-switched', { bookPath, bookName, currentPage });
  });

  // ── Mic presence ──
  socket.on('mic-on',  () => socket.to(socket.roomId).emit('peer-mic-on',  { peerId: socket.id }));
  socket.on('mic-off', () => socket.to(socket.roomId).emit('peer-mic-off', { peerId: socket.id }));

  // ── WebRTC signaling — all targeted to specific peer ──
  socket.on('webrtc-offer',  ({ to, sdp })       => io.to(to).emit('webrtc-offer',  { from: socket.id, sdp }));
  socket.on('webrtc-answer', ({ to, sdp })       => io.to(to).emit('webrtc-answer', { from: socket.id, sdp }));
  socket.on('webrtc-ice',    ({ to, candidate }) => io.to(to).emit('webrtc-ice',    { from: socket.id, candidate }));

  socket.on('disconnect', () => {
    leaveRoom(socket);
  });
});

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n  Together Reader → http://localhost:${PORT}\n`);
  });
}

module.exports = server;
