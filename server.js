/*
  TN CM Poll 2026 — Server with MongoDB Persistence
  ─────────────────────────────────────────────────
  Votes survive restarts, deployments, and scaling.

  SETUP (5 minutes):
  1. Go to https://mongodb.com/atlas → create FREE cluster
  2. Database Access → Add user with password
  3. Network Access → Add IP → Allow 0.0.0.0/0 (all IPs)
  4. Cluster → Connect → Drivers → copy connection string
  5. Set environment variable:
       MONGODB_URI=mongodb+srv://youruser:yourpass@cluster.mongodb.net/tnpoll
  6. npm install   (adds mongoose)
  7. node server.js
*/

const express    = require('express');
const cors       = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

/* ─────────────────────────────────────────
   SCHEMAS
───────────────────────────────────────── */

// One document per candidate — holds the running count
const voteSchema = new mongoose.Schema({
  candidateId: { type: String, required: true, unique: true },
  count:       { type: Number, default: 0 }
});

// One document per voter — prevents duplicate votes
const voterSchema = new mongoose.Schema({
  userId:      { type: String, required: true, unique: true },
  candidateId: { type: String, required: true },
  votedAt:     { type: Date,   default: Date.now }
});

const VoteDoc  = mongoose.model('Vote',  voteSchema);
const VoterDoc = mongoose.model('Voter', voterSchema);

const CANDIDATES = ['candidate1', 'candidate2', 'candidate3', 'candidate4'];
let connectedClients = 0;
let useDB = false;

/* ─────────────────────────────────────────
   IN-MEMORY FALLBACK (when no DB is set)
───────────────────────────────────────── */
const memVotes  = { candidate1: 0, candidate2: 0, candidate3: 0, candidate4: 0 };
const memVoters = new Map();

/* ─────────────────────────────────────────
   DB CONNECT + SEED
───────────────────────────────────────── */
async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('\n⚠️  MONGODB_URI not set — running in MEMORY mode.');
    console.warn('   Votes will reset every time the server restarts.');
    console.warn('   Set MONGODB_URI for persistent votes.\n');
    return false;
  }
  try {
    await mongoose.connect(uri);
    console.log('✅  MongoDB connected — votes are persistent');
    // Ensure a document exists for every candidate
    for (const id of CANDIDATES) {
      await VoteDoc.findOneAndUpdate(
        { candidateId: id },
        { $setOnInsert: { candidateId: id, count: 0 } },
        { upsert: true }
      );
    }
    return true;
  } catch (err) {
    console.error('❌  MongoDB failed:', err.message);
    console.warn('   Falling back to in-memory mode.\n');
    return false;
  }
}

/* ─────────────────────────────────────────
   SHARED HELPERS
───────────────────────────────────────── */
async function getVoteData() {
  let votes = {};
  if (useDB) {
    const docs = await VoteDoc.find({ candidateId: { $in: CANDIDATES } });
    CANDIDATES.forEach(id => { votes[id] = 0; });
    docs.forEach(d => { votes[d.candidateId] = d.count; });
  } else {
    votes = { ...memVotes };
  }
  const total = Object.values(votes).reduce((a, b) => a + b, 0);
  const percentages = {};
  CANDIDATES.forEach(id => {
    percentages[id] = total > 0 ? ((votes[id] / total) * 100).toFixed(1) : '0';
  });
  return { votes, total, percentages, connectedClients };
}

async function hasUserVoted(userId) {
  if (useDB) {
    const doc = await VoterDoc.findOne({ userId });
    return doc ? doc.candidateId : null;
  }
  return memVoters.get(userId) || null;
}

async function recordVote(userId, candidateId) {
  if (useDB) {
    // $inc is atomic — safe against simultaneous requests
    await VoteDoc.updateOne({ candidateId }, { $inc: { count: 1 } });
    await VoterDoc.create({ userId, candidateId });
  } else {
    memVotes[candidateId]++;
    memVoters.set(userId, candidateId);
  }
}

/* ─────────────────────────────────────────
   ROUTES
───────────────────────────────────────── */
app.get('/api/votes', async (req, res) => {
  try {
    res.json(await getVoteData());
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch votes' });
  }
});

app.post('/api/vote', async (req, res) => {
  const { candidateId, userId } = req.body;

  if (!candidateId || !CANDIDATES.includes(candidateId))
    return res.status(400).json({ error: 'Invalid candidate' });

  if (!userId || typeof userId !== 'string' || userId.length > 80)
    return res.status(400).json({ error: 'Missing or invalid user ID' });

  try {
    const already = await hasUserVoted(userId);
    if (already)
      return res.status(400).json({
        error: 'You have already voted',
        alreadyVoted: true,
        candidateId: already
      });

    await recordVote(userId, candidateId);
    const data = await getVoteData();
    io.emit('voteUpdate', data);   // instant push to every open browser tab
    res.json({ success: true, data });

  } catch (err) {
    // Duplicate key = two simultaneous submissions from same user
    if (err.code === 11000)
      return res.status(400).json({ error: 'You have already voted', alreadyVoted: true });

    console.error('Vote error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

app.get('/api/check-vote/:userId', async (req, res) => {
  try {
    const candidateId = await hasUserVoted(req.params.userId);
    res.json({ voted: !!candidateId, candidateId: candidateId || null });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Quick health/stats check
app.get('/api/stats', async (req, res) => {
  try {
    const data = await getVoteData();
    const totalVoters = useDB ? await VoterDoc.countDocuments() : memVoters.size;
    res.json({ ...data, totalVoters, dbConnected: useDB, connectedClients });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/* ─────────────────────────────────────────
   SOCKET.IO
───────────────────────────────────────── */
io.on('connection', async (socket) => {
  connectedClients++;
  try {
    socket.emit('initialData', await getVoteData());
  } catch (e) {
    socket.emit('initialData', { votes: {}, total: 0, percentages: {}, connectedClients: 0 });
  }
  io.emit('clientCount', { connectedClients });

  socket.on('disconnect', () => {
    connectedClients = Math.max(0, connectedClients - 1);
    io.emit('clientCount', { connectedClients });
  });
});

/* ─────────────────────────────────────────
   START
───────────────────────────────────────── */
const PORT = process.env.PORT || 3000;

(async () => {
  useDB = await connectDB();
  httpServer.listen(PORT, () => {
    console.log(`\n🏛️  TN CM Poll 2026  →  http://localhost:${PORT}`);
    console.log(`   Storage : ${useDB ? 'MongoDB ✅ (votes persist)' : 'Memory ⚠️  (votes reset on restart)'}\n`);
  });
})();