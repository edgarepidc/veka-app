const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const SECRET = process.env.SECRET || 'veka-super-secret-key-2026';

app.use(cors());
app.use(express.json());

// Base de datos
const db = new sqlite3.Database('./veka.db');

// Crear tablas
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS residents (
    unit TEXT PRIMARY KEY,
    name TEXT,
    cluster TEXT,
    email TEXT,
    phone TEXT,
    status TEXT DEFAULT 'current'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'admin'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit TEXT,
    concept TEXT,
    amount REAL,
    date TEXT,
    status TEXT DEFAULT 'pending'
  )`);
});

// Insertar datos de ejemplo
const adminPassword = bcrypt.hashSync('admin123', 10);
db.run(`INSERT OR IGNORE INTO users (email, password, role) VALUES (?, ?, ?)`, ['admin@veka.com', adminPassword, 'admin']);

const residents = [
  ['304', 'María Fernández', 'Torre A', 'maria@veka.com', '+52 55 1234 5678', 'current'],
  ['201', 'Ana Pérez', 'Torre A', 'ana@veka.com', '+52 55 5555 6666', 'current'],
  ['401', 'Jorge Ruiz', 'Torre B', 'jorge@veka.com', '+52 55 7777 8888', 'overdue'],
];

const stmt = db.prepare(`INSERT OR IGNORE INTO residents (unit, name, cluster, email, phone, status) VALUES (?, ?, ?, ?, ?, ?)`);
residents.forEach(r => stmt.run(r));
stmt.finalize();

// Ruta de login
app.post('/api/login', (req, res) => {
  const { email, password, unit } = req.body;

  // Admin login
  if (email && password) {
    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
      if (err || !user) return res.status(401).json({ error: 'Credenciales inválidas' });
      if (bcrypt.compareSync(password, user.password)) {
        const token = jwt.sign({ email: user.email, role: 'admin' }, SECRET, { expiresIn: '24h' });
        res.json({ token, role: 'admin', name: 'Administrador' });
      } else {
        res.status(401).json({ error: 'Contraseña incorrecta' });
      }
    });
  } 
  // Resident login
  else if (unit) {
    db.get('SELECT * FROM residents WHERE unit = ?', [unit], (err, resident) => {
      if (err || !resident) return res.status(401).json({ error: 'Departamento no encontrado' });
      const token = jwt.sign({ unit: resident.unit, role: 'resident' }, SECRET, { expiresIn: '24h' });
      res.json({ token, role: 'resident', resident });
    });
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

// Ruta para obtener residente
app.get('/api/resident/:unit', authMiddleware, (req, res) => {
  db.get('SELECT * FROM residents WHERE unit = ?', [req.params.unit], (err, row) => {
    res.json(row || {});
  });
});

// Ruta para obtener transacciones
app.get('/api/transactions/:unit', authMiddleware, (req, res) => {
  db.all('SELECT * FROM transactions WHERE unit = ? ORDER BY date DESC', [req.params.unit], (err, rows) => {
    res.json(rows || []);
  });
});

app.listen(PORT, () => {
  console.log(`✅ Veka backend corriendo en http://localhost:${PORT}`);
});