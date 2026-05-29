// Code map:
// 1. Environment, Express middleware, upload, and security setup.
// 2. Normalizers, validators, auth helpers, and role permissions.
// 3. In-memory fallback store for local/demo operation.
// 4. MySQL migrations, database queries, and API route handlers.
// 5. Static frontend fallback and server startup.
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { v2: cloudinary } = require("cloudinary");
const sanitizeHtml = require("sanitize-html");
const crypto = require("crypto");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const path = require("path");
const bcrypt = require("bcrypt");

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

function isTruthy(value) {
  return value === true || ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, "``")}\``;
}

loadEnvFile(path.join(__dirname, ".env"));

const app = express();
const PORT = Number(process.env.PORT) || 8890;
const publicPath = path.join(__dirname, "..", "frontend", "public");
const publicImagesPath = path.join(publicPath, "images");
const uploadImagesPath = path.join(publicImagesPath, "uploads");
const fallbackImageUrl = "/images/stagknight.jpg";
const jwtSecret = process.env.JWT_SECRET;
const adminSessionTtl = process.env.ADMIN_SESSION_TTL || "6h";
const cloudinaryConfig = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
};
const hasCloudinaryConfig = Boolean(
  cloudinaryConfig.cloud_name &&
  cloudinaryConfig.api_key &&
  cloudinaryConfig.api_secret
);
const allowedImageExtensions = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const allowedImageMimeTypes = new Map([
  ["image/avif", ".avif"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);
const maxImageUploadBytes = 3 * 1024 * 1024;
const featuredLimit = 4;
const adminRoles = new Set(["owner", "editor", "writer"]);
const articleStatuses = new Set(["draft", "published", "archived"]);
const contentTypeOptions = [
  "Essay",
  "Article",
  "Record",
  "Reflection",
  "Interview",
  "Research",
  "Project Showcase",
  "Personal Story",
  "Opinion",
  "Guide",
];
const defaultContentType = "Article";

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "http://localhost:8890,http://localhost:5500,http://127.0.0.1:5500")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (process.env.TRUST_PROXY || isEnabled(process.env.RENDER)) {
  app.set("trust proxy", 1);
}

if (hasCloudinaryConfig) {
  cloudinary.config(cloudinaryConfig);
}

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  }
}));
app.use(express.json({ limit: "8mb" }));
app.use((error, _req, res, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ message: "Invalid JSON body." });
  }

  next(error);
});

const adminLoginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.ADMIN_LOGIN_RATE_LIMIT || 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many login attempts. Try again later." },
});

const sensitiveRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.SENSITIVE_RATE_LIMIT || 120),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many requests. Try again later." },
});

if (!isProduction()) {
  fs.mkdirSync(uploadImagesPath, { recursive: true });
}

const dbName = process.env.DB_NAME || "loginapp";
const dbBaseConfig = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  waitForConnections: true,
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 10000,
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
let memoryAlumniProfiles = [];
let memoryAuditLogs = [];
let nextMemoryArticleId = 1;
let nextMemoryAuditId = 1;

function logEvent(level, message, metadata = {}) {
  const payload = {
    level,
    event: message,
    time: new Date().toISOString(),
    ...metadata,
  };
  const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  writer(JSON.stringify(payload));
}

function logRouteError(route, error, metadata = {}) {
  logEvent("error", route, {
    message: error?.message,
    code: error?.code,
    errno: error?.errno,
    sqlState: error?.sqlState,
    statusCode: error?.statusCode,
    ...metadata,
  });
}

function ensureMemoryFallbackReady() {
  if (!memoryCategories.length || !memoryArticles.length) {
    initializeMemoryStore();
  }
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function assertRequiredProductionEnv() {
  if (!isProduction()) return;

  requireEnv("JWT_SECRET");
  requireEnv("DB_HOST");
  requireEnv("DB_USER");
  requireEnv("DB_PASSWORD");
  requireEnv("DB_NAME");
  requireEnv("CLOUDINARY_CLOUD_NAME");
  requireEnv("CLOUDINARY_API_KEY");
  requireEnv("CLOUDINARY_API_SECRET");
}

function asPublicImageUrl(value) {
  return value || fallbackImageUrl;
}

const defaultCategoryDefinitions = [
  ["oguulleg", "Өгүүллэг"],
  ["esee", "Эсээ"],
  ["dursamj", "Дурсамж"],
  ["yariltslaga", "Ярилцлага"],
  ["yaruu-nairag", "Яруу найраг"],
  ["niitlel", "Нийтлэл"],
  ["shuumej", "Шүүмж"],
  ["nom", "Ном"],
  ["zurvas", "Зурвас"],
  ["podcast", "Подкаст"],
];
const legacyCategoryFallbackSlug = "niitlel";
const legacyCategoryCleanupMappings = new Map([
  ["updates", "niitlel"],
  ["guides", "esee"],
  ["culture", "yariltslaga"],
  ["games", "niitlel"],
]);
const legacyCategoryCleanupSlugs = [
  ...legacyCategoryCleanupMappings.keys(),
  "psychology",
  "school-life",
  "science",
  "self-development",
  "social-issues",
  "technology",
  "tsa",
  "tsen",
  "university-life",
  "yang",
  "hudal",
  "haha",
];

function normalizeFeaturedOrder(value) {
  if (value === null || value === undefined || value === "") return null;
  const order = Number(value);
  return Number.isInteger(order) && order > 0 ? order : null;
}

function normalizeCategorySlugs(payload = {}) {
  const rawValues = Array.isArray(payload.categorySlugs)
    ? payload.categorySlugs
    : Array.isArray(payload.categories)
      ? payload.categories.map((category) => (typeof category === "string" ? category : category?.slug))
      : [payload.categorySlug];

  return [...new Set(
    rawValues
      .map((value) => normalizeSlug(value))
      .filter(Boolean)
      .slice(0, 8)
  )];
}

function normalizeGraduationYears(value) {
  const rawValues = Array.isArray(value) ? value : String(value || "").split(",");
  const years = rawValues
    .map((year) => Number(year))
    .filter((year) => graduationYearOptions.includes(year));

  return [...new Set(years)];
}

function parseDbCategories(value = "", fallback = null) {
  const categories = String(value || "")
    .split(";;")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separatorIndex = item.indexOf("|");
      return {
        slug: separatorIndex >= 0 ? item.slice(0, separatorIndex) : item,
        name: separatorIndex >= 0 ? item.slice(separatorIndex + 1) : item,
      };
    });

  if (categories.length) return categories;
  return fallback ? [fallback] : [];
}

function parseDbGraduationYears(value = "") {
  return String(value || "")
    .split(",")
    .map((year) => Number(year))
    .filter((year) => graduationYearOptions.includes(year));
}

function normalizeImageUrl(value) {
  const imageUrl = String(value || "").trim();
  if (!imageUrl) return fallbackImageUrl;

  if (imageUrl.startsWith("/images/")) {
    const imagePath = path.resolve(publicPath, `.${imageUrl}`);
    const extension = path.extname(imagePath).toLowerCase();
    const isInsideImages = imagePath === publicImagesPath || imagePath.startsWith(`${publicImagesPath}${path.sep}`);

    if (isInsideImages && allowedImageExtensions.has(extension) && fs.existsSync(imagePath)) {
      return imageUrl;
    }

    const error = new Error("Local image must exist in /images and use jpg, png, webp, avif, or gif.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const parsed = new URL(imageUrl);
    const extension = path.extname(parsed.pathname).toLowerCase();

    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && allowedImageExtensions.has(extension)) {
      return parsed.toString();
    }
  } catch {
    // Fall through to the validation error below.
  }

  const error = new Error("Image URL must be a valid http(s) image URL or an existing /images/ path.");
  error.statusCode = 400;
  throw error;
}

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sanitizePlainText(value = "", maxLength = 220) {
  return sanitizeHtml(String(value || ""), {
    allowedTags: [],
    allowedAttributes: {},
  }).trim().slice(0, maxLength);
}

function plainTextFromArticleContent(value = "") {
  const spaced = String(value || "").replace(/<\/?(p|br|div|li|h[1-6]|blockquote)[^>]*>/gi, " ");
  return sanitizePlainText(spaced, 12000).replace(/\s+/g, " ").trim();
}

function trimToSentenceBoundary(value = "", maxLength = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength).trim();
  const boundary = Math.max(slice.lastIndexOf("."), slice.lastIndexOf("!"), slice.lastIndexOf("?"));
  if (boundary >= 60) return slice.slice(0, boundary + 1).trim();
  return `${slice.replace(/[\s,;:.-]+$/, "")}...`;
}

function generatedExcerptFromBody(value = "") {
  const text = plainTextFromArticleContent(value);
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  return trimToSentenceBoundary(sentences.slice(0, 2).join(" ").trim() || text, 180);
}

function generatedMetaDescription(body = "", excerpt = "") {
  return trimToSentenceBoundary(plainTextFromArticleContent(excerpt) || plainTextFromArticleContent(body), 155);
}

function sanitizeArticleBody(value = "") {
  return sanitizeHtml(String(value || ""), {
    allowedTags: [
      "p", "br", "strong", "em", "b", "i", "u", "blockquote", "ul", "ol", "li",
      "a", "h2", "h3", "h4", "pre", "code"
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }, true),
    },
  }).trim().slice(0, 60000);
}

function isValidEmail(value = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function assertStrongPassword(password) {
  const value = String(password || "");
  if (value.length < 9) {
    throw createHttpError("Password must be at least 9 characters.");
  }
}

function parsePagination(query = {}, { defaultLimit = 9, maxLimit = 50 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const rawLimit = Number.parseInt(query.limit, 10);
  const limit = Math.min(maxLimit, Math.max(1, rawLimit || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

function hasPaginationQuery(query = {}) {
  return query.page !== undefined || query.limit !== undefined;
}

function paginatedMemoryResponse(items, pagination) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pagination.limit));
  return {
    items: items.slice(pagination.offset, pagination.offset + pagination.limit),
    page: pagination.page,
    limit: pagination.limit,
    total,
    totalPages,
  };
}

function sanitizeUploadBaseName(value = "") {
  const baseName = path
    .basename(String(value || "image"), path.extname(String(value || "")))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return baseName || "image";
}

function hasExpectedImageSignature(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;

  if (mimeType === "image/jpeg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  if (mimeType === "image/png") {
    return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }

  if (mimeType === "image/gif") {
    const header = buffer.subarray(0, 6).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }

  if (mimeType === "image/webp") {
    return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }

  if (mimeType === "image/avif") {
    return buffer.subarray(4, 8).toString("ascii") === "ftyp" && ["avif", "avis"].includes(buffer.subarray(8, 12).toString("ascii"));
  }

  return false;
}

async function saveUploadedImage(payload = {}) {
  let mimeType = String(payload.mimeType || "").trim().toLowerCase();
  let base64Data = String(payload.data || "").trim();
  const dataUrlMatch = base64Data.match(/^data:([^;]+);base64,(.+)$/i);

  if (dataUrlMatch) {
    const dataUrlMimeType = dataUrlMatch[1].toLowerCase();
    if (mimeType && mimeType !== dataUrlMimeType) {
      throw createHttpError("Uploaded image type does not match the file data.");
    }

    mimeType = dataUrlMimeType;
    base64Data = dataUrlMatch[2];
  }

  const expectedExtension = allowedImageMimeTypes.get(mimeType);
  if (!expectedExtension) {
    throw createHttpError("Upload a jpg, png, webp, avif, or gif image.");
  }

  if (!base64Data || !/^[a-z0-9+/]+={0,2}$/i.test(base64Data) || base64Data.length % 4 === 1) {
    throw createHttpError("Uploaded image data is invalid.");
  }

  const buffer = Buffer.from(base64Data, "base64");
  if (!buffer.length || buffer.length > maxImageUploadBytes) {
    throw createHttpError("Uploaded image must be 3 MB or smaller.");
  }

  if (!hasExpectedImageSignature(buffer, mimeType)) {
    throw createHttpError("Uploaded file is not a valid image.");
  }

  const originalExtension = path.extname(String(payload.fileName || "")).toLowerCase();
  const extension = allowedImageExtensions.has(originalExtension) && originalExtension !== ".jpeg" ? originalExtension : expectedExtension;
  const fileName = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}-${sanitizeUploadBaseName(payload.fileName)}${extension}`;

  if (hasCloudinaryConfig) {
    const uploadResult = await cloudinary.uploader.upload(`data:${mimeType};base64,${buffer.toString("base64")}`, {
      folder: process.env.CLOUDINARY_UPLOAD_FOLDER || "tomujin-article",
      resource_type: "image",
      public_id: path.basename(fileName, extension),
      overwrite: false,
    });

    return uploadResult.secure_url;
  }

  if (isProduction()) {
    throw createHttpError("Cloudinary is required for production image uploads.", 503);
  }

  fs.mkdirSync(uploadImagesPath, { recursive: true });
  const imagePath = path.join(uploadImagesPath, fileName);
  const publicUrl = `/images/uploads/${fileName}`;

  fs.writeFileSync(imagePath, buffer, { flag: "wx" });
  return publicUrl;
}

function assertAdminConfig() {
  if (!jwtSecret) {
    const error = new Error("JWT secret is not configured.");
    error.statusCode = 503;
    throw error;
  }
}

function sanitizeAdminProfile(admin = {}) {
  return {
    id: admin.id || null,
    name: admin.name || admin.email || "admin",
    email: admin.email || "",
    role: normalizeAdminRole(admin.role),
  };
}

function normalizeAdminRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  return adminRoles.has(normalized) ? normalized : "owner";
}

function normalizeArticleStatus(status, fallback = "published") {
  const normalized = String(status || "").trim().toLowerCase();
  return articleStatuses.has(normalized) ? normalized : fallback;
}

function normalizeContentType(value) {
  const normalized = String(value || defaultContentType).trim().toLowerCase();
  return contentTypeOptions.find((type) => type.toLowerCase() === normalized) || defaultContentType;
}

function normalizeTags(value) {
  const rawValues = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(
    rawValues
      .map((tag) => String(tag || "").trim())
      .map((tag) => sanitizePlainText(tag, 40))
      .filter(Boolean)
      .slice(0, 16)
  )];
}

function normalizeCategoryPayload(payload = {}) {
  const name = sanitizePlainText(payload.name || payload.label || "", 140);
  const slug = normalizeSlug(payload.slug || payload.categorySlug || payload.value || name);
  const sortOrder = Number.isFinite(Number(payload.sortOrder ?? payload.sort_order))
    ? Number(payload.sortOrder ?? payload.sort_order)
    : 0;
  const visibleInHeader = payload.visibleInHeader === undefined && payload.visible_in_header === undefined
    ? true
    : isTruthy(payload.visibleInHeader ?? payload.visible_in_header);
  const visibleOnHomepage = payload.visibleOnHomepage === undefined && payload.visible_on_homepage === undefined
    ? true
    : isTruthy(payload.visibleOnHomepage ?? payload.visible_on_homepage);
  const parentIdValue = payload.parentId ?? payload.parent_id;
  const parentId = parentIdValue === null || parentIdValue === undefined || parentIdValue === ""
    ? null
    : Number(parentIdValue);

  if (!name || !slug) {
    throw createHttpError("Category name and slug are required.");
  }

  return {
    name,
    slug,
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
    visibleInHeader,
    visibleOnHomepage,
    parentId: Number.isInteger(parentId) && parentId > 0 ? parentId : null,
  };
}

function categoryResponse(row = {}) {
  if (!row) return null;
  return {
    id: row.id || null,
    slug: row.slug || "",
    name: row.name || "",
    sortOrder: Number(row.sortOrder ?? row.sort_order ?? 0),
    visibleInHeader: row.visibleInHeader === undefined && row.visible_in_header === undefined
      ? true
      : Boolean(Number(row.visibleInHeader ?? row.visible_in_header)),
    visibleOnHomepage: row.visibleOnHomepage === undefined && row.visible_on_homepage === undefined
      ? true
      : Boolean(Number(row.visibleOnHomepage ?? row.visible_on_homepage)),
    parentId: row.parentId ?? row.parent_id ?? null,
    articleCount: Number(row.articleCount ?? row.article_count ?? 0),
    subcategoryCount: Number(row.subcategoryCount ?? row.subcategory_count ?? 0),
  };
}

function normalizePublishedAt(value) {
  const pad = (number) => String(number).padStart(2, "0");
  const formatForMysql = (date) => [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
  ].join("-") + " " + [
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join(":");

  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createHttpError("Publish date must be valid.");
  }

  return formatForMysql(date);
}

function isOwner(admin = {}) {
  return normalizeAdminRole(admin.role) === "owner";
}

function isEditorOrOwner(admin = {}) {
  return ["owner", "editor"].includes(normalizeAdminRole(admin.role));
}

function requireOwner(req, res, next) {
  if (!isOwner(req.admin)) {
    return res.status(403).json({ message: "Owner role required." });
  }

  next();
}

function assertEditorOrOwner(admin) {
  if (!isEditorOrOwner(admin)) {
    throw createHttpError("Editor or owner role required.", 403);
  }
}

function normalizeSlug(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function authorSlugFromName(value = "") {
  const name = String(value || "").trim();
  const slug = normalizeSlug(name);
  if (slug) return slug;

  return `alumni-${crypto.createHash("sha1").update(name || "author").digest("hex").slice(0, 8)}`;
}

function adminDisplayName(admin = {}) {
  return sanitizePlainText(admin.name || admin.email || "", 140);
}

function primaryGraduationYear(article = {}) {
  const years = Array.isArray(article.graduationYears)
    ? article.graduationYears
    : Array.isArray(article.graduation_years)
      ? article.graduation_years
      : [];
  return years.map((year) => Number(year)).find((year) => graduationYearOptions.includes(year)) || defaultGraduationYear;
}

function parseStoredTags(value = "") {
  if (Array.isArray(value)) return normalizeTags(value);
  try {
    const parsed = JSON.parse(value || "[]");
    return normalizeTags(parsed);
  } catch {
    return normalizeTags(value);
  }
}

function normalizeSocialLinks(value) {
  const rawValues = Array.isArray(value) ? value : String(value || "").split(/\r?\n|,/);
  return [...new Set(rawValues
    .map((link) => String(link || "").trim())
    .filter((link) => {
      try {
        const parsed = new URL(link);
        return ["http:", "https:"].includes(parsed.protocol);
      } catch {
        return false;
      }
    })
    .slice(0, 8))];
}

function parseStoredSocialLinks(value = "") {
  if (Array.isArray(value)) return normalizeSocialLinks(value);
  try {
    return normalizeSocialLinks(JSON.parse(value || "[]"));
  } catch {
    return normalizeSocialLinks(value);
  }
}

function alumniProfileFromPayload(payload = {}, article = {}) {
  return {
    author: article.author || sanitizePlainText(payload.author, 140),
    authorSlug: authorSlugFromName(article.author || payload.author),
    bio: sanitizePlainText(payload.authorBio || payload.bio, 1200),
    university: sanitizePlainText(payload.authorUniversity || payload.university, 180),
    major: sanitizePlainText(payload.authorMajor || payload.major, 180),
    currentWork: sanitizePlainText(payload.authorCurrentWork || payload.currentWork, 220),
    socialLinks: normalizeSocialLinks(payload.authorSocialLinks || payload.socialLinks),
  };
}

function adminIdValue(admin = {}) {
  const id = Number(admin.id || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function assertCanCreateArticle(admin, status) {
  if (normalizeAdminRole(admin.role) === "writer" && status !== "draft") {
    throw createHttpError("Writers can only create drafts.", 403);
  }
}

function assertCanEditArticle(admin, article = {}) {
  const role = normalizeAdminRole(admin.role);
  if (role === "owner" || role === "editor") return;

  const ownerId = Number(article.created_by_admin_id || article.createdByAdminId || 0);
  if (role === "writer" && article.status === "draft" && ownerId && ownerId === Number(admin.id || 0) && !article.deleted_at && !article.deletedAt) {
    return;
  }

  throw createHttpError("You do not have permission to edit this article.", 403);
}

function assertCanChangeArticleLifecycle(admin) {
  assertEditorOrOwner(admin);
}

function createAdminToken(admin = {}) {
  assertAdminConfig();
  const profile = sanitizeAdminProfile(admin);
  return jwt.sign({
    role: "admin",
    adminId: profile.id,
    name: profile.name,
    email: profile.email,
    adminRole: profile.role,
  }, jwtSecret, {
    expiresIn: adminSessionTtl,
    issuer: "tomujin-article",
    audience: "tomujin-admin",
  });
}

function getBearerToken(req) {
  const authorization = String(req.get("authorization") || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : String(req.get("x-admin-token") || "");
}

function getAdminFromRequest(req) {
  const token = getBearerToken(req);
  if (!token) return null;

  assertAdminConfig();

  try {
    const payload = jwt.verify(token, jwtSecret, {
      issuer: "tomujin-article",
      audience: "tomujin-admin",
    });

    if (payload.role !== "admin") {
      return null;
    }

    return {
      id: payload.adminId || null,
      name: payload.name || payload.email || "admin",
      email: payload.email || "",
      role: payload.adminRole || "",
    };
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  try {
    const admin = getAdminFromRequest(req);
    if (!admin) {
      return res.status(401).json({ message: "Admin login required." });
    }

    req.admin = admin;
    next();
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || "Admin auth failed." });
  }
}

function configuredAdminEmail() {
  return String(process.env.ADMIN_EMAIL || process.env.OWNER_EMAIL || "").trim().toLowerCase();
}

function configuredAdminName() {
  return String(process.env.ADMIN_NAME || process.env.OWNER_NAME || "Site Admin").trim() || "Site Admin";
}

async function configuredAdminPasswordHash() {
  const passwordHash = String(process.env.ADMIN_PASSWORD_HASH || "").trim();
  if (passwordHash) return passwordHash;

  const password = String(process.env.ADMIN_PASSWORD || process.env.OWNER_PASSWORD || "");
  if (password && isProduction()) {
    assertStrongPassword(password);
  }
  return password ? bcrypt.hash(password, 12) : "";
}

async function authenticateConfiguredAdmin(email, password) {
  const adminEmail = configuredAdminEmail();
  if (!adminEmail) return null;

  const passwordHash = await configuredAdminPasswordHash();
  if (!passwordHash) {
    throw createHttpError("Admin login is not configured.", 503);
  }

  if (String(email || "").trim().toLowerCase() !== adminEmail) return null;

  const correctPassword = await bcrypt.compare(String(password || ""), passwordHash);
  if (!correctPassword) return null;

  return {
    id: 1,
    name: configuredAdminName(),
    email: adminEmail,
    role: "owner",
  };
}

async function ensureConfiguredDbAdmin() {
  const email = configuredAdminEmail();
  if (!email) return;

  const passwordHash = await configuredAdminPasswordHash();
  if (!passwordHash) return;

  const [rows] = await db.query("SELECT id FROM admins WHERE email = ? LIMIT 1", [email]);
  if (rows.length) return;

  await db.query(
    "INSERT INTO admins (name, email, password_hash, role) VALUES (?, ?, ?, 'owner')",
    [configuredAdminName(), email, passwordHash]
  );
}

const seedCategories = defaultCategoryDefinitions;

const graduationYearOptions = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
const defaultGraduationYear = 2026;

const seedArticles = [
  {
    slug: "tomujin-first-note",
    category: "niitlel",
    categories: ["niitlel"],
    graduationYears: [2026],
    contentType: "Article",
    tags: ["school publication", "student writing"],
    title: "Tomujin Article нээгдлээ",
    excerpt: "Сурагчдын бичсэн нийтлэл, бодол, тэмдэглэлийг нэг дор цэгцтэй унших шинэ булан.",
    body:
      "Tomujin Article бол сурагчдын бичсэн нийтлэл, тэмдэглэл, бодлыг цэгцтэй харуулах зориулалттай нийтлэлийн талбар юм.\n\nЭхний хувилбар нь хайлт, ангилал, дэлгэрэнгүй унших хуудас, нийтлэл нэмэх хэсэгтэй. Дараагийн шатанд онлайн өгөгдлийн сан холбогдсоноор нийтлэлүүд байнга хадгалагдана.",
    author: "Tomujin Editorial",
    imageUrl: "/images/stagknight.jpg",
    featured: true,
    featuredOrder: 1,
    viewCount: 128,
  },
  {
    slug: "quiet-voices",
    category: "niitlel",
    categories: ["niitlel"],
    graduationYears: [2026],
    contentType: "Reflection",
    tags: ["student voice", "archive"],
    title: "Тайван хоолойнуудын булан",
    excerpt: "Уншигчдад зориулсан төвлөрсөн, тайван нийтлэлийн орчин.",
    body:
      "Энэ сайт худалдан авалтгүй, бүртгэлгүй. Зөвхөн нийтлэл унших, нийтлэх урсгалд төвлөрнө.\n\nНүүр хэсэг, ангилал, хайлт, нийтлэлийн дэлгэрэнгүй хуудас бүгд нэг backend-ээр ажиллаж байгаа тул дараа нь өгөгдлийн санг солиход үндсэн хэрэглээ хэвээр үлдэнэ.",
    author: "Tomujin Editorial",
    imageUrl: "/images/stagknight.jpg",
    featured: true,
    featuredOrder: 2,
    viewCount: 94,
  },
  {
    slug: "how-to-read-updates",
    category: "niitlel",
    categories: ["niitlel"],
    graduationYears: [2026],
    contentType: "Guide",
    tags: ["reading", "archive"],
    title: "Нийтлэлийг хурдан олох нь",
    excerpt: "Хайлт болон ангиллаар хэрэгтэй нийтлэлээ хурдан олох боломжтой.",
    body:
      "Дээд хэсгийн хайлт дээр түлхүүр үг бичээд Enter дарахад тохирох нийтлэлүүд гарна. Хэрэв ганцхан нийтлэл олдвол шууд унших хуудас руу орно.\n\nНийтлэлийн карт дээр дарахад дэлгэрэнгүй хуудас нээгдэнэ. Ингэснээр нүүр хуудас хурдан уншигдаж, нийтлэл бүр тусдаа төвлөрсөн хэлбэртэй харагдана.",
    author: "Guide Desk",
    imageUrl: "/images/stagknight.jpg",
    featured: false,
    featuredOrder: null,
    viewCount: 61,
  },
  {
    slug: "weekly-notes",
    category: "niitlel",
    categories: ["niitlel"],
    graduationYears: [2026],
    contentType: "Record",
    tags: ["weekly notes", "ideas"],
    title: "Долоо хоногийн тэмдэглэл",
    excerpt: "Богино бодол, ажиглалт, сонирхолтой санаанууд нэг дор.",
    body:
      "Мэдээний сайт дээр соёл, зарлал, зөвлөгөө, хувийн тэмдэглэл зэрэг төрлийн нийтлэлүүдийг тусад нь ангилж хадгална.\n\nЭнэ бүтэц нь жижиг сургуулийн нийтлэлийн талбар, клубийн мэдээллийн булан, эсвэл хувийн editorial сайт болж өргөжихөд бэлэн.",
    author: "Article Desk",
    imageUrl: "/images/stagknight.jpg",
    featured: false,
    featuredOrder: null,
    viewCount: 47,
  },
];

function initializeMemoryStore() {
  memoryCategories = seedCategories.map(([slug, name], index) => ({
    id: index + 1,
    slug,
    name,
    sortOrder: index + 1,
    visibleInHeader: true,
    visibleOnHomepage: true,
    parentId: null,
  }));

  const categoryIds = Object.fromEntries(memoryCategories.map((category) => [category.slug, category.id]));

  memoryArticles = seedArticles.map((article, index) => ({
    id: index + 1,
    slug: article.slug,
    category_id: categoryIds[article.category],
    category_slugs: article.categories || [article.category],
    graduation_years: article.graduationYears || [defaultGraduationYear],
    title: article.title,
    excerpt: article.excerpt,
    body: article.body,
    author: article.author,
    author_slug: authorSlugFromName(article.author),
    image_url: article.imageUrl,
    content_type: normalizeContentType(article.contentType),
    tags: JSON.stringify(normalizeTags(article.tags)),
    is_featured: article.featured ? 1 : 0,
    featured_order: article.featuredOrder,
    view_count: Number(article.viewCount || 0),
    status: "published",
    deleted_at: null,
    meta_title: "",
    meta_description: article.excerpt,
    created_by_admin_id: null,
    updated_by_admin_id: null,
    published_at: new Date(Date.now() - index * 60 * 60 * 1000).toISOString(),
  }));

  nextMemoryArticleId = memoryArticles.length + 1;
  memoryAlumniProfiles = [];
  memoryArticles.forEach((article) => {
    upsertMemoryAlumniProfiles(article, {
      author: article.author,
      authorSlug: article.author_slug,
      bio: "",
      university: "",
      major: "",
      currentWork: "",
      socialLinks: [],
    });
  });
  memoryAuditLogs = [];
  nextMemoryAuditId = 1;
}

function mapMemoryArticle(article) {
  const rawCategorySlugs = article.category_slugs?.length
    ? article.category_slugs
    : [memoryCategories.find((item) => item.id === article.category_id)?.slug].filter(Boolean);
  const categories = [...new Set(rawCategorySlugs)]
    .map((slug) => memoryCategories.find((item) => item.slug === slug))
    .filter(Boolean)
    .map(categoryResponse);
  const category = categories[0] || categoryResponse(memoryCategories[0]);

  return {
    id: article.id,
    slug: article.slug,
    title: article.title,
    excerpt: article.excerpt,
    body: article.body,
    author: article.author,
    authorSlug: article.author_slug || authorSlugFromName(article.author),
    imageUrl: asPublicImageUrl(article.image_url),
    contentType: normalizeContentType(article.content_type),
    tags: parseStoredTags(article.tags),
    isFeatured: Boolean(article.is_featured),
    featured: Boolean(article.is_featured),
    featuredOrder: article.featured_order,
    viewCount: Number(article.view_count || 0),
    status: article.status || "published",
    deletedAt: article.deleted_at || null,
    metaTitle: article.meta_title || "",
    metaDescription: article.meta_description || "",
    createdByAdminId: article.created_by_admin_id || null,
    updatedByAdminId: article.updated_by_admin_id || null,
    publishedAt: article.published_at,
    category: category
      ? {
      id: category.id,
      slug: category.slug,
      name: category.name,
        }
      : null,
    categories,
    categorySlugs: categories.map((item) => item.slug),
  };
}

function getMemoryCategories() {
  const counts = new Map(memoryCategories.map((category) => [category.slug, 0]));
  memoryArticles.forEach((article) => {
    if (article.status !== "published" || article.deleted_at) return;
    const rawCategorySlugs = article.category_slugs?.length
      ? article.category_slugs
      : [memoryCategories.find((item) => item.id === article.category_id)?.slug].filter(Boolean);
    [...new Set(rawCategorySlugs)].forEach((slug) => {
      counts.set(slug, Number(counts.get(slug) || 0) + 1);
    });
  });

  const childCounts = new Map();
  memoryCategories.forEach((category) => {
    if (category.parentId) childCounts.set(category.parentId, Number(childCounts.get(category.parentId) || 0) + 1);
  });

  return memoryCategories
    .map((category) => ({
      ...categoryResponse(category),
      articleCount: counts.get(category.slug) || 0,
      subcategoryCount: childCounts.get(category.id) || 0,
    }))
    .sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0) || left.name.localeCompare(right.name));
}

function createMemoryCategory(payload) {
  const category = normalizeCategoryPayload(payload);
  if (memoryCategories.some((item) => item.slug === category.slug)) {
    throw createHttpError("Category slug already exists.", 409);
  }

  const saved = {
    id: Math.max(0, ...memoryCategories.map((item) => Number(item.id || 0))) + 1,
    ...category,
  };
  memoryCategories.push(saved);
  return saved;
}

function updateMemoryCategory(currentSlug, payload) {
  const existing = memoryCategories.find((item) => item.slug === currentSlug);
  if (!existing) return null;
  const category = normalizeCategoryPayload(payload);
  if (memoryCategories.some((item) => item.slug === category.slug && item.slug !== currentSlug)) {
    throw createHttpError("Category slug already exists.", 409);
  }

  memoryArticles.forEach((article) => {
    article.category_slugs = (article.category_slugs || []).map((slug) => (slug === currentSlug ? category.slug : slug));
  });
  existing.slug = category.slug;
  existing.name = category.name;
  existing.sortOrder = category.sortOrder;
  existing.visibleInHeader = category.visibleInHeader;
  existing.visibleOnHomepage = category.visibleOnHomepage;
  existing.parentId = category.parentId;
  return existing;
}

function getMemoryArticles({ q = "", category = "", year = "", status = "", contentType = "", author = "", editorPick = false, includeAdmin = false } = {}) {
  const search = String(q).trim().toLowerCase();
  const selectedCategory = normalizeSlug(category);
  const selectedYear = Number(year);
  const selectedStatus = normalizeArticleStatus(status, "");
  const selectedContentType = contentType ? normalizeContentType(contentType) : "";
  const selectedAuthorSlug = String(author || "").trim();

  return memoryArticles
    .filter((article) => {
      const categorySlugs = article.category_slugs?.length
        ? article.category_slugs
        : [memoryCategories.find((item) => item.id === article.category_id)?.slug].filter(Boolean);
      if (includeAdmin) {
        if (selectedStatus && article.status !== selectedStatus) return false;
      } else if (article.status !== "published" || article.deleted_at) {
        return false;
      }
      if (editorPick && !article.is_featured) return false;
      if (selectedCategory && selectedCategory !== "all" && !categorySlugs.includes(selectedCategory)) return false;
      if (selectedContentType && normalizeContentType(article.content_type) !== selectedContentType) return false;
      if (selectedAuthorSlug && (article.author_slug || authorSlugFromName(article.author)) !== selectedAuthorSlug) return false;
      if (graduationYearOptions.includes(selectedYear) && !(article.graduation_years || []).includes(selectedYear)) return false;
      if (!search) return true;

      return [article.title, article.excerpt, article.body, article.author, article.content_type, parseStoredTags(article.tags).join(" ")].some((value) =>
        String(value).toLowerCase().includes(search)
      );
    })
    .sort((left, right) => {
      if (includeAdmin && right.is_featured !== left.is_featured) return right.is_featured - left.is_featured;
      if (includeAdmin && left.is_featured && right.is_featured) return (left.featured_order || 9999) - (right.featured_order || 9999);
      return new Date(right.published_at) - new Date(left.published_at) || right.id - left.id;
    })
    .map(mapMemoryArticle);
}

function getMemoryArticle(slug, { incrementView = false, includeAdmin = false } = {}) {
  const article = memoryArticles.find((item) => item.slug === slug);
  if (article && !includeAdmin && (article.status !== "published" || article.deleted_at)) {
    return null;
  }
  if (article && incrementView) {
    article.view_count = Number(article.view_count || 0) + 1;
  }
  return article ? mapMemoryArticle(article) : null;
}

function upsertMemoryAlumniProfiles(article, profile = {}) {
  const graduationYears = article.graduation_years?.length ? article.graduation_years : [defaultGraduationYear];
  const author = profile.author || article.author;
  const authorSlug = profile.authorSlug || article.author_slug || authorSlugFromName(author);

  graduationYears.forEach((year) => {
    const existing = memoryAlumniProfiles.find((item) => item.authorSlug === authorSlug && Number(item.graduationYear) === Number(year));
    const nextProfile = {
      author,
      authorSlug,
      graduationYear: Number(year),
      bio: profile.bio || existing?.bio || "",
      university: profile.university || existing?.university || "",
      major: profile.major || existing?.major || "",
      currentWork: profile.currentWork || existing?.currentWork || "",
      socialLinks: profile.socialLinks?.length ? profile.socialLinks : existing?.socialLinks || [],
    };

    if (existing) {
      Object.assign(existing, nextProfile);
    } else {
      memoryAlumniProfiles.push(nextProfile);
    }
  });
}

function getMemoryAlumniProfiles({ year = "" } = {}) {
  const selectedYear = Number(year);
  const publishedArticles = memoryArticles.filter((article) => article.status === "published" && !article.deleted_at);
  const profilesByKey = new Map();

  publishedArticles.forEach((article) => {
    const authorSlug = article.author_slug || authorSlugFromName(article.author);
    (article.graduation_years?.length ? article.graduation_years : [defaultGraduationYear]).forEach((graduationYear) => {
      if (graduationYearOptions.includes(selectedYear) && Number(graduationYear) !== selectedYear) return;
      const key = `${graduationYear}:${authorSlug}`;
      const profile = memoryAlumniProfiles.find((item) => item.authorSlug === authorSlug && Number(item.graduationYear) === Number(graduationYear)) || {};
      const current = profilesByKey.get(key) || {
        author: article.author,
        authorSlug,
        graduationYear: Number(graduationYear),
        bio: profile.bio || "",
        university: profile.university || "",
        major: profile.major || "",
        currentWork: profile.currentWork || "",
        socialLinks: profile.socialLinks || [],
        articleCount: 0,
        latestPublishedAt: article.published_at,
      };
      current.articleCount += 1;
      if (new Date(article.published_at) > new Date(current.latestPublishedAt || 0)) {
        current.latestPublishedAt = article.published_at;
      }
      profilesByKey.set(key, current);
    });
  });

  return [...profilesByKey.values()].sort((left, right) =>
    Number(right.graduationYear) - Number(left.graduationYear) ||
    left.author.localeCompare(right.author)
  );
}

function nextMemoryFeaturedOrder() {
  const orders = memoryArticles
    .filter((article) => article.is_featured)
    .map((article) => Number(article.featured_order || 0));

  return Math.max(0, ...orders) + 1;
}

function sortFeaturedRows(left, right) {
  return (left.featured_order || 9999) - (right.featured_order || 9999) || new Date(right.published_at) - new Date(left.published_at) || right.id - left.id;
}

function memoryFeaturedArticles(exceptSlug = "") {
  return memoryArticles
    .filter((article) => article.is_featured && article.slug !== exceptSlug)
    .sort(sortFeaturedRows);
}

function setMemoryFeaturedPlacement(slug, featured, requestedOrder = null) {
  const article = memoryArticles.find((item) => item.slug === slug);
  if (!article) return null;

  const featuredArticles = memoryFeaturedArticles(slug);

  if (featured && featuredArticles.length >= featuredLimit) {
    throw createHttpError(`Only ${featuredLimit} featured posts are allowed. Unfeature another article first.`);
  }

  if (!featured) {
    article.is_featured = 0;
    article.featured_order = null;
    featuredArticles.forEach((item, index) => {
      item.featured_order = index + 1;
    });
    return mapMemoryArticle(article);
  }

  article.is_featured = 1;
  const order = normalizeFeaturedOrder(requestedOrder) || article.featured_order || featuredArticles.length + 1;
  const insertIndex = Math.max(0, Math.min(order - 1, featuredArticles.length));
  featuredArticles.splice(insertIndex, 0, article);
  featuredArticles.forEach((item, index) => {
    item.featured_order = index + 1;
  });

  return mapMemoryArticle(article);
}

function validateArticlePayload(payload, admin = {}) {
  const categorySlugs = normalizeCategorySlugs(payload);
  const graduationYears = normalizeGraduationYears(payload.graduationYears || payload.graduationYear);
  const title = sanitizePlainText(payload.title, 220);
  const body = sanitizeArticleBody(payload.body);
  const excerpt = sanitizePlainText(payload.excerpt || generatedExcerptFromBody(body), 900);
  const author = sanitizePlainText(payload.author || adminDisplayName(admin), 140);
  const status = normalizeArticleStatus(payload.status, "published");
  const article = {
    slug: normalizeSlug(payload.slug || payload.title),
    title,
    excerpt,
    body,
    author,
    authorSlug: authorSlugFromName(author),
    contentType: normalizeContentType(payload.contentType),
    categorySlugs,
    categorySlug: categorySlugs[0] || "",
    graduationYears: graduationYears.length ? graduationYears : [defaultGraduationYear],
    tags: normalizeTags(payload.tags),
    imageUrl: normalizeImageUrl(payload.imageUrl),
    status,
    metaTitle: sanitizePlainText(payload.metaTitle || title, 220),
    metaDescription: sanitizePlainText(payload.metaDescription || generatedMetaDescription(body, excerpt), 320),
    publishedAt: normalizePublishedAt(payload.publishedAt || payload.publishDate || (status === "published" ? new Date().toISOString() : "")),
    featured: isTruthy(payload.isFeatured) || isTruthy(payload.featured),
    featuredOrder: normalizeFeaturedOrder(payload.featuredOrder),
  };
  article.alumniProfile = alumniProfileFromPayload(payload, article);

  if (!article.title || !article.author || !article.categorySlugs.length || !article.slug) {
    const error = new Error("Title, author, category, and slug are required.");
    error.statusCode = 400;
    throw error;
  }

  if (article.status === "published" && (!article.excerpt || !article.body)) {
    const error = new Error("Published articles need an excerpt and body.");
    error.statusCode = 400;
    throw error;
  }

  return article;
}

function createMemoryArticle(payload, admin) {
  const payloadArticle = validateArticlePayload(payload, admin);
  assertCanCreateArticle(admin, payloadArticle.status);
  const category = memoryCategories.find((item) => item.slug === payloadArticle.categorySlugs[0]);

  if (!category) {
    const error = new Error("Category not found.");
    error.statusCode = 400;
    throw error;
  }

  if (payloadArticle.featured && memoryFeaturedArticles().length >= featuredLimit) {
    throw createHttpError(`Only ${featuredLimit} featured posts are allowed. Unfeature another article first.`);
  }

  if (payloadArticle.featured && payloadArticle.status !== "published") {
    throw createHttpError("Only published articles can be featured.");
  }

  const article = {
    id: nextMemoryArticleId,
    slug: uniqueMemorySlug(payloadArticle.slug || makeSlug(payloadArticle.title)),
    category_id: category.id,
    category_slugs: payloadArticle.categorySlugs,
    graduation_years: payloadArticle.graduationYears,
    title: payloadArticle.title,
    excerpt: payloadArticle.excerpt,
    body: payloadArticle.body,
    author: payloadArticle.author,
    author_slug: payloadArticle.authorSlug,
    image_url: payloadArticle.imageUrl,
    content_type: payloadArticle.contentType,
    tags: JSON.stringify(payloadArticle.tags),
    is_featured: 0,
    featured_order: null,
    view_count: 0,
    status: payloadArticle.status,
    deleted_at: null,
    meta_title: payloadArticle.metaTitle,
    meta_description: payloadArticle.metaDescription,
    created_by_admin_id: adminIdValue(admin),
    updated_by_admin_id: adminIdValue(admin),
    published_at: payloadArticle.publishedAt,
  };

  nextMemoryArticleId += 1;
  memoryArticles.unshift(article);
  upsertMemoryAlumniProfiles(article, payloadArticle.alumniProfile);
  const savedArticle = setMemoryFeaturedPlacement(article.slug, payloadArticle.featured, payloadArticle.featuredOrder);
  addMemoryAuditLog(article, admin, payloadArticle.status === "published" ? "published" : "created", { status: payloadArticle.status });
  return savedArticle;
}

function deleteMemoryArticle(slug, admin) {
  assertCanChangeArticleLifecycle(admin);
  const article = memoryArticles.find((item) => item.slug === slug);
  if (!article) return false;

  article.status = "archived";
  article.deleted_at = new Date().toISOString();
  article.is_featured = 0;
  article.featured_order = null;
  article.updated_by_admin_id = adminIdValue(admin);
  addMemoryAuditLog(article, admin, "deleted", { softDelete: true });

  memoryFeaturedArticles().forEach((item, index) => {
    item.featured_order = index + 1;
  });
  return true;
}

function updateMemoryArticle(slug, payload, admin) {
  const existing = memoryArticles.find((article) => article.slug === slug);
  if (!existing) return null;
  assertCanEditArticle(admin, existing);

  const payloadArticle = validateArticlePayload(payload, admin);
  if (normalizeAdminRole(admin.role) === "writer" && payloadArticle.status !== "draft") {
    throw createHttpError("Writers can only save drafts.", 403);
  }

  const category = memoryCategories.find((item) => item.slug === payloadArticle.categorySlugs[0]);
  if (!category) {
    const error = new Error("Category not found.");
    error.statusCode = 400;
    throw error;
  }

  if (payloadArticle.featured && payloadArticle.status !== "published") {
    throw createHttpError("Only published articles can be featured.");
  }

  if (payloadArticle.featured && memoryFeaturedArticles(slug).length >= featuredLimit) {
    throw createHttpError(`Only ${featuredLimit} featured posts are allowed. Unfeature another article first.`);
  }

  const nextSlug = uniqueMemorySlug(payloadArticle.slug || makeSlug(payloadArticle.title), slug);
  existing.slug = nextSlug;
  existing.category_id = category.id;
  existing.category_slugs = payloadArticle.categorySlugs;
  existing.graduation_years = payloadArticle.graduationYears;
  existing.title = payloadArticle.title;
  existing.excerpt = payloadArticle.excerpt;
  existing.body = payloadArticle.body;
  existing.author = payloadArticle.author;
  existing.author_slug = payloadArticle.authorSlug;
  existing.image_url = payloadArticle.imageUrl;
  existing.content_type = payloadArticle.contentType;
  existing.tags = JSON.stringify(payloadArticle.tags);
  existing.status = payloadArticle.status;
  existing.deleted_at = null;
  existing.meta_title = payloadArticle.metaTitle;
  existing.meta_description = payloadArticle.metaDescription;
  existing.published_at = payloadArticle.publishedAt;
  existing.updated_by_admin_id = adminIdValue(admin);

  upsertMemoryAlumniProfiles(existing, payloadArticle.alumniProfile);
  const savedArticle = setMemoryFeaturedPlacement(existing.slug, payloadArticle.featured, payloadArticle.featuredOrder);
  addMemoryAuditLog(existing, admin, "edited", { status: payloadArticle.status });
  return savedArticle;
}

function setMemoryArticleStatus(slug, status, admin) {
  const article = memoryArticles.find((item) => item.slug === slug);
  if (!article) return null;

  const nextStatus = normalizeArticleStatus(status, article.status || "draft");
  assertCanChangeArticleLifecycle(admin);
  if (nextStatus === "published" && (!String(article.excerpt || "").trim() || !String(article.body || "").trim())) {
    throw createHttpError("Published articles need an excerpt and body.");
  }
  const previousStatus = article.status;
  article.status = nextStatus;
  article.deleted_at = null;
  article.updated_by_admin_id = adminIdValue(admin);
  if (nextStatus === "published" && !article.published_at) {
    article.published_at = new Date().toISOString();
  }
  if (nextStatus !== "published") {
    article.is_featured = 0;
    article.featured_order = null;
    memoryFeaturedArticles().forEach((article, index) => {
      article.featured_order = index + 1;
    });
  }

  const action = nextStatus === "published" ? "published" : nextStatus === "archived" ? "archived" : "restored";
  addMemoryAuditLog(article, admin, action, { from: previousStatus, to: nextStatus });
  return mapMemoryArticle(article);
}

function setMemoryArticleFeatured(slug, featured, featuredOrder = null, admin = {}) {
  assertEditorOrOwner(admin);
  const article = memoryArticles.find((item) => item.slug === slug);
  if (featured && article && (article.status !== "published" || article.deleted_at)) {
    throw createHttpError("Only published articles can be featured.");
  }

  const savedArticle = setMemoryFeaturedPlacement(slug, featured, featuredOrder);
  if (savedArticle) addMemoryAuditLog(article, admin, featured ? "featured" : "unfeatured", { featuredOrder });
  return savedArticle;
}

function addMemoryAuditLog(article, admin, action, details = {}) {
  if (!article) return;
  const profile = sanitizeAdminProfile(admin);
  memoryAuditLogs.unshift({
    id: nextMemoryAuditId,
    article_id: article.id,
    article_slug: article.slug,
    admin_id: profile.id,
    admin_name: profile.name,
    admin_email: profile.email,
    admin_role: profile.role,
    action,
    details,
    created_at: new Date().toISOString(),
  });
  nextMemoryAuditId += 1;
}

function getMemoryAuditLogs(slug) {
  const article = memoryArticles.find((item) => item.slug === slug);
  if (!article) return [];
  return memoryAuditLogs
    .filter((log) => log.article_id === article.id)
    .map((log) => ({
      id: log.id,
      action: log.action,
      details: log.details,
      createdAt: log.created_at,
      admin: {
        id: log.admin_id,
        name: log.admin_name,
        email: log.admin_email,
        role: log.admin_role,
      },
    }));
}

async function addDbAuditLog(articleId, admin, action, details = {}, executor = db) {
  const profile = sanitizeAdminProfile(admin);
  await executor.query(
    `
    INSERT INTO article_audit_logs
      (article_id, admin_id, admin_name, admin_email, admin_role, action, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      articleId,
      profile.id,
      profile.name,
      profile.email,
      profile.role,
      action,
      JSON.stringify(details),
    ]
  );
}

function mapAuditLog(row) {
  let details = {};
  try {
    details = row.details ? JSON.parse(row.details) : {};
  } catch {
    details = {};
  }

  return {
    id: row.id,
    action: row.action,
    details,
    createdAt: row.created_at,
    admin: {
      id: row.admin_id,
      name: row.admin_name,
      email: row.admin_email,
      role: row.admin_role,
    },
  };
}

async function ensureDatabase() {
  const adminDb = mysql.createPool(dbBaseConfig);
  await adminDb.query(`CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await adminDb.end();
}

async function ensureDbIndex(tableName, indexName, createSql, { optional = false } = {}) {
  const [rows] = await db.query(
    "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1",
    [dbName, tableName, indexName]
  );

  if (rows.length) return;

  try {
    await db.query(createSql);
  } catch (error) {
    if (optional) {
      logEvent("warn", "optional index skipped", {
        tableName,
        indexName,
        message: error.message,
        code: error.code,
      });
      return;
    }

    throw error;
  }
}

async function ensureDbIndexes() {
  await ensureDbIndex("news_articles", "news_articles_slug_idx", "CREATE INDEX news_articles_slug_idx ON news_articles (slug)");
  await ensureDbIndex("news_articles", "news_articles_status_idx", "CREATE INDEX news_articles_status_idx ON news_articles (status)");
  await ensureDbIndex("news_articles", "news_articles_published_at_idx", "CREATE INDEX news_articles_published_at_idx ON news_articles (published_at)");
  await ensureDbIndex("news_articles", "news_articles_is_featured_idx", "CREATE INDEX news_articles_is_featured_idx ON news_articles (is_featured)");
  await ensureDbIndex("news_articles", "news_articles_author_slug_idx", "CREATE INDEX news_articles_author_slug_idx ON news_articles (author_slug)");
  await ensureDbIndex("news_articles", "news_articles_content_type_idx", "CREATE INDEX news_articles_content_type_idx ON news_articles (content_type)");
  await ensureDbIndex(
    "news_articles",
    "news_articles_fulltext_idx",
    "CREATE FULLTEXT INDEX news_articles_fulltext_idx ON news_articles (title, excerpt, body)",
    { optional: true }
  );
}

async function cleanupLegacyDbCategories() {
  const legacySlugs = [...new Set(legacyCategoryCleanupSlugs)];
  if (!legacySlugs.length) return;

  const [legacyRows] = await db.query(
    `SELECT slug FROM news_categories WHERE slug IN (${legacySlugs.map(() => "?").join(", ")})`,
    legacySlugs
  );
  if (!legacyRows.length) return;

  await db.query(
    "INSERT IGNORE INTO news_categories (slug, name, sort_order, visible_in_header, visible_on_homepage) VALUES ?",
    [defaultCategoryDefinitions.map(([slug, name], index) => [slug, name, index + 1, 1, 1])]
  );
  await db.query("UPDATE news_categories SET name = ? WHERE slug = ?", ["Эсээ", "esee"]);
  await db.query(
    `UPDATE news_categories
     SET sort_order = CASE slug
       ${defaultCategoryDefinitions.map((_, index) => `WHEN ? THEN ${index + 1}`).join(" ")}
       ELSE sort_order
     END
     WHERE sort_order = 0 AND slug IN (${defaultCategoryDefinitions.map(() => "?").join(", ")})`,
    [...defaultCategoryDefinitions.map(([slug]) => slug), ...defaultCategoryDefinitions.map(([slug]) => slug)]
  );

  const mappedSlugs = [...legacyCategoryCleanupMappings.keys(), ...legacyCategoryCleanupMappings.values()];
  const [categoryRows] = await db.query(
    `SELECT id, slug FROM news_categories WHERE slug IN (${mappedSlugs.map(() => "?").join(", ")})`,
    mappedSlugs
  );
  const categoryIdBySlug = new Map(categoryRows.map((row) => [row.slug, row.id]));

  for (const [sourceSlug, targetSlug] of legacyCategoryCleanupMappings.entries()) {
    const sourceId = categoryIdBySlug.get(sourceSlug);
    const targetId = categoryIdBySlug.get(targetSlug);
    if (!sourceId || !targetId || sourceId === targetId) continue;

    await db.query("UPDATE news_articles SET category_id = ? WHERE category_id = ?", [targetId, sourceId]);
    await db.query(
      `INSERT IGNORE INTO news_article_categories (article_id, category_id)
       SELECT article_id, ? FROM news_article_categories WHERE category_id = ?`,
      [targetId, sourceId]
    );
    await db.query("DELETE FROM news_article_categories WHERE category_id = ?", [sourceId]);
  }

  await db.query(
    `DELETE c
     FROM news_categories c
     LEFT JOIN news_articles a ON a.category_id = c.id
     LEFT JOIN news_article_categories ac ON ac.category_id = c.id
     WHERE c.slug IN (${legacySlugs.map(() => "?").join(", ")})
       AND a.id IS NULL
       AND ac.article_id IS NULL`,
    legacySlugs
  );
}

async function runDatabaseMigrations() {
  await ensureDatabase();

  await db.query(`
    CREATE TABLE IF NOT EXISTS news_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(80) NOT NULL UNIQUE,
      name VARCHAR(140) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      visible_in_header TINYINT(1) NOT NULL DEFAULT 1,
      visible_on_homepage TINYINT(1) NOT NULL DEFAULT 1,
      parent_id INT NULL,
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
      author_slug VARCHAR(140) NULL,
      image_url VARCHAR(1000) NULL,
      content_type VARCHAR(80) NOT NULL DEFAULT 'Article',
      tags TEXT NULL,
      is_featured TINYINT(1) NOT NULL DEFAULT 0,
      featured_order INT NULL,
      view_count INT UNSIGNED NOT NULL DEFAULT 0,
      published_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES news_categories(id)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS news_article_categories (
      article_id INT NOT NULL,
      category_id INT NOT NULL,
      PRIMARY KEY (article_id, category_id),
      FOREIGN KEY (article_id) REFERENCES news_articles(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES news_categories(id) ON DELETE CASCADE
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS news_article_years (
      article_id INT NOT NULL,
      graduation_year INT NOT NULL,
      PRIMARY KEY (article_id, graduation_year),
      FOREIGN KEY (article_id) REFERENCES news_articles(id) ON DELETE CASCADE
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS alumni_profiles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      author_slug VARCHAR(140) NOT NULL,
      author VARCHAR(140) NOT NULL,
      graduation_year INT NOT NULL,
      bio TEXT NULL,
      university VARCHAR(180) NULL,
      major VARCHAR(180) NULL,
      current_work VARCHAR(220) NULL,
      social_links TEXT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY alumni_profile_unique (author_slug, graduation_year)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(140) NOT NULL,
      email VARCHAR(190) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'owner',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS article_audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      article_id INT NOT NULL,
      admin_id INT NULL,
      admin_name VARCHAR(140) NULL,
      admin_email VARCHAR(190) NULL,
      admin_role VARCHAR(20) NULL,
      action VARCHAR(40) NOT NULL,
      details TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX article_audit_article_id_idx (article_id),
      FOREIGN KEY (article_id) REFERENCES news_articles(id) ON DELETE CASCADE
    )
  `);

  const [adminColumns] = await db.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'admins' AND COLUMN_NAME IN ('role', 'created_at')",
    [dbName]
  );
  const adminColumnNames = new Set(adminColumns.map((column) => column.COLUMN_NAME));

  if (!adminColumnNames.has("role")) {
    await db.query("ALTER TABLE admins ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'owner'");
  }

  if (!adminColumnNames.has("created_at")) {
    await db.query("ALTER TABLE admins ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
  }

  await ensureConfiguredDbAdmin();

  const [categoryColumns] = await db.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'news_categories' AND COLUMN_NAME IN ('sort_order', 'visible_in_header', 'visible_on_homepage', 'parent_id')",
    [dbName]
  );
  const categoryColumnNames = new Set(categoryColumns.map((column) => column.COLUMN_NAME));

  if (!categoryColumnNames.has("sort_order")) {
    await db.query("ALTER TABLE news_categories ADD COLUMN sort_order INT NOT NULL DEFAULT 0");
  }

  if (!categoryColumnNames.has("visible_in_header")) {
    await db.query("ALTER TABLE news_categories ADD COLUMN visible_in_header TINYINT(1) NOT NULL DEFAULT 1");
  }

  if (!categoryColumnNames.has("visible_on_homepage")) {
    await db.query("ALTER TABLE news_categories ADD COLUMN visible_on_homepage TINYINT(1) NOT NULL DEFAULT 1");
  }

  if (!categoryColumnNames.has("parent_id")) {
    await db.query("ALTER TABLE news_categories ADD COLUMN parent_id INT NULL");
  }

  const [articleColumns] = await db.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'news_articles' AND COLUMN_NAME IN ('featured', 'is_featured', 'featured_order', 'view_count', 'status', 'deleted_at', 'meta_title', 'meta_description', 'created_by_admin_id', 'updated_by_admin_id', 'author_slug', 'content_type', 'tags', 'published_at')",
    [dbName]
  );
  const articleColumnNames = new Set(articleColumns.map((column) => column.COLUMN_NAME));

  if (!articleColumnNames.has("is_featured")) {
    await db.query("ALTER TABLE news_articles ADD COLUMN is_featured TINYINT(1) NOT NULL DEFAULT 0");
  }

  if (articleColumnNames.has("featured")) {
    await db.query("UPDATE news_articles SET is_featured = featured WHERE featured = 1");
  }

  if (!articleColumnNames.has("featured_order")) {
    await db.query("ALTER TABLE news_articles ADD COLUMN featured_order INT NULL");
  }

  if (!articleColumnNames.has("view_count")) {
    await db.query("ALTER TABLE news_articles ADD COLUMN view_count INT UNSIGNED NOT NULL DEFAULT 0");
  }

  if (!articleColumnNames.has("status")) {
    await db.query("ALTER TABLE news_articles ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'published'");
  }

  if (!articleColumnNames.has("deleted_at")) {
    await db.query("ALTER TABLE news_articles ADD COLUMN deleted_at DATETIME NULL");
  }

  if (!articleColumnNames.has("meta_title")) {
    await db.query("ALTER TABLE news_articles ADD COLUMN meta_title VARCHAR(220) NULL");
  }

  if (!articleColumnNames.has("meta_description")) {
    await db.query("ALTER TABLE news_articles ADD COLUMN meta_description TEXT NULL");
  }

  if (!articleColumnNames.has("created_by_admin_id")) {
    await db.query("ALTER TABLE news_articles ADD COLUMN created_by_admin_id INT NULL");
  }

  if (!articleColumnNames.has("updated_by_admin_id")) {
    await db.query("ALTER TABLE news_articles ADD COLUMN updated_by_admin_id INT NULL");
  }

  if (!articleColumnNames.has("author_slug")) {
    await db.query("ALTER TABLE news_articles ADD COLUMN author_slug VARCHAR(140) NULL");
  }

  if (!articleColumnNames.has("content_type")) {
    await db.query("ALTER TABLE news_articles ADD COLUMN content_type VARCHAR(80) NOT NULL DEFAULT 'Article'");
  }

  if (!articleColumnNames.has("tags")) {
    await db.query("ALTER TABLE news_articles ADD COLUMN tags TEXT NULL");
  }

  if (!articleColumnNames.has("published_at")) {
    await db.query("ALTER TABLE news_articles ADD COLUMN published_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
  }

  await db.query("ALTER TABLE news_articles MODIFY COLUMN image_url VARCHAR(1000) NULL");
  await db.query("UPDATE news_articles SET status = 'published' WHERE status IS NULL OR status = ''");
  await db.query("UPDATE news_articles SET content_type = 'Article' WHERE content_type IS NULL OR content_type = ''");

  const [authorSlugRows] = await db.query("SELECT id, author FROM news_articles WHERE author_slug IS NULL OR author_slug = ''");
  for (const row of authorSlugRows) {
    await db.query("UPDATE news_articles SET author_slug = ? WHERE id = ?", [authorSlugFromName(row.author), row.id]);
  }

  await ensureDbIndexes();

  const [categoryCountRows] = await db.query("SELECT COUNT(*) AS count FROM news_categories");
  if (Number(categoryCountRows[0]?.count || 0) === 0) {
    await db.query(
      "INSERT INTO news_categories (slug, name, sort_order, visible_in_header, visible_on_homepage) VALUES ?",
      [seedCategories.map(([slug, name], index) => [slug, name, index + 1, 1, 1])]
    );
  }

  const [categories] = await db.query("SELECT id, slug FROM news_categories");
  const categoryIds = Object.fromEntries(categories.map((category) => [category.slug, category.id]));

  const articleRows = seedArticles
    .filter((article) => categoryIds[article.category])
    .map((article) => [
    article.slug,
    categoryIds[article.category],
    article.title,
    article.excerpt,
    article.body,
    article.author,
    authorSlugFromName(article.author),
    article.imageUrl,
    normalizeContentType(article.contentType),
    JSON.stringify(normalizeTags(article.tags)),
    article.featured ? 1 : 0,
    article.featuredOrder,
    Number(article.viewCount || 0),
  ]);

  if (articleRows.length) {
    await db.query(
      `INSERT INTO news_articles
        (slug, category_id, title, excerpt, body, author, author_slug, image_url, content_type, tags, is_featured, featured_order, view_count)
       VALUES ?
       ON DUPLICATE KEY UPDATE
        slug = VALUES(slug)`,
      [articleRows]
    );
  }

  await db.query(`
    INSERT IGNORE INTO news_article_categories (article_id, category_id)
    SELECT id, category_id
    FROM news_articles
    WHERE category_id IS NOT NULL
  `);

  await cleanupLegacyDbCategories();

  await db.query(
    `
    INSERT IGNORE INTO news_article_years (article_id, graduation_year)
    SELECT a.id, ?
    FROM news_articles a
    WHERE NOT EXISTS (
      SELECT 1 FROM news_article_years ay WHERE ay.article_id = a.id
    )
    `,
    [defaultGraduationYear]
  );
}

async function initializeNews() {
  await runDatabaseMigrations();
}

function mapArticle(row) {
  const primaryCategory = {
    id: row.category_id,
    slug: row.category_slug,
    name: row.category_name,
  };
  const seenCategorySlugs = new Set();
  const categories = parseDbCategories(row.category_pairs, primaryCategory)
    .filter((category) => {
      const slug = normalizeSlug(category.slug);
      if (!slug || seenCategorySlugs.has(slug)) return false;
      seenCategorySlugs.add(slug);
      return true;
    })
    .map((category) => ({
      id: category.id || null,
      slug: normalizeSlug(category.slug),
      name: category.name || category.slug,
    }));

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    body: row.body,
    author: row.author,
    authorSlug: row.author_slug || authorSlugFromName(row.author),
    imageUrl: asPublicImageUrl(row.image_url),
    contentType: normalizeContentType(row.content_type),
    tags: parseStoredTags(row.tags),
    isFeatured: Boolean(row.is_featured),
    featured: Boolean(row.is_featured),
    featuredOrder: row.featured_order,
    viewCount: Number(row.view_count || 0),
    status: row.status || "published",
    deletedAt: row.deleted_at,
    metaTitle: row.meta_title || "",
    metaDescription: row.meta_description || "",
    createdByAdminId: row.created_by_admin_id || null,
    updatedByAdminId: row.updated_by_admin_id || null,
    publishedAt: row.published_at,
    category: categories[0] || null,
    categories,
    categorySlugs: categories.map((category) => category.slug),
  };
}

function mapAlumniProfile(row = {}) {
  return {
    author: row.author || "",
    authorSlug: row.author_slug || authorSlugFromName(row.author),
    graduationYear: Number(row.graduation_year || row.graduationYear || defaultGraduationYear),
    bio: row.bio || "",
    university: row.university || "",
    major: row.major || "",
    currentWork: row.current_work || row.currentWork || "",
    socialLinks: parseStoredSocialLinks(row.social_links || row.socialLinks),
    articleCount: Number(row.article_count || row.articleCount || 0),
    latestPublishedAt: row.latest_published_at || row.latestPublishedAt || null,
  };
}

function articleTaxonomySelectSql() {
  return `
    (
      SELECT GROUP_CONCAT(CONCAT(c.slug, '|', c.name) ORDER BY c.name SEPARATOR ';;')
      FROM news_article_categories ac
      JOIN news_categories c ON c.id = ac.category_id
      WHERE ac.article_id = a.id
    ) AS category_pairs,
    (
      SELECT GROUP_CONCAT(ay.graduation_year ORDER BY ay.graduation_year SEPARATOR ',')
      FROM news_article_years ay
      WHERE ay.article_id = a.id
    ) AS graduation_years
  `;
}

function articleTaxonomyParams() {
  return [];
}

function visibleArticleFilterSql() {
  return `
    EXISTS (
      SELECT 1
      FROM news_article_categories visible_ac
      WHERE visible_ac.article_id = a.id
    )
  `;
}

function categoryArticleFilterSql() {
  return `
    EXISTS (
      SELECT 1
      FROM news_article_categories filter_ac
      JOIN news_categories filter_c ON filter_c.id = filter_ac.category_id
      WHERE filter_ac.article_id = a.id AND filter_c.slug = ?
    )
  `;
}

function graduationYearFilterSql() {
  return `
    EXISTS (
      SELECT 1
      FROM news_article_years filter_year
      WHERE filter_year.article_id = a.id AND filter_year.graduation_year = ?
    )
  `;
}

function articleSelectSql(whereSql, suffixSql = "") {
  return `
    SELECT
      a.id,
      a.slug,
      a.category_id,
      a.title,
      a.excerpt,
      a.body,
      a.author,
      a.author_slug,
      a.image_url,
      a.content_type,
      a.tags,
      a.is_featured,
      a.featured_order,
      a.view_count,
      a.status,
      a.deleted_at,
      a.meta_title,
      a.meta_description,
      a.created_by_admin_id,
      a.updated_by_admin_id,
      a.published_at,
      c.slug AS category_slug,
      c.name AS category_name,
      ${articleTaxonomySelectSql()}
    FROM news_articles a
    JOIN news_categories c ON c.id = a.category_id
    WHERE ${whereSql}
    ${suffixSql}
  `;
}

async function setDbArticleTaxonomy(articleId, categorySlugs, graduationYears, executor = db) {
  const [categoryRows] = await executor.query(
    `SELECT id, slug FROM news_categories WHERE slug IN (${categorySlugs.map(() => "?").join(", ")})`,
    categorySlugs
  );

  if (categoryRows.length !== categorySlugs.length) {
    throw createHttpError("Category not found.");
  }

  const categoryIdsBySlug = Object.fromEntries(categoryRows.map((category) => [category.slug, category.id]));
  const orderedCategoryIds = categorySlugs.map((slug) => categoryIdsBySlug[slug]);

  await executor.query("DELETE FROM news_article_categories WHERE article_id = ?", [articleId]);
  await executor.query("INSERT INTO news_article_categories (article_id, category_id) VALUES ?", [
    orderedCategoryIds.map((categoryId) => [articleId, categoryId]),
  ]);

  await executor.query("DELETE FROM news_article_years WHERE article_id = ?", [articleId]);
  await executor.query("INSERT INTO news_article_years (article_id, graduation_year) VALUES ?", [
    graduationYears.map((year) => [articleId, year]),
  ]);

  await executor.query("UPDATE news_articles SET category_id = ? WHERE id = ?", [orderedCategoryIds[0], articleId]);
}

async function upsertDbAlumniProfiles(article = {}, executor = db) {
  const author = String(article.author || "").trim();
  const authorSlug = article.authorSlug || authorSlugFromName(author);
  const profile = article.alumniProfile || {};
  const socialLinks = JSON.stringify(normalizeSocialLinks(profile.socialLinks));
  const graduationYears = article.graduationYears?.length ? article.graduationYears : [defaultGraduationYear];

  for (const graduationYear of graduationYears) {
    await executor.query(
      `
      INSERT INTO alumni_profiles
        (author_slug, author, graduation_year, bio, university, major, current_work, social_links)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        author = VALUES(author),
        bio = COALESCE(NULLIF(VALUES(bio), ''), bio),
        university = COALESCE(NULLIF(VALUES(university), ''), university),
        major = COALESCE(NULLIF(VALUES(major), ''), major),
        current_work = COALESCE(NULLIF(VALUES(current_work), ''), current_work),
        social_links = IF(VALUES(social_links) = '[]', social_links, VALUES(social_links))
      `,
      [
        authorSlug,
        author,
        graduationYear,
        profile.bio || "",
        profile.university || "",
        profile.major || "",
        profile.currentWork || "",
        socialLinks,
      ]
    );
  }
}

async function nextDbFeaturedOrder(executor = db) {
  const [rows] = await executor.query("SELECT COALESCE(MAX(featured_order), 0) + 1 AS nextOrder FROM news_articles WHERE is_featured = 1");
  return Number(rows[0]?.nextOrder || 1);
}

async function assertDbFeaturedCapacity(exceptSlug = "", executor = db) {
  const [rows] = await executor.query("SELECT COUNT(*) AS featuredCount FROM news_articles WHERE is_featured = 1 AND slug <> ?", [exceptSlug]);
  if (Number(rows[0]?.featuredCount || 0) >= featuredLimit) {
    throw createHttpError(`Only ${featuredLimit} featured posts are allowed. Unfeature another article first.`);
  }
}

async function normalizeDbFeaturedOrders(executor = db) {
  const [featuredRows] = await executor.query(
    `
    SELECT slug
    FROM news_articles
    WHERE is_featured = 1
    ORDER BY COALESCE(featured_order, 9999), published_at DESC, id DESC
    `
  );

  for (const [index, article] of featuredRows.entries()) {
    await executor.query("UPDATE news_articles SET featured_order = ? WHERE slug = ?", [index + 1, article.slug]);
  }
}

async function setDbFeaturedPlacement(slug, featured, requestedOrder = null, executor = db) {
  const [targetRows] = await executor.query("SELECT slug, is_featured, featured_order FROM news_articles WHERE slug = ? LIMIT 1", [slug]);
  if (targetRows.length === 0) return false;

  const [featuredRows] = await executor.query(
    `
    SELECT slug, featured_order, published_at, id
    FROM news_articles
    WHERE is_featured = 1 AND slug <> ?
    ORDER BY COALESCE(featured_order, 9999), published_at DESC, id DESC
    `,
    [slug]
  );

  if (featured && featuredRows.length >= featuredLimit) {
    throw createHttpError(`Only ${featuredLimit} featured posts are allowed. Unfeature another article first.`);
  }

  if (!featured) {
    await executor.query("UPDATE news_articles SET is_featured = 0, featured_order = NULL WHERE slug = ?", [slug]);
    for (const [index, article] of featuredRows.entries()) {
      await executor.query("UPDATE news_articles SET featured_order = ? WHERE slug = ?", [index + 1, article.slug]);
    }
    return true;
  }

  const currentOrder = normalizeFeaturedOrder(targetRows[0].featured_order);
  const order = normalizeFeaturedOrder(requestedOrder) || currentOrder || featuredRows.length + 1;
  const insertIndex = Math.max(0, Math.min(order - 1, featuredRows.length));
  const orderedSlugs = featuredRows.map((article) => article.slug);
  orderedSlugs.splice(insertIndex, 0, slug);

  await executor.query("UPDATE news_articles SET is_featured = 1 WHERE slug = ?", [slug]);
  for (const [index, articleSlug] of orderedSlugs.entries()) {
    await executor.query("UPDATE news_articles SET featured_order = ? WHERE slug = ?", [index + 1, articleSlug]);
  }

  return true;
}

function makeSlug(title) {
  return normalizeSlug(title) || "article";
}

function uniqueMemorySlug(baseSlug, currentSlug = "") {
  const base = normalizeSlug(baseSlug) || "article";
  let slug = base;
  let index = 2;

  while (memoryArticles.some((article) => article.slug === slug && article.slug !== currentSlug)) {
    slug = `${base}-${index}`;
    index += 1;
  }

  return slug;
}

async function uniqueDbSlug(baseSlug, currentSlug = "", executor = db) {
  const base = normalizeSlug(baseSlug) || "article";
  let slug = base;
  let index = 2;

  while (true) {
    const params = currentSlug ? [slug, currentSlug] : [slug];
    const where = currentSlug ? "slug = ? AND slug <> ?" : "slug = ?";
    const [rows] = await executor.query(`SELECT id FROM news_articles WHERE ${where} LIMIT 1`, params);
    if (!rows.length) return slug;
    slug = `${base}-${index}`;
    index += 1;
  }
}

async function withTransaction(work) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      logRouteError("database rollback", rollbackError);
    }
    throw error;
  } finally {
    connection.release();
  }
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
    const [rows] = await db.query(
      `
      SELECT
        c.id,
        c.slug,
        c.name,
        c.sort_order AS sortOrder,
        c.visible_in_header AS visibleInHeader,
        c.visible_on_homepage AS visibleOnHomepage,
        c.parent_id AS parentId,
        COUNT(DISTINCT a.id) AS articleCount,
        COUNT(DISTINCT child.id) AS subcategoryCount
      FROM news_categories c
      LEFT JOIN news_article_categories ac ON ac.category_id = c.id
      LEFT JOIN news_articles a ON a.id = ac.article_id AND a.status = 'published' AND a.deleted_at IS NULL
      LEFT JOIN news_categories child ON child.parent_id = c.id
      GROUP BY c.id, c.slug, c.name, c.sort_order, c.visible_in_header, c.visible_on_homepage, c.parent_id
      ORDER BY c.sort_order ASC, c.name ASC
      `
    );

    res.json(rows.map(categoryResponse));
  } catch (error) {
    logRouteError("GET /api/categories", error);
    ensureMemoryFallbackReady();
    if (!isProduction()) {
      res.json(getMemoryCategories());
      return;
    }
    res.status(500).json({ message: "Could not load categories." });
  }
});

app.get("/api/content-types", (_req, res) => {
  res.json(contentTypeOptions);
});

app.post("/api/admin/categories", sensitiveRateLimiter, requireAdmin, async (req, res) => {
  try {
    assertEditorOrOwner(req.admin);

    if (usingMemoryStore) {
      return res.status(201).json(createMemoryCategory(req.body));
    }

    const category = normalizeCategoryPayload(req.body);
    const [result] = await db.query(
      "INSERT INTO news_categories (slug, name, sort_order, visible_in_header, visible_on_homepage, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
      [category.slug, category.name, category.sortOrder, category.visibleInHeader ? 1 : 0, category.visibleOnHomepage ? 1 : 0, category.parentId]
    );
    res.status(201).json(categoryResponse({ id: result.insertId, ...category, articleCount: 0, subcategoryCount: 0 }));
  } catch (error) {
    logRouteError("POST /api/admin/categories", error);
    const isDuplicate = error?.code === "ER_DUP_ENTRY" || error?.statusCode === 409;
    res.status(isDuplicate ? 409 : error.statusCode || 500).json({ message: isDuplicate ? "Category slug already exists." : error.message || "Could not create category." });
  }
});

app.patch("/api/admin/categories/:slug", sensitiveRateLimiter, requireAdmin, async (req, res) => {
  try {
    assertEditorOrOwner(req.admin);

    if (usingMemoryStore) {
      const category = updateMemoryCategory(req.params.slug, req.body);
      if (!category) return res.status(404).json({ message: "Category not found." });
      return res.json(category);
    }

    const category = normalizeCategoryPayload(req.body);
    const [result] = await db.query(
      "UPDATE news_categories SET slug = ?, name = ?, sort_order = ?, visible_in_header = ?, visible_on_homepage = ?, parent_id = ? WHERE slug = ?",
      [category.slug, category.name, category.sortOrder, category.visibleInHeader ? 1 : 0, category.visibleOnHomepage ? 1 : 0, category.parentId, normalizeSlug(req.params.slug)]
    );
    if (result.affectedRows === 0) return res.status(404).json({ message: "Category not found." });
    const [rows] = await db.query(
      `
      SELECT
        c.id,
        c.slug,
        c.name,
        c.sort_order AS sortOrder,
        c.visible_in_header AS visibleInHeader,
        c.visible_on_homepage AS visibleOnHomepage,
        c.parent_id AS parentId,
        COUNT(DISTINCT a.id) AS articleCount,
        COUNT(DISTINCT child.id) AS subcategoryCount
      FROM news_categories c
      LEFT JOIN news_article_categories ac ON ac.category_id = c.id
      LEFT JOIN news_articles a ON a.id = ac.article_id AND a.status = 'published' AND a.deleted_at IS NULL
      LEFT JOIN news_categories child ON child.parent_id = c.id
      WHERE c.slug = ?
      GROUP BY c.id, c.slug, c.name, c.sort_order, c.visible_in_header, c.visible_on_homepage, c.parent_id
      LIMIT 1
      `,
      [category.slug]
    );
    res.json(categoryResponse(rows[0] || category));
  } catch (error) {
    logRouteError("PATCH /api/admin/categories/:slug", error);
    const isDuplicate = error?.code === "ER_DUP_ENTRY" || error?.statusCode === 409;
    res.status(isDuplicate ? 409 : error.statusCode || 500).json({ message: isDuplicate ? "Category slug already exists." : error.message || "Could not update category." });
  }
});

app.delete("/api/admin/categories/:slug", sensitiveRateLimiter, requireAdmin, async (req, res) => {
  try {
    assertEditorOrOwner(req.admin);
    const slug = normalizeSlug(req.params.slug);

    if (usingMemoryStore) {
      const category = memoryCategories.find((item) => item.slug === slug);
      if (!category) return res.status(404).json({ message: "Category not found." });
      const articleCount = memoryArticles.filter((article) => {
        const categorySlugs = article.category_slugs?.length
          ? article.category_slugs
          : [memoryCategories.find((item) => item.id === article.category_id)?.slug].filter(Boolean);
        return categorySlugs.includes(slug);
      }).length;
      if (articleCount) {
        return res.status(409).json({ message: "This category has articles. Move or edit those articles before deleting it." });
      }
      memoryCategories = memoryCategories.filter((item) => item.slug !== slug);
      return res.status(204).end();
    }

    const [rows] = await db.query("SELECT id FROM news_categories WHERE slug = ? LIMIT 1", [slug]);
    if (!rows.length) return res.status(404).json({ message: "Category not found." });
    const categoryId = rows[0].id;
    const [articleCountRows] = await db.query(
      `
      SELECT COUNT(DISTINCT a.id) AS count
      FROM news_articles a
      LEFT JOIN news_article_categories ac ON ac.article_id = a.id
      WHERE a.category_id = ? OR ac.category_id = ?
      `,
      [categoryId, categoryId]
    );
    if (Number(articleCountRows[0]?.count || 0) > 0) {
      return res.status(409).json({ message: "This category has articles. Move or edit those articles before deleting it." });
    }

    await db.query("DELETE FROM news_categories WHERE id = ?", [categoryId]);
    res.status(204).end();
  } catch (error) {
    logRouteError("DELETE /api/admin/categories/:slug", error);
    res.status(error.statusCode || 500).json({ message: error.message || "Could not delete category." });
  }
});
async function completeAdminLogin(req, res) {
  try {
    const { email, password } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (!normalizedEmail || !password) {
      return res.status(400).json({
        message: "Email and password are required."
      });
    }

    if (usingMemoryStore) {
      const configuredAdmin = await authenticateConfiguredAdmin(normalizedEmail, password);
      if (!configuredAdmin) {
        return res.status(401).json({
          message: "Wrong password"
        });
      }

      const adminProfile = sanitizeAdminProfile(configuredAdmin);
      return res.json({
        ok: true,
        token: createAdminToken(adminProfile),
        admin: adminProfile
      });
    }

    const [rows] = await db.query(
      "SELECT id, name, email, role, password_hash FROM admins WHERE email = ? LIMIT 1",
      [normalizedEmail]
    );

    if (!rows.length) {
      return res.status(401).json({
        message: "Wrong password"
      });
    }

    const admin = rows[0];

    const correctPassword = await bcrypt.compare(
      password,
      admin.password_hash
    );

    if (!correctPassword) {
      return res.status(401).json({
        message: "Wrong password"
      });
    }

    const adminProfile = sanitizeAdminProfile(admin);
    const token = createAdminToken(adminProfile);

    res.json({
      ok: true,
      token,
      admin: adminProfile
    });

  } catch (error) {
    logRouteError("POST /api/admin/login", error);
    res.status(error.statusCode || 500).json({
      message: error.statusCode === 503 ? error.message : "Server error"
    });
  }
}

app.post("/api/admin/login", adminLoginRateLimiter, completeAdminLogin);

app.post("/api/admin/verify", requireAdmin, (req, res) => {
  res.json({ ok: true, admin: sanitizeAdminProfile(req.admin) });
});

app.get("/api/admin/session", requireAdmin, (req, res) => {
  res.json({ ok: true, admin: sanitizeAdminProfile(req.admin) });
});

app.patch("/api/admin/password", sensitiveRateLimiter, requireAdmin, async (req, res) => {
  try {
    if (usingMemoryStore) {
      return res.status(400).json({ message: "Password changes require database-backed admins." });
    }

    const currentPassword = String(req.body.currentPassword || "");
    const nextPassword = String(req.body.newPassword || req.body.password || "");
    if (!currentPassword || !nextPassword) {
      return res.status(400).json({ message: "Current password and new password are required." });
    }

    assertStrongPassword(nextPassword);

    const [rows] = await db.query("SELECT id, password_hash FROM admins WHERE id = ? LIMIT 1", [adminIdValue(req.admin)]);
    if (!rows.length) return res.status(404).json({ message: "Admin not found." });

    const currentPasswordOk = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!currentPasswordOk) return res.status(401).json({ message: "Current password is incorrect." });

    const passwordHash = await bcrypt.hash(nextPassword, 12);
    await db.query("UPDATE admins SET password_hash = ? WHERE id = ?", [passwordHash, rows[0].id]);
    res.json({ ok: true });
  } catch (error) {
    logRouteError("PATCH /api/admin/password", error);
    res.status(error.statusCode || 500).json({ message: error.message || "Could not change password." });
  }
});

app.get("/api/admin/admins", requireAdmin, requireOwner, async (_req, res) => {
  try {
    const [rows] = await db.query("SELECT id, name, email, role, created_at FROM admins ORDER BY role = 'owner' DESC, name ASC, email ASC");
    res.json(rows.map(sanitizeAdminProfile));
  } catch (error) {
    logRouteError("GET /api/admin/admins", error);
    res.status(500).json({ message: "Could not load admins." });
  }
});

app.post("/api/admin/admins", sensitiveRateLimiter, requireAdmin, requireOwner, async (req, res) => {
  try {
    const name = sanitizePlainText(req.body.name, 140);
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const role = normalizeAdminRole(req.body.role);

    if (!name || !email || !password || !isValidEmail(email)) {
      return res.status(400).json({ message: "Name, email, and password are required." });
    }

    assertStrongPassword(password);

    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      "INSERT INTO admins (name, email, password_hash, role) VALUES (?, ?, ?, ?)",
      [name, email, passwordHash, role]
    );

    res.status(201).json({ id: result.insertId, name, email, role });
  } catch (error) {
    logRouteError("POST /api/admin/admins", error);
    const isDuplicate = error?.code === "ER_DUP_ENTRY";
    res.status(isDuplicate ? 409 : error.statusCode || 500).json({ message: isDuplicate ? "Admin email already exists." : error.message || "Could not add admin." });
  }
});

app.patch("/api/admin/admins/:id", sensitiveRateLimiter, requireAdmin, requireOwner, async (req, res) => {
  try {
    const adminId = Number(req.params.id);
    const name = sanitizePlainText(req.body.name, 140);
    const email = String(req.body.email || "").trim().toLowerCase();
    const role = normalizeAdminRole(req.body.role);

    if (!adminId || !name || !email || !isValidEmail(email)) {
      return res.status(400).json({ message: "Name, email, and role are required." });
    }

    const [existingRows] = await db.query("SELECT id, role FROM admins WHERE id = ? LIMIT 1", [adminId]);
    if (!existingRows.length) {
      return res.status(404).json({ message: "Admin not found." });
    }

    if (normalizeAdminRole(existingRows[0].role) === "owner" && role !== "owner") {
      const [ownerRows] = await db.query("SELECT COUNT(*) AS ownerCount FROM admins WHERE role = 'owner' AND id <> ?", [adminId]);
      if (Number(ownerRows[0]?.ownerCount || 0) === 0) {
        return res.status(400).json({ message: "Cannot remove the last owner role." });
      }
    }

    await db.query("UPDATE admins SET name = ?, email = ?, role = ? WHERE id = ?", [name, email, role, adminId]);
    res.json({ id: adminId, name, email, role });
  } catch (error) {
    logRouteError("PATCH /api/admin/admins/:id", error);
    const isDuplicate = error?.code === "ER_DUP_ENTRY";
    res.status(isDuplicate ? 409 : 500).json({ message: isDuplicate ? "Admin email already exists." : "Could not update admin." });
  }
});

app.delete("/api/admin/admins/:id", sensitiveRateLimiter, requireAdmin, requireOwner, async (req, res) => {
  try {
    const adminId = Number(req.params.id);
    const [existingRows] = await db.query("SELECT id, role FROM admins WHERE id = ? LIMIT 1", [adminId]);
    if (!existingRows.length) {
      return res.status(404).json({ message: "Admin not found." });
    }

    if (normalizeAdminRole(existingRows[0].role) === "owner") {
      const [ownerRows] = await db.query("SELECT COUNT(*) AS ownerCount FROM admins WHERE role = 'owner' AND id <> ?", [adminId]);
      if (Number(ownerRows[0]?.ownerCount || 0) === 0) {
        return res.status(400).json({ message: "Cannot remove the last owner." });
      }
    }

    await db.query("DELETE FROM admins WHERE id = ?", [adminId]);
    res.json({ ok: true });
  } catch (error) {
    logRouteError("DELETE /api/admin/admins/:id", error);
    res.status(500).json({ message: "Could not remove admin." });
  }
});

app.patch("/api/admin/admins/:id/password", sensitiveRateLimiter, requireAdmin, requireOwner, async (req, res) => {
  try {
    if (usingMemoryStore) {
      return res.status(400).json({ message: "Password changes require database-backed admins." });
    }

    const adminId = Number(req.params.id);
    const password = String(req.body.password || req.body.newPassword || "");
    if (!adminId || !password) {
      return res.status(400).json({ message: "Admin id and password are required." });
    }

    assertStrongPassword(password);
    const [existingRows] = await db.query("SELECT id FROM admins WHERE id = ? LIMIT 1", [adminId]);
    if (!existingRows.length) return res.status(404).json({ message: "Admin not found." });

    const passwordHash = await bcrypt.hash(password, 12);
    await db.query("UPDATE admins SET password_hash = ? WHERE id = ?", [passwordHash, adminId]);
    res.json({ ok: true });
  } catch (error) {
    logRouteError("PATCH /api/admin/admins/:id/password", error);
    res.status(error.statusCode || 500).json({ message: error.message || "Could not change admin password." });
  }
});

app.post("/api/admin/images", sensitiveRateLimiter, requireAdmin, async (req, res) => {
  try {
    const imageUrl = await saveUploadedImage(req.body);
    res.status(201).json({ ok: true, imageUrl });
  } catch (error) {
    logRouteError("POST /api/admin/images", error);
    res.status(error.statusCode || 500).json({ message: error.message || "Could not upload image." });
  }
});

app.get("/api/admin/articles", requireAdmin, async (req, res) => {
  const status = normalizeArticleStatus(req.query.status, "");
  const pagination = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const shouldPaginate = hasPaginationQuery(req.query);

  if (usingMemoryStore) {
    const articles = getMemoryArticles({ status, includeAdmin: true }).filter((article) => {
      if (isEditorOrOwner(req.admin)) return true;
      return article.status === "draft" && Number(article.createdByAdminId || 0) === Number(req.admin.id || 0);
    });
    res.json(shouldPaginate ? paginatedMemoryResponse(articles, pagination) : articles);
    return;
  }

  try {
    const where = [visibleArticleFilterSql()];
    const params = [];

    if (status) {
      where.push("a.status = ?");
      params.push(status);
    }

    if (!isEditorOrOwner(req.admin)) {
      where.push("a.status = 'draft' AND a.created_by_admin_id = ?");
      params.push(adminIdValue(req.admin) || 0);
    }

    const [countRows] = await db.query(
      `SELECT COUNT(DISTINCT a.id) AS total FROM news_articles a WHERE ${where.join(" AND ")}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pagination.limit));
    const suffix = shouldPaginate
      ? "ORDER BY a.deleted_at IS NOT NULL, a.status = 'published' DESC, a.published_at DESC, a.id DESC LIMIT ? OFFSET ?"
      : "ORDER BY a.deleted_at IS NOT NULL, a.status = 'published' DESC, a.published_at DESC, a.id DESC";
    const queryParams = shouldPaginate
      ? [...articleTaxonomyParams(), ...params, pagination.limit, pagination.offset]
      : [...articleTaxonomyParams(), ...params];

    const [rows] = await db.query(articleSelectSql(where.join(" AND "), suffix), queryParams);
    const items = rows.map(mapArticle);

    res.json(shouldPaginate ? {
      items,
      page: pagination.page,
      limit: pagination.limit,
      total,
      totalPages,
    } : items);
  } catch (error) {
    logRouteError("GET /api/admin/articles", error);
    res.status(500).json({ message: "Could not load admin articles." });
  }
});

app.get("/api/admin/articles/:slug/audit", requireAdmin, async (req, res) => {
  if (usingMemoryStore) {
    const article = memoryArticles.find((item) => item.slug === req.params.slug);
    if (!article) return res.status(404).json({ message: "Article not found." });
    try {
      assertCanEditArticle(req.admin, article);
      res.json(getMemoryAuditLogs(req.params.slug));
    } catch (error) {
      logRouteError("GET /api/admin/articles/:slug/audit memory", error);
      res.status(error.statusCode || 500).json({ message: error.message || "Could not load audit history." });
    }
    return;
  }

  try {
    const [articleRows] = await db.query("SELECT id, status, deleted_at, created_by_admin_id FROM news_articles WHERE slug = ? LIMIT 1", [req.params.slug]);
    if (!articleRows.length) return res.status(404).json({ message: "Article not found." });
    assertCanEditArticle(req.admin, articleRows[0]);

    const [rows] = await db.query(
      "SELECT id, admin_id, admin_name, admin_email, admin_role, action, details, created_at FROM article_audit_logs WHERE article_id = ? ORDER BY created_at DESC, id DESC",
      [articleRows[0].id]
    );

    res.json(rows.map(mapAuditLog));
  } catch (error) {
    logRouteError("GET /api/admin/articles/:slug/audit", error);
    res.status(error.statusCode || 500).json({ message: error.message || "Could not load audit history." });
  }
});

app.get("/api/alumni", async (req, res) => {
  if (usingMemoryStore) {
    res.json(getMemoryAlumniProfiles({ year: req.query.year }));
    return;
  }

  try {
    const selectedYear = Number(req.query.year);
    const where = ["a.status = 'published'", "a.deleted_at IS NULL"];
    const params = [];

    if (graduationYearOptions.includes(selectedYear)) {
      where.push("ay.graduation_year = ?");
      params.push(selectedYear);
    }

    const [rows] = await db.query(
      `
      SELECT
        a.author,
        a.author_slug,
        ay.graduation_year,
        p.bio,
        p.university,
        p.major,
        p.current_work,
        p.social_links,
        COUNT(DISTINCT a.id) AS article_count,
        MAX(a.published_at) AS latest_published_at
      FROM news_articles a
      JOIN news_article_years ay ON ay.article_id = a.id
      LEFT JOIN alumni_profiles p ON p.author_slug = a.author_slug AND p.graduation_year = ay.graduation_year
      WHERE ${where.join(" AND ")}
      GROUP BY a.author, a.author_slug, ay.graduation_year, p.bio, p.university, p.major, p.current_work, p.social_links
      ORDER BY ay.graduation_year DESC, a.author ASC
      `,
      params
    );

    res.json(rows.map(mapAlumniProfile));
  } catch (error) {
    logRouteError("GET /api/alumni", error);
    res.status(500).json({ message: "Could not load alumni profiles." });
  }
});

app.get("/api/alumni/:year/:authorSlug", async (req, res) => {
  const graduationYear = Number(req.params.year);
  const authorSlug = String(req.params.authorSlug || "").trim();

  if (!graduationYearOptions.includes(graduationYear) || !authorSlug) {
    return res.status(404).json({ message: "Alumni profile not found." });
  }

  if (usingMemoryStore) {
    const writings = getMemoryArticles({ year: graduationYear, author: authorSlug });
    if (!writings.length) return res.status(404).json({ message: "Alumni profile not found." });
    const profile = getMemoryAlumniProfiles({ year: graduationYear }).find((item) => item.authorSlug === authorSlug);
    res.json({ profile, writings });
    return;
  }

  try {
    const [articleRows] = await db.query(
      articleSelectSql(
        `a.status = 'published' AND a.deleted_at IS NULL AND a.author_slug = ? AND ${graduationYearFilterSql()}`,
        "ORDER BY a.published_at DESC, a.id DESC"
      ),
      [...articleTaxonomyParams(), authorSlug, graduationYear]
    );

    if (!articleRows.length) {
      return res.status(404).json({ message: "Alumni profile not found." });
    }

    const [profileRows] = await db.query(
      "SELECT author, author_slug, graduation_year, bio, university, major, current_work, social_links FROM alumni_profiles WHERE author_slug = ? AND graduation_year = ? LIMIT 1",
      [authorSlug, graduationYear]
    );
    const writings = articleRows.map(mapArticle);
    const profile = mapAlumniProfile(profileRows[0] || {
      author: writings[0].author,
      author_slug: authorSlug,
      graduation_year: graduationYear,
      article_count: writings.length,
      latest_published_at: writings[0].publishedAt,
    });

    res.json({ profile: { ...profile, articleCount: writings.length, latestPublishedAt: writings[0].publishedAt }, writings });
  } catch (error) {
    logRouteError("GET /api/alumni/:year/:authorSlug", error);
    res.status(500).json({ message: "Could not load alumni profile." });
  }
});

app.get("/api/articles", async (req, res) => {
  const pagination = parsePagination(req.query, { defaultLimit: 9, maxLimit: 50 });
  const shouldPaginate = hasPaginationQuery(req.query);

  if (usingMemoryStore) {
    const { q = "", category = "", contentType = "", author = "" } = req.query;
    const articles = getMemoryArticles({ q, category, contentType, author, editorPick: isTruthy(req.query.editorPick) });
    res.json(shouldPaginate ? paginatedMemoryResponse(articles, pagination) : articles);
    return;
  }

  try {
    const { q = "", category = "", contentType = "", author = "" } = req.query;
    const where = ["a.status = 'published'", "a.deleted_at IS NULL", visibleArticleFilterSql()];
    const params = [];

    if (category && category !== "all") {
      where.push(categoryArticleFilterSql());
      params.push(normalizeSlug(category));
    }

    if (contentType && contentType !== "all") {
      where.push("a.content_type = ?");
      params.push(normalizeContentType(contentType));
    }

    if (author && author !== "all") {
      where.push("a.author_slug = ?");
      params.push(String(author).trim());
    }

    if (isTruthy(req.query.editorPick)) {
      where.push("a.is_featured = 1");
    }

    if (q.trim()) {
      where.push("(LOWER(a.title) LIKE ? OR LOWER(a.excerpt) LIKE ? OR LOWER(a.body) LIKE ? OR LOWER(a.author) LIKE ? OR LOWER(a.content_type) LIKE ? OR LOWER(COALESCE(a.tags, '')) LIKE ?)");
      const search = `%${q.trim().toLowerCase()}%`;
      params.push(search, search, search, search, search, search);
    }

    const [countRows] = await db.query(
      `SELECT COUNT(DISTINCT a.id) AS total FROM news_articles a WHERE ${where.join(" AND ")}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pagination.limit));
    const suffix = shouldPaginate
      ? "ORDER BY a.published_at DESC, a.id DESC LIMIT ? OFFSET ?"
      : "ORDER BY a.published_at DESC, a.id DESC";
    const queryParams = shouldPaginate
      ? [...articleTaxonomyParams(), ...params, pagination.limit, pagination.offset]
      : [...articleTaxonomyParams(), ...params];

    const [rows] = await db.query(
      articleSelectSql(where.join(" AND "), suffix),
      queryParams
    );

    const items = rows.map(mapArticle);
    if (shouldPaginate) {
      return res.json({
        items,
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages,
      });
    }

    res.json(items);
  } catch (error) {
    logRouteError("GET /api/articles", error);
    ensureMemoryFallbackReady();
    if (!isProduction()) {
      const { q = "", category = "", contentType = "", author = "" } = req.query;
      const articles = getMemoryArticles({ q, category, contentType, author, editorPick: isTruthy(req.query.editorPick) });
      res.json(shouldPaginate ? paginatedMemoryResponse(articles, pagination) : articles);
      return;
    }
    res.status(500).json({ message: "Could not load articles." });
  }
});

app.get("/api/articles/featured", async (_req, res) => {
  if (usingMemoryStore) {
    res.json(
      getMemoryArticles()
        .filter((article) => article.isFeatured)
        .sort((left, right) => (left.featuredOrder || 9999) - (right.featuredOrder || 9999))
        .slice(0, featuredLimit)
    );
    return;
  }

  try {
    const [rows] = await db.query(
      articleSelectSql(
        `a.is_featured = 1 AND a.status = 'published' AND a.deleted_at IS NULL AND ${visibleArticleFilterSql()}`,
        `ORDER BY COALESCE(a.featured_order, 9999), a.published_at DESC, a.id DESC LIMIT ${featuredLimit}`
      ),
      [...articleTaxonomyParams()]
    );

    res.json(rows.map(mapArticle));
  } catch (error) {
    logRouteError("GET /api/articles/featured", error);
    ensureMemoryFallbackReady();
    if (!isProduction()) {
      res.json(
        getMemoryArticles()
          .filter((article) => article.isFeatured)
          .sort((left, right) => (left.featuredOrder || 9999) - (right.featuredOrder || 9999))
          .slice(0, featuredLimit)
      );
      return;
    }
    res.status(500).json({ message: "Could not load featured articles." });
  }
});

app.get("/api/articles/:slug", async (req, res) => {
  const authenticatedAdmin = getAdminFromRequest(req);
  const shouldIncrementView = !authenticatedAdmin;

  if (usingMemoryStore) {
    const article = getMemoryArticle(req.params.slug, { incrementView: shouldIncrementView });

    if (!article) {
      return res.status(404).json({ message: "Article not found." });
    }

    res.json(article);
    return;
  }

  try {
    if (shouldIncrementView) {
      const [updateResult] = await db.query("UPDATE news_articles SET view_count = view_count + 1 WHERE slug = ? AND status = 'published' AND deleted_at IS NULL", [req.params.slug]);

      if (updateResult.affectedRows === 0) {
        return res.status(404).json({ message: "Article not found." });
      }
    }

    const [rows] = await db.query(
      articleSelectSql("a.slug = ? AND a.status = 'published' AND a.deleted_at IS NULL", "LIMIT 1"),
      [...articleTaxonomyParams(), req.params.slug]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Article not found." });
    }

    res.json(mapArticle(rows[0]));
  } catch (error) {
    logRouteError("GET /api/articles/:slug", error);
    ensureMemoryFallbackReady();
    if (!isProduction()) {
      const article = getMemoryArticle(req.params.slug, { incrementView: shouldIncrementView });
      if (article) {
        res.json(article);
        return;
      }
    }
    res.status(500).json({ message: "Could not load article." });
  }
});

app.post("/api/articles", sensitiveRateLimiter, requireAdmin, async (req, res) => {
  if (usingMemoryStore) {
    try {
      res.status(201).json(createMemoryArticle(req.body, req.admin));
    } catch (error) {
      logRouteError("POST /api/articles memory", error);
      res.status(error.statusCode || 500).json({ message: error.message || "Could not save article." });
    }

    return;
  }

  try {
    const savedArticle = await withTransaction(async (connection) => {
      const article = validateArticlePayload(req.body, req.admin);
      assertCanCreateArticle(req.admin, article.status);
      const [categoryRows] = await connection.query("SELECT id FROM news_categories WHERE slug = ? LIMIT 1", [article.categorySlugs[0]]);

      if (categoryRows.length === 0) {
        throw createHttpError("Category not found.");
      }

      if (article.featured && article.status !== "published") {
        throw createHttpError("Only published articles can be featured.");
      }

      const slug = await uniqueDbSlug(article.slug || makeSlug(article.title), "", connection);
      if (article.featured) {
        await assertDbFeaturedCapacity("", connection);
      }

      const [insertResult] = await connection.query(
        `
        INSERT INTO news_articles
          (slug, category_id, title, excerpt, body, author, author_slug, image_url, content_type, tags, is_featured, featured_order, status, meta_title, meta_description, created_by_admin_id, updated_by_admin_id, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          slug,
          categoryRows[0].id,
          article.title,
          article.excerpt,
          article.body,
          article.author,
          article.authorSlug,
          article.imageUrl,
          article.contentType,
          JSON.stringify(article.tags),
          0,
          null,
          article.status,
          article.metaTitle,
          article.metaDescription,
          adminIdValue(req.admin),
          adminIdValue(req.admin),
          article.publishedAt,
        ]
      );

      await setDbArticleTaxonomy(insertResult.insertId, article.categorySlugs, article.graduationYears, connection);
      await upsertDbAlumniProfiles(article, connection);
      await setDbFeaturedPlacement(slug, article.featured, article.featuredOrder, connection);
      await addDbAuditLog(insertResult.insertId, req.admin, "created", { status: article.status }, connection);
      if (article.status === "published") {
        await addDbAuditLog(insertResult.insertId, req.admin, "published", { status: article.status }, connection);
      }

      const [rows] = await connection.query(
        articleSelectSql("a.slug = ?", "LIMIT 1"),
        [...articleTaxonomyParams(), slug]
      );

      return mapArticle(rows[0]);
    });

    res.status(201).json(savedArticle);
  } catch (error) {
    logRouteError("POST /api/articles", error);
    res.status(error.statusCode || 500).json({ message: error.message || "Could not save article." });
  }
});

app.put("/api/articles/:slug", sensitiveRateLimiter, requireAdmin, async (req, res) => {
  if (usingMemoryStore) {
    try {
      const article = updateMemoryArticle(req.params.slug, req.body, req.admin);
      if (!article) {
        return res.status(404).json({ message: "Article not found." });
      }

      res.json(article);
    } catch (error) {
      logRouteError("PUT /api/articles/:slug memory", error);
      res.status(error.statusCode || 500).json({ message: error.message || "Could not update article." });
    }

    return;
  }

  try {
    const savedArticle = await withTransaction(async (connection) => {
      const article = validateArticlePayload(req.body, req.admin);
      const [existingRows] = await connection.query("SELECT id, status, deleted_at, created_by_admin_id FROM news_articles WHERE slug = ? LIMIT 1 FOR UPDATE", [req.params.slug]);

      if (existingRows.length === 0) {
        throw createHttpError("Article not found.", 404);
      }

      assertCanEditArticle(req.admin, existingRows[0]);
      if (normalizeAdminRole(req.admin.role) === "writer" && article.status !== "draft") {
        throw createHttpError("Writers can only save drafts.", 403);
      }

      if (article.featured && article.status !== "published") {
        throw createHttpError("Only published articles can be featured.");
      }

      if (article.featured) {
        await assertDbFeaturedCapacity(req.params.slug, connection);
      }

      const nextSlug = await uniqueDbSlug(article.slug || makeSlug(article.title), req.params.slug, connection);
      const [result] = await connection.query(
        `
        UPDATE news_articles
        SET slug = ?,
            title = ?,
            excerpt = ?,
            body = ?,
            author = ?,
            author_slug = ?,
            image_url = ?,
            content_type = ?,
            tags = ?,
            status = ?,
            deleted_at = NULL,
            meta_title = ?,
            meta_description = ?,
            published_at = ?,
            updated_by_admin_id = ?
        WHERE slug = ?
        `,
        [
          nextSlug,
          article.title,
          article.excerpt,
          article.body,
          article.author,
          article.authorSlug,
          article.imageUrl,
          article.contentType,
          JSON.stringify(article.tags),
          article.status,
          article.metaTitle,
          article.metaDescription,
          article.publishedAt,
          adminIdValue(req.admin),
          req.params.slug,
        ]
      );

      if (result.affectedRows === 0) {
        throw createHttpError("Article not found.", 404);
      }

      await setDbArticleTaxonomy(existingRows[0].id, article.categorySlugs, article.graduationYears, connection);
      await upsertDbAlumniProfiles(article, connection);
      await setDbFeaturedPlacement(nextSlug, article.featured && article.status === "published", article.featuredOrder, connection);
      await addDbAuditLog(existingRows[0].id, req.admin, "edited", { status: article.status, previousStatus: existingRows[0].status }, connection);

      const [rows] = await connection.query(
        articleSelectSql("a.slug = ?", "LIMIT 1"),
        [...articleTaxonomyParams(), nextSlug]
      );

      return mapArticle(rows[0]);
    });

    res.json(savedArticle);
  } catch (error) {
    logRouteError("PUT /api/articles/:slug", error);
    res.status(error.statusCode || 500).json({ message: error.message || "Could not update article." });
  }
});

app.patch("/api/articles/:slug/featured", sensitiveRateLimiter, requireAdmin, async (req, res) => {
  const featured = isTruthy(req.body.isFeatured) || isTruthy(req.body.featured);
  const requestedOrder = normalizeFeaturedOrder(req.body.featuredOrder);

  if (usingMemoryStore) {
    try {
      const article = setMemoryArticleFeatured(req.params.slug, featured, requestedOrder, req.admin);
      if (!article) {
        return res.status(404).json({ message: "Article not found." });
      }

      res.json(article);
    } catch (error) {
      logRouteError("PATCH /api/articles/:slug/featured memory", error);
      res.status(error.statusCode || 500).json({ message: error.message || "Could not update featured status." });
    }
    return;
  }

  try {
    const savedArticle = await withTransaction(async (connection) => {
      assertEditorOrOwner(req.admin);
      const [articleRows] = await connection.query("SELECT id, status, deleted_at FROM news_articles WHERE slug = ? LIMIT 1 FOR UPDATE", [req.params.slug]);
      if (!articleRows.length) throw createHttpError("Article not found.", 404);

      if (featured && (articleRows[0].status !== "published" || articleRows[0].deleted_at)) {
        throw createHttpError("Only published articles can be featured.");
      }

      const updated = await setDbFeaturedPlacement(req.params.slug, featured, requestedOrder, connection);
      if (!updated) throw createHttpError("Article not found.", 404);

      await addDbAuditLog(articleRows[0].id, req.admin, featured ? "featured" : "unfeatured", { featuredOrder: requestedOrder }, connection);

      const [rows] = await connection.query(
        articleSelectSql("a.slug = ?", "LIMIT 1"),
        [...articleTaxonomyParams(), req.params.slug]
      );

      return mapArticle(rows[0]);
    });

    res.json(savedArticle);
  } catch (error) {
    logRouteError("PATCH /api/articles/:slug/featured", error);
    res.status(error.statusCode || 500).json({ message: error.message || "Could not update featured status." });
  }
});

async function changeArticleStatus(req, res, requestedStatus) {
  const status = normalizeArticleStatus(requestedStatus, "");
  if (!status) {
    return res.status(400).json({ message: "Valid status is required." });
  }

  if (usingMemoryStore) {
    try {
      const article = setMemoryArticleStatus(req.params.slug, status, req.admin);
      if (!article) return res.status(404).json({ message: "Article not found." });
      res.json(article);
    } catch (error) {
      logRouteError("PATCH /api/articles/:slug/status memory", error);
      res.status(error.statusCode || 500).json({ message: error.message || "Could not update article status." });
    }
    return;
  }

  try {
    const savedArticle = await withTransaction(async (connection) => {
      assertCanChangeArticleLifecycle(req.admin);
      const [existingRows] = await connection.query("SELECT id, status, is_featured, excerpt, body FROM news_articles WHERE slug = ? LIMIT 1 FOR UPDATE", [req.params.slug]);
      if (!existingRows.length) {
        throw createHttpError("Article not found.", 404);
      }

      if (status === "published" && (!String(existingRows[0].excerpt || "").trim() || !String(existingRows[0].body || "").trim())) {
        throw createHttpError("Published articles need an excerpt and body.");
      }

      await connection.query(
        `
        UPDATE news_articles
        SET status = ?,
            deleted_at = IF(? = 'archived', NOW(), NULL),
            is_featured = IF(? = 'published', is_featured, 0),
            featured_order = IF(? = 'published', featured_order, NULL),
            published_at = IF(? = 'published' AND published_at IS NULL, UTC_TIMESTAMP(), published_at),
            updated_by_admin_id = ?
        WHERE slug = ?
        `,
        [status, status, status, status, status, adminIdValue(req.admin), req.params.slug]
      );

      if (status !== "published" && existingRows[0].is_featured) {
        await normalizeDbFeaturedOrders(connection);
      }

      const action = status === "published" ? "published" : status === "archived" ? "archived" : "restored";
      await addDbAuditLog(existingRows[0].id, req.admin, action, { from: existingRows[0].status, to: status }, connection);

      const [rows] = await connection.query(
        articleSelectSql("a.slug = ?", "LIMIT 1"),
        [...articleTaxonomyParams(), req.params.slug]
      );

      return mapArticle(rows[0]);
    });

    res.json(savedArticle);
  } catch (error) {
    logRouteError("PATCH /api/articles/:slug/status", error);
    res.status(error.statusCode || 500).json({ message: error.message || "Could not update article status." });
  }
}

app.patch("/api/articles/:slug/status", sensitiveRateLimiter, requireAdmin, async (req, res) => {
  return changeArticleStatus(req, res, req.body.status);
});

app.patch("/api/articles/:slug/unpublish", sensitiveRateLimiter, requireAdmin, async (req, res) => {
  return changeArticleStatus(req, res, "draft");
});

app.patch("/api/articles/:slug/archive", sensitiveRateLimiter, requireAdmin, async (req, res) => {
  return changeArticleStatus(req, res, "archived");
});

app.patch("/api/articles/:slug/restore", sensitiveRateLimiter, requireAdmin, async (req, res) => {
  return changeArticleStatus(req, res, "draft");
});

app.delete("/api/articles/:slug", sensitiveRateLimiter, requireAdmin, async (req, res) => {
  if (usingMemoryStore) {
    try {
      if (!deleteMemoryArticle(req.params.slug, req.admin)) {
        return res.status(404).json({ message: "Article not found." });
      }

      res.json({ ok: true });
    } catch (error) {
      logRouteError("DELETE /api/articles/:slug memory", error);
      res.status(error.statusCode || 500).json({ message: error.message || "Could not delete article." });
    }
    return;
  }

  try {
    await withTransaction(async (connection) => {
      assertCanChangeArticleLifecycle(req.admin);
      const [existingRows] = await connection.query("SELECT id, is_featured FROM news_articles WHERE slug = ? LIMIT 1 FOR UPDATE", [req.params.slug]);
      if (existingRows.length === 0) {
        throw createHttpError("Article not found.", 404);
      }

      const [result] = await connection.query(
        "UPDATE news_articles SET status = 'archived', deleted_at = NOW(), is_featured = 0, featured_order = NULL, updated_by_admin_id = ? WHERE slug = ?",
        [adminIdValue(req.admin), req.params.slug]
      );

      if (result.affectedRows === 0) {
        throw createHttpError("Article not found.", 404);
      }

      if (existingRows[0]?.is_featured) {
        await normalizeDbFeaturedOrders(connection);
      }

      await addDbAuditLog(existingRows[0].id, req.admin, "deleted", { softDelete: true }, connection);
    });

    res.json({ ok: true });
  } catch (error) {
    logRouteError("DELETE /api/articles/:slug", error);
    res.status(error.statusCode || 500).json({ message: error.message || "Could not delete article." });
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({ message: "API route not found." });
});

app.use(express.static(publicPath));

app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    res.sendFile(path.join(publicPath, "index.html"));
    return;
  }

  next();
});

app.use((error, req, res, _next) => {
  logRouteError(`${req.method} ${req.path}`, error);
  if (res.headersSent) return;
  res.status(error.statusCode || 500).json({
    message: error.statusCode && error.statusCode < 500 ? error.message : "Server error",
  });
});

try {
  assertRequiredProductionEnv();
} catch (error) {
  logEvent("error", "Startup configuration invalid.", { message: error.message });
  process.exit(1);
}

initializeNews()
  .catch((error) => {
    if (isProduction()) {
      logEvent("error", "Database unavailable. Production server stopped.", { message: error.message, code: error.code });
      process.exit(1);
    }

    usingMemoryStore = true;
    initializeMemoryStore();
    logEvent("warn", "Database unavailable; starting with sample in-memory articles.", { message: error.message, code: error.code });
  })
  .then(() => {
    app.listen(PORT, () => {
      logEvent("info", "Tomujin Article running.", { url: `http://localhost:${PORT}` });
    });
  });
