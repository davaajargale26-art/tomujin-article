const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) return;

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    });
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, "``")}\``;
}

loadEnvFile(path.join(__dirname, ".env"));

const app = express();
const PORT = Number(process.env.PORT) || 8890;
const publicPath = path.join(__dirname, "..", "frontend", "public");
const adminPassword = process.env.ADMIN_PASSWORD || "";

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const dbName = process.env.DB_NAME || "loginapp";
const dbBaseConfig = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  waitForConnections: true,
  connectionLimit: 10,
};

if (isEnabled(process.env.DB_SSL || process.env.TIDB_ENABLE_SSL)) {
  dbBaseConfig.ssl = { minVersion: "TLSv1.2" };
}

const db = mysql.createPool({
  ...dbBaseConfig,
  database: dbName,
});

let usingMemoryStore = false;
let memoryCategories = [];
let memoryArticles = [];
let nextMemoryArticleId = 1;

function hasAdminAccess(req) {
  if (!adminPassword) return true;
  return req.get("x-admin-password") === adminPassword;
}

const seedCategories = [
  ["guides", "Зөвлөгөө"],
  ["culture", "Соёл"],
  ["games", "Тоглоом"],
  ["updates", "Шинэ мэдээ"],
];

const visibleCategorySlugs = seedCategories.map(([slug]) => slug);

const seedArticles = [
  {
    slug: "tomujin-first-note",
    category: "updates",
    title: "Tomujin Article нээгдлээ",
    excerpt: "Сурагчдын бичсэн нийтлэл, бодол, тэмдэглэлийг нэг дор цэгцтэй унших шинэ булан.",
    body:
      "Tomujin Article бол сурагчдын бичсэн нийтлэл, тэмдэглэл, бодлыг цэгцтэй харуулах зориулалттай нийтлэлийн талбар юм.\n\nЭхний хувилбар нь хайлт, ангилал, дэлгэрэнгүй унших хуудас, нийтлэл нэмэх хэсэгтэй. Дараагийн шатанд онлайн өгөгдлийн сан холбогдсоноор нийтлэлүүд байнга хадгалагдана.",
    author: "Tomujin Editorial",
    imageUrl: "/images/stagknight.jpg",
    featured: true,
  },
  {
    slug: "quiet-voices",
    category: "culture",
    title: "Тайван хоолойнуудын булан",
    excerpt: "Уншигчдад зориулсан төвлөрсөн, тайван нийтлэлийн орчин.",
    body:
      "Энэ сайт худалдан авалтгүй, бүртгэлгүй. Зөвхөн нийтлэл унших, нийтлэх урсгалд төвлөрнө.\n\nНүүр хэсэг, ангилал, хайлт, нийтлэлийн дэлгэрэнгүй хуудас бүгд нэг backend-ээр ажиллаж байгаа тул дараа нь өгөгдлийн санг солиход үндсэн хэрэглээ хэвээр үлдэнэ.",
    author: "Tomujin Editorial",
    imageUrl: "/images/stagknight.jpg",
    featured: true,
  },
  {
    slug: "how-to-read-updates",
    category: "guides",
    title: "Нийтлэлийг хурдан олох нь",
    excerpt: "Хайлт болон ангиллаар хэрэгтэй нийтлэлээ хурдан олох боломжтой.",
    body:
      "Дээд хэсгийн хайлт дээр түлхүүр үг бичээд Enter дарахад тохирох нийтлэлүүд гарна. Хэрэв ганцхан нийтлэл олдвол шууд унших хуудас руу орно.\n\nНийтлэлийн карт дээр дарахад дэлгэрэнгүй хуудас нээгдэнэ. Ингэснээр нүүр хуудас хурдан уншигдаж, нийтлэл бүр тусдаа төвлөрсөн хэлбэртэй харагдана.",
    author: "Guide Desk",
    imageUrl: "/images/stagknight.jpg",
    featured: false,
  },
  {
    slug: "weekly-notes",
    category: "games",
    title: "Долоо хоногийн тэмдэглэл",
    excerpt: "Богино бодол, ажиглалт, сонирхолтой санаанууд нэг дор.",
    body:
      "Мэдээний сайт дээр соёл, зарлал, зөвлөгөө, хувийн тэмдэглэл зэрэг төрлийн нийтлэлүүдийг тусад нь ангилж хадгална.\n\nЭнэ бүтэц нь жижиг сургуулийн нийтлэлийн талбар, клубийн мэдээллийн булан, эсвэл хувийн editorial сайт болж өргөжихөд бэлэн.",
    author: "Article Desk",
    imageUrl: "/images/stagknight.jpg",
    featured: false,
  },
];

function initializeMemoryStore() {
  memoryCategories = seedCategories.map(([slug, name], index) => ({
    id: index + 1,
    slug,
    name,
  }));

  const categoryIds = Object.fromEntries(memoryCategories.map((category) => [category.slug, category.id]));

  memoryArticles = seedArticles.map((article, index) => ({
    id: index + 1,
    slug: article.slug,
    category_id: categoryIds[article.category],
    title: article.title,
    excerpt: article.excerpt,
    body: article.body,
    author: article.author,
    image_url: article.imageUrl,
    featured: article.featured ? 1 : 0,
    published_at: new Date(Date.now() - index * 60 * 60 * 1000).toISOString(),
  }));

  nextMemoryArticleId = memoryArticles.length + 1;
}

function mapMemoryArticle(article) {
  const category = memoryCategories.find((item) => item.id === article.category_id);

  return {
    id: article.id,
    slug: article.slug,
    title: article.title,
    excerpt: article.excerpt,
    body: article.body,
    author: article.author,
    imageUrl: article.image_url,
    featured: Boolean(article.featured),
    publishedAt: article.published_at,
    category: {
      id: category.id,
      slug: category.slug,
      name: category.name,
    },
  };
}

function getMemoryCategories() {
  return memoryCategories
    .filter((category) => visibleCategorySlugs.includes(category.slug))
    .map((category) => ({
      id: category.id,
      slug: category.slug,
      name: category.name,
      articleCount: memoryArticles.filter((article) => article.category_id === category.id).length,
    }));
}

function getMemoryArticles({ q = "", category = "" } = {}) {
  const search = String(q).trim().toLowerCase();

  return memoryArticles
    .filter((article) => {
      const categoryInfo = memoryCategories.find((item) => item.id === article.category_id);
      if (!categoryInfo || !visibleCategorySlugs.includes(categoryInfo.slug)) return false;
      if (category && category !== "all" && categoryInfo.slug !== category) return false;
      if (!search) return true;

      return [article.title, article.excerpt, article.body, article.author].some((value) =>
        String(value).toLowerCase().includes(search)
      );
    })
    .sort((left, right) => {
      if (right.featured !== left.featured) return right.featured - left.featured;
      return new Date(right.published_at) - new Date(left.published_at) || right.id - left.id;
    })
    .map(mapMemoryArticle);
}

function getMemoryArticle(slug) {
  const article = memoryArticles.find((item) => item.slug === slug);
  return article ? mapMemoryArticle(article) : null;
}

function validateArticlePayload(payload) {
  const article = {
    title: String(payload.title || "").trim(),
    excerpt: String(payload.excerpt || "").trim(),
    body: String(payload.body || "").trim(),
    author: String(payload.author || "").trim(),
    categorySlug: String(payload.categorySlug || "").trim(),
    imageUrl: String(payload.imageUrl || "").trim() || "/images/stagknight.jpg",
  };

  if (!article.title || !article.excerpt || !article.body || !article.author || !article.categorySlug) {
    const error = new Error("Please fill every required field.");
    error.statusCode = 400;
    throw error;
  }

  if (!visibleCategorySlugs.includes(article.categorySlug)) {
    const error = new Error("Unknown category.");
    error.statusCode = 400;
    throw error;
  }

  return article;
}

function createMemoryArticle(payload) {
  const payloadArticle = validateArticlePayload(payload);
  const category = memoryCategories.find((item) => item.slug === payloadArticle.categorySlug);

  if (!category) {
    const error = new Error("Category not found.");
    error.statusCode = 400;
    throw error;
  }

  const article = {
    id: nextMemoryArticleId,
    slug: makeSlug(payloadArticle.title),
    category_id: category.id,
    title: payloadArticle.title,
    excerpt: payloadArticle.excerpt,
    body: payloadArticle.body,
    author: payloadArticle.author,
    image_url: payloadArticle.imageUrl,
    featured: 0,
    published_at: new Date().toISOString(),
  };

  nextMemoryArticleId += 1;
  memoryArticles.unshift(article);
  return mapMemoryArticle(article);
}

function deleteMemoryArticle(slug) {
  const originalLength = memoryArticles.length;
  memoryArticles = memoryArticles.filter((article) => article.slug !== slug);
  return memoryArticles.length !== originalLength;
}

function categoryPlaceholders() {
  return visibleCategorySlugs.map(() => "?").join(", ");
}

async function ensureDatabase() {
  const adminDb = mysql.createPool(dbBaseConfig);
  await adminDb.query(`CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await adminDb.end();
}

async function initializeNews() {
  await ensureDatabase();

  await db.query(`
    CREATE TABLE IF NOT EXISTS news_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(80) NOT NULL UNIQUE,
      name VARCHAR(140) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS news_articles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(160) NOT NULL UNIQUE,
      category_id INT NOT NULL,
      title VARCHAR(220) NOT NULL,
      excerpt TEXT NOT NULL,
      body TEXT NOT NULL,
      author VARCHAR(140) NOT NULL,
      image_url VARCHAR(255) NULL,
      featured TINYINT(1) NOT NULL DEFAULT 0,
      published_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES news_categories(id)
    )
  `);

  await db.query(
    "INSERT INTO news_categories (slug, name) VALUES ? ON DUPLICATE KEY UPDATE name = VALUES(name)",
    [seedCategories]
  );

  const [categories] = await db.query("SELECT id, slug FROM news_categories");
  const categoryIds = Object.fromEntries(categories.map((category) => [category.slug, category.id]));

  const articleRows = seedArticles.map((article) => [
    article.slug,
    categoryIds[article.category],
    article.title,
    article.excerpt,
    article.body,
    article.author,
    article.imageUrl,
    article.featured ? 1 : 0,
  ]);

  await db.query(
    `INSERT INTO news_articles
      (slug, category_id, title, excerpt, body, author, image_url, featured)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      category_id = VALUES(category_id),
      title = VALUES(title),
      excerpt = VALUES(excerpt),
      body = VALUES(body),
      author = VALUES(author),
      image_url = VALUES(image_url),
      featured = VALUES(featured)`,
    [articleRows]
  );
}

function mapArticle(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    body: row.body,
    author: row.author,
    imageUrl: row.image_url,
    featured: Boolean(row.featured),
    publishedAt: row.published_at,
    category: {
      id: row.category_id,
      slug: row.category_slug,
      name: row.category_name,
    },
  };
}

function makeSlug(title) {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${base || "article"}-${Date.now().toString(36)}`;
}

app.get("/api/health", async (_req, res) => {
  if (usingMemoryStore) {
    res.json({ ok: true, database: false, storage: "memory", name: "tomujin-article-api" });
    return;
  }

  try {
    await db.query("SELECT 1");
    res.json({ ok: true, database: true, storage: "mysql", name: "tomujin-article-api" });
  } catch (error) {
    res.status(500).json({ ok: false, database: false, message: error.message });
  }
});

app.get("/api/categories", async (_req, res) => {
  if (usingMemoryStore) {
    res.json(getMemoryCategories());
    return;
  }

  try {
    const placeholders = categoryPlaceholders();
    const [rows] = await db.query(
      `
      SELECT c.id, c.slug, c.name, COUNT(a.id) AS articleCount
      FROM news_categories c
      LEFT JOIN news_articles a ON a.category_id = c.id
      WHERE c.slug IN (${placeholders})
      GROUP BY c.id, c.slug, c.name
      ORDER BY FIELD(c.slug, ${placeholders})
      `,
      [...visibleCategorySlugs, ...visibleCategorySlugs]
    );

    res.json(rows);
  } catch {
    res.status(500).json({ message: "Could not load categories." });
  }
});

app.get("/api/articles", async (req, res) => {
  if (usingMemoryStore) {
    const { q = "", category = "" } = req.query;
    res.json(getMemoryArticles({ q, category }));
    return;
  }

  try {
    const { q = "", category = "" } = req.query;
    const placeholders = categoryPlaceholders();
    const where = [`c.slug IN (${placeholders})`];
    const params = [...visibleCategorySlugs];

    if (category && category !== "all") {
      where.push("c.slug = ?");
      params.push(category);
    }

    if (q.trim()) {
      where.push("(LOWER(a.title) LIKE ? OR LOWER(a.excerpt) LIKE ? OR LOWER(a.body) LIKE ? OR LOWER(a.author) LIKE ?)");
      const search = `%${q.trim().toLowerCase()}%`;
      params.push(search, search, search, search);
    }

    const [rows] = await db.query(
      `
      SELECT
        a.id,
        a.slug,
        a.category_id,
        a.title,
        a.excerpt,
        a.body,
        a.author,
        a.image_url,
        a.featured,
        a.published_at,
        c.slug AS category_slug,
        c.name AS category_name
      FROM news_articles a
      JOIN news_categories c ON c.id = a.category_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.featured DESC, a.published_at DESC, a.id DESC
      `,
      params
    );

    res.json(rows.map(mapArticle));
  } catch {
    res.status(500).json({ message: "Could not load articles." });
  }
});

app.get("/api/articles/:slug", async (req, res) => {
  if (usingMemoryStore) {
    const article = getMemoryArticle(req.params.slug);

    if (!article) {
      return res.status(404).json({ message: "Article not found." });
    }

    res.json(article);
    return;
  }

  try {
    const [rows] = await db.query(
      `
      SELECT
        a.id,
        a.slug,
        a.category_id,
        a.title,
        a.excerpt,
        a.body,
        a.author,
        a.image_url,
        a.featured,
        a.published_at,
        c.slug AS category_slug,
        c.name AS category_name
      FROM news_articles a
      JOIN news_categories c ON c.id = a.category_id
      WHERE a.slug = ?
      LIMIT 1
      `,
      [req.params.slug]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Article not found." });
    }

    res.json(mapArticle(rows[0]));
  } catch {
    res.status(500).json({ message: "Could not load article." });
  }
});

app.post("/api/articles", async (req, res) => {
  if (usingMemoryStore) {
    try {
      res.status(201).json(createMemoryArticle(req.body));
    } catch (error) {
      res.status(error.statusCode || 500).json({ message: error.message || "Could not save article." });
    }

    return;
  }

  try {
    const article = validateArticlePayload(req.body);
    const [categoryRows] = await db.query("SELECT id FROM news_categories WHERE slug = ? LIMIT 1", [article.categorySlug]);

    if (categoryRows.length === 0) {
      return res.status(400).json({ message: "Category not found." });
    }

    const slug = makeSlug(article.title);

    await db.query(
      `
      INSERT INTO news_articles
        (slug, category_id, title, excerpt, body, author, image_url, featured)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `,
      [
        slug,
        categoryRows[0].id,
        article.title,
        article.excerpt,
        article.body,
        article.author,
        article.imageUrl,
      ]
    );

    const [rows] = await db.query(
      `
      SELECT
        a.id,
        a.slug,
        a.category_id,
        a.title,
        a.excerpt,
        a.body,
        a.author,
        a.image_url,
        a.featured,
        a.published_at,
        c.slug AS category_slug,
        c.name AS category_name
      FROM news_articles a
      JOIN news_categories c ON c.id = a.category_id
      WHERE a.slug = ?
      LIMIT 1
      `,
      [slug]
    );

    res.status(201).json(mapArticle(rows[0]));
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || "Could not save article." });
  }
});

app.delete("/api/articles/:slug", async (req, res) => {
  if (!hasAdminAccess(req)) {
    return res.status(401).json({ message: "Admin password required." });
  }

  if (usingMemoryStore) {
    if (!deleteMemoryArticle(req.params.slug)) {
      return res.status(404).json({ message: "Article not found." });
    }

    res.json({ ok: true });
    return;
  }

  try {
    const [result] = await db.query("DELETE FROM news_articles WHERE slug = ?", [req.params.slug]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Article not found." });
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: "Could not delete article.", error: error.message });
  }
});

app.use(express.static(publicPath));

app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    res.sendFile(path.join(publicPath, "index.html"));
    return;
  }

  next();
});

initializeNews()
  .catch((error) => {
    usingMemoryStore = true;
    initializeMemoryStore();
    console.warn("Database unavailable; starting with sample in-memory articles:", error.message);
  })
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Tomujin Article running at http://localhost:${PORT}`);
    });
  });
