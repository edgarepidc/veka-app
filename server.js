const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const SECRET = process.env.SECRET || 'veka-super-secret-key-2026';

app.use(cors());
app.use(express.json());

// Conexión a PostgreSQL (Railway)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Crear tablas automáticamente
async function initDB() {
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
  
  // Insertar datos de ejemplo
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
}

initDB();

// Login
app.post('/api/login', async (req, res) => {
  const { email, password, unit } = req.body;
  
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

app.listen(PORT, () => {
  console.log(`✅ Veka backend corriendo en http://localhost:${PORT}`);
});