const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, '../', 'users.db');

if (process.argv.length !== 5) {
    console.error("Usage: node update_limits.js <email> <max_query_usage_per_month>");
    process.exit(1);
}

const email = process.argv[2];
const maxQueryUsage = process.argv[3];

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error connecting to SQLite database:', err.message);
        process.exit(1);
    }
});

const sql = `UPDATE users SET max_query_usage_per_month = ? WHERE email = ?`;
db.run(sql, [maxTokenUsage, maxQueryUsage, email], (err) => {
    if (err) {
        console.error('Database error:', err.message);
        process.exit(1);
    }

    console.log(`Successfully updated limits for email: ${email}`);
    db.close();
});