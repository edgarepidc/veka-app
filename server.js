const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const SECRET = process.env.SECRET || 'veka-super-secret-key-2026';

// CORS configuración completa para Netlify
const allowedOrigins = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://veka-app-viva.netlify.app',
  'https://*.netlify.app'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.includes('netlify.app') || origin === o)) {
      return callback(null, true);
    }
    console.log('Origen bloqueado por CORS:', origin);
    callback(null, true); // Permitir igualmente para debug
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Conexión a PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Crear tablas
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS residents (
        unit TEXT PRIMARY KEY,
        name TEXT,
        cluster TEXT,
        email TEXT,
        phone TEXT,
        status TEXT DEFAULT 'current'
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'admin'
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        unit TEXT,
        concept TEXT,
        amount REAL,
        date TEXT,
        status TEXT DEFAULT 'pending'
      )
    `);
    
    const adminPassword = bcrypt.hashSync('admin123', 10);
    await pool.query(`INSERT INTO users (email, password, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING`, 
      ['admin@veka.com', adminPassword, 'admin']);
    
    const residents = [
      ['304', 'María Fernández', 'Torre A', 'maria@veka.com', '+52 55 1234 5678', 'current'],
      ['201', 'Ana Pérez', 'Torre A', 'ana@veka.com', '+52 55 5555 6666', 'current'],
      ['401', 'Jorge Ruiz', 'Torre B', 'jorge@veka.com', '+52 55 7777 8888', 'overdue'],
    ];
    
    for (const r of residents) {
      await pool.query(`INSERT INTO residents (unit, name, cluster, email, phone, status) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (unit) DO NOTHING`, r);
    }
    
    console.log('✅ Base de datos PostgreSQL inicializada');
  } catch (error) {
    console.error('Error en initDB:', error);
  }
}

initDB();

// Ruta de prueba
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Login
app.post('/api/login', async (req, res) => {
  console.log('Login request recibida:', req.body);
  const { email, password, unit } = req.body;
  
  try {
    if (email && password) {
      const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      if (result.rows.length === 0) return res.status(401).json({ error: 'Credenciales inválidas' });
      const user = result.rows[0];
      if (bcrypt.compareSync(password, user.password)) {
        const token = jwt.sign({ email: user.email, role: 'admin' }, SECRET, { expiresIn: '24h' });
        res.json({ token, role: 'admin', name: 'Administrador' });
      } else {
        res.status(401).json({ error: 'Contraseña incorrecta' });
      }
    } else if (unit) {
      const result = await pool.query('SELECT * FROM residents WHERE unit = $1', [unit]);
      if (result.rows.length === 0) return res.status(401).json({ error: 'Departamento no encontrado' });
      const resident = result.rows[0];
      const token = jwt.sign({ unit: resident.unit, role: 'resident' }, SECRET, { expiresIn: '24h' });
      res.json({ token, role: 'resident', resident });
    } else {
      res.status(400).json({ error: 'Faltan datos' });
    }
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Middleware de autenticación
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token inválido' });
  }
}

app.get('/api/resident/:unit', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM residents WHERE unit = $1', [req.params.unit]);
  res.json(result.rows[0] || {});
});

app.get('/api/transactions/:unit', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM transactions WHERE unit = $1 ORDER BY date DESC', [req.params.unit]);
  res.json(result.rows);
});
// ─── FEED ENDPOINTS ─────────────────────────────────────────────────────────

// Obtener todos los posts del feed
app.get('/api/feed', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, 
        COALESCE(json_agg(DISTINCT r.emoji) FILTER (WHERE r.emoji IS NOT NULL), '[]') as reactions,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', c.id, 'author', c.author, 'content', c.content, 'created_at', c.created_at)) FILTER (WHERE c.id IS NOT NULL), '[]') as comments
      FROM feed_posts p
      LEFT JOIN post_reactions r ON p.id = r.post_id
      LEFT JOIN post_comments c ON p.id = c.post_id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching feed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Crear un nuevo post
app.post('/api/feed', authMiddleware, async (req, res) => {
  const { content, type } = req.body;
  const unit = req.user.unit || '304';
  
  try {
    // Obtener datos del residente
    const residentResult = await pool.query('SELECT name FROM residents WHERE unit = $1', [unit]);
    const author = residentResult.rows[0]?.name || 'Residente';
    const avatar = author.split(' ').map(w => w[0]).join('').slice(0, 2);
    
    const result = await pool.query(
      `INSERT INTO feed_posts (unit, author, avatar, content, type) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [unit, author, avatar, content, type || 'post']
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating post:', error);
    res.status(500).json({ error: error.message });
  }
});

// Agregar reacción a un post
app.post('/api/feed/:postId/react', authMiddleware, async (req, res) => {
  const { postId } = req.params;
  const { emoji } = req.body;
  const unit = req.user.unit || '304';
  
  try {
    await pool.query(
      `INSERT INTO post_reactions (post_id, unit, emoji) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (post_id, unit) DO UPDATE SET emoji = $3`,
      [postId, unit, emoji]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error adding reaction:', error);
    res.status(500).json({ error: error.message });
  }
});

// Agregar comentario a un post
app.post('/api/feed/:postId/comment', authMiddleware, async (req, res) => {
  const { postId } = req.params;
  const { content } = req.body;
  const unit = req.user.unit || '304';
  
  try {
    const residentResult = await pool.query('SELECT name FROM residents WHERE unit = $1', [unit]);
    const author = residentResult.rows[0]?.name || 'Residente';
    
    const result = await pool.query(
      `INSERT INTO post_comments (post_id, unit, author, content) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [postId, unit, author, content]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ error: error.message });
  }
});
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Veka backend corriendo en puerto ${PORT}`);
  console.log(`✅ Health check: /api/health`);
});