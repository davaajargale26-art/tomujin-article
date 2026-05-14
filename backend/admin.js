const bcrypt = require("bcrypt");
const mysql = require("mysql2/promise");

async function main() {
  const db = await mysql.createConnection({
    host: "localhost",
    user: "news_user",
    password: "Tomujin123!",
    database: "login_app"
  });

  const passwordHash = await bcrypt.hash("admin12345", 10);

  await db.execute(
    `INSERT INTO admins (name, email, password_hash, role)
     VALUES (?, ?, ?, ?)`,
    [
      "Davaajargal",
      "davaajargal.e26@tomujin.edu.mn",
      passwordHash,
      "owner"
    ]
  );

  console.log("Admin created successfully");
  process.exit();
}

main();