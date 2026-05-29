// Code map:
// 1. Shared state, DOM handles, and formatting helpers.
// 2. API helpers, admin session helpers, and permissions.
// 3. Public/admin route mounting and dashboard bindings.
// 4. Category, article, carousel, and detail rendering.
// 5. Global event listeners and app startup.
const state = {
  categories: [],
  articles: [],
  activeCategory: "",
  activeMainSection: "",
  activeAuthor: "",
  activeContentType: "",
  editorPickOnly: false,
  sortMode: "newest",
  activePage: 1,
  query: "",
  view: "home",
  adminStatusFilter: "",
  adminAllArticles: [],
  adminImageUploading: false,
};

const app = document.querySelector("#app");
const homeTemplate = document.querySelector("#homeTemplate");
const adminTemplate = document.querySelector("#adminTemplate");
const loginTemplate = document.querySelector("#loginTemplate");
const categoryNav = document.querySelector("#categoryNav");
const headerSearchForm = document.querySelector("#headerSearchForm");
const headerSearchInput = document.querySelector("#headerSearchInput");
const themeToggle = document.querySelector("#themeToggle");
const mobileSearchToggle = document.querySelector("#mobileSearchToggle");
const mobileThemeToggle = document.querySelector("#mobileThemeToggle");
const mobileMenuToggle = document.querySelector("#mobileMenuToggle");
const homeButton = document.querySelector("#homeButton");
const brandLink = document.querySelector(".brand");
const backTop = document.querySelector("#backTop");
const adminNameStorageKey = "tomujinAdminName";
const adminTokenStorageKey = "tomujinAdminToken";
const adminProfileStorageKey = "tomujinAdminProfile";
const themeStorageKey = "tomujinTheme";
const fallbackImageUrl = "/images/stagknight.jpg";
const featuredLimit = 4;
const writingDropdownLabel = "Сурагчдын Бичвэр";
const directHeaderCategorySlugs = new Set(["nom", "zurvas", "podcast"]);
const homeCategoryAccentColors = ["#23c2bf", "#ffc800", "#5a2595", "#ff5b2e"];
const maxImageUploadBytes = 3 * 1024 * 1024;
const allowedImageExtensions = new Set(["avif", "gif", "jpeg", "jpg", "png", "webp"]);
const articlesPerPage = 9;

let articleGrid;
let articlePagination;
let archiveFilters;
let statusText;
let heroTrack;
let heroDots;
let heroPrev;
let heroNext;
let heroTimer;

state.admin = getStoredAdminProfile();
state.adminName = state.admin.name || window.sessionStorage.getItem(adminNameStorageKey) || "admin";
state.adminToken = window.sessionStorage.getItem(adminTokenStorageKey) || "";
state.isAdmin = Boolean(state.adminToken);
state.theme = window.localStorage.getItem(themeStorageKey) === "dark" ? "dark" : "light";

function applyTheme() {
  document.body.dataset.theme = state.theme;
  const isLight = state.theme === "light";
  if (themeToggle) {
    themeToggle.setAttribute("aria-pressed", String(isLight));
    themeToggle.setAttribute("aria-label", isLight ? "Switch to dark theme" : "Switch to light theme");
    themeToggle.title = isLight ? "Dark mode" : "Light mode";
  }
  if (mobileThemeToggle) {
    mobileThemeToggle.setAttribute("aria-pressed", String(isLight));
    mobileThemeToggle.setAttribute("aria-label", isLight ? "Switch to dark theme" : "Switch to light theme");
    mobileThemeToggle.title = isLight ? "Dark mode" : "Light mode";
  }
}

function setMobilePanel(panel, isOpen) {
  const searchOpen = panel === "search" ? isOpen : false;
  const menuOpen = panel === "menu" ? isOpen : false;
  document.body.classList.toggle("mobile-search-open", Boolean(searchOpen));
  document.body.classList.toggle("mobile-menu-open", Boolean(menuOpen));
  mobileSearchToggle?.setAttribute("aria-expanded", String(Boolean(searchOpen)));
  mobileMenuToggle?.setAttribute("aria-expanded", String(Boolean(menuOpen)));
}

function closeMobileHeaderPanels() {
  setMobilePanel("", false);
}

function toggleThemeMode() {
  state.theme = state.theme === "light" ? "dark" : "light";
  window.localStorage.setItem(themeStorageKey, state.theme);
  applyTheme();
}

function formatDate(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("mn-MN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatViews(value = 0) {
  const count = Number(value || 0);
  if (!Number.isFinite(count) || count <= 0) return "0 views";
  if (count === 1) return "1 view";
  if (count < 1000) return `${count} views`;
  return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k views`;
}

function isArticleFeatured(article = {}) {
  return Boolean(article.isFeatured ?? article.featured);
}

function articleCategoriesList(article = {}) {
  if (Array.isArray(article.categories) && article.categories.length) return article.categories;
  return article.category ? [article.category] : [];
}

function articleCategoryNames(article = {}) {
  return articleCategoriesList(article)
    .map((category) => {
      const liveCategory = state.categories.find((item) => item.slug === category?.slug);
      return liveCategory?.name || category?.name || category?.label || category?.slug;
    })
    .filter(Boolean)
    .join(" / ");
}

function articleCategorySlugs(article = {}) {
  if (Array.isArray(article.categorySlugs) && article.categorySlugs.length) return article.categorySlugs;
  return articleCategoriesList(article)
    .map((category) => category?.slug)
    .filter(Boolean);
}

function articleVisibleCategorySlugs(article = {}) {
  return [...new Set(articleCategorySlugs(article).map((slug) => String(slug || "").trim()).filter(Boolean))];
}

function articleContentType(article = {}) {
  return article.contentType || "Article";
}

function formatInputDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return offsetDate.toISOString().slice(0, 16);
}

function tagsText(article = {}) {
  return Array.isArray(article.tags) ? article.tags.join(", ") : String(article.tags || "");
}

function articleImageUrl(article = {}) {
  return article.imageUrl || fallbackImageUrl;
}

function normalizedText(value = "") {
  return String(value || "").trim().toLowerCase();
}

function publicCategoryLabel(slug = "") {
  const liveCategory = state.categories.find((category) => category.slug === slug);
  if (liveCategory?.name) return liveCategory.name;
  return slug;
}

function articleMatchesSlugs(article = {}, slugs = []) {
  const articleSlugs = articleVisibleCategorySlugs(article);
  return articleSlugs.some((slug) => slugs.includes(slug));
}

function articleMatchesContentTypes(article = {}, contentTypes = []) {
  const currentType = normalizedText(articleContentType(article));
  return contentTypes.map(normalizedText).includes(currentType);
}

function articleMatchesSection(article = {}, section = {}) {
  if (!section) return false;
  if (section.slug) return articleMatchesSlugs(article, categoryGroupSlugs(section));
  const slugs = [section.slug, ...(section.aliases || [])].filter(Boolean);
  if (slugs.length && articleMatchesSlugs(article, slugs)) return true;
  return articleMatchesContentTypes(article, section.contentTypes || []);
}

function sectionConfig(key = "") {
  return state.categories.find((category) => category.slug === key) || null;
}

function sortedCategories(categories = []) {
  return [...categories].sort((left, right) =>
    Number(left.sortOrder ?? left.sort_order ?? 0) - Number(right.sortOrder ?? right.sort_order ?? 0) ||
    String(left.name || "").localeCompare(String(right.name || ""))
  );
}

function publicCategoryGroups(categories = []) {
  const groups = new Map();

  sortedCategories(categories).forEach((category) => {
    const key = normalizedText(category.name || category.slug);
    if (!key) return;
    const existing = groups.get(key);
    if (!existing || Number(category.articleCount || 0) > Number(existing.articleCount || 0)) {
      groups.set(key, category);
    }
  });

  return sortedCategories([...groups.values()]);
}

function categoryGroupSlugs(category = {}) {
  const nameKey = normalizedText(category.name || category.slug);
  return state.categories
    .filter((item) => item.slug === category.slug || normalizedText(item.name || item.slug) === nameKey)
    .map((item) => item.slug)
    .filter(Boolean);
}

function headerCategories() {
  return publicCategoryGroups(state.categories.filter((category) => (
    category.visibleInHeader !== false &&
    (Number(category.articleCount || 0) > 0 || directHeaderCategorySlugs.has(category.slug))
  )));
}

function headerWritingCategories() {
  const categories = headerCategories();
  const directCategories = categories.filter((category) => directHeaderCategorySlugs.has(category.slug));
  const writingCategories = categories.filter((category) => !directHeaderCategorySlugs.has(category.slug));

  if (writingCategories.length && directCategories.length) return writingCategories;
  return categories.slice(0, Math.min(7, categories.length));
}

function headerDirectCategories() {
  const categories = headerCategories();
  const directCategories = categories.filter((category) => directHeaderCategorySlugs.has(category.slug));
  if (directCategories.length) return directCategories;
  return categories.slice(7, 10);
}

function homepageSectionCategories() {
  const visibleCategories = publicCategoryGroups(state.categories.filter((category) => category.visibleOnHomepage !== false));
  const parentIdsWithChildren = new Set(visibleCategories.map((category) => category.parentId).filter(Boolean));
  return visibleCategories
    .filter((category) => !parentIdsWithChildren.has(category.id))
    .sort((left, right) => {
      const leftIsPodcast = left.slug === "podcast" || normalizedText(left.name) === "подкаст";
      const rightIsPodcast = right.slug === "podcast" || normalizedText(right.name) === "подкаст";
      if (leftIsPodcast !== rightIsPodcast) return leftIsPodcast ? 1 : -1;
      return 0;
    });
}

function latestArticlesForSection(section = {}, limit = 5) {
  return state.articles.filter((article) => articleMatchesSection(article, section)).slice(0, limit);
}

function uniqueArticles(articles = []) {
  const seen = new Set();
  return articles.filter((article) => {
    const key = article.slug || article.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sectionArticles(section = {}, limit = 7) {
  return uniqueArticles(state.articles.filter((article) => articleMatchesSection(article, section))).slice(0, limit);
}

function articleMetaParts(article = {}, { includeAuthor = false, includeCategory = false } = {}) {
  const parts = [
    includeCategory ? articleCategoryNames(article) : "",
    includeAuthor && article.author ? article.author : "",
    formatDate(article.publishedAt) || "",
  ];
  return parts.filter(Boolean);
}

function renderMetaLine(article = {}, options = {}) {
  return articleMetaParts(article, options).map(escapeHtml).join(" / ");
}

function renderMetaChips(article = {}, options = {}) {
  return articleMetaParts(article, options)
    .map((part) => `<span>${escapeHtml(part)}</span>`)
    .join("");
}

function heroCategoryName(article = {}) {
  return articleCategoriesList(article)
    .map((category) => category?.name)
    .find((name) => name && name.toLowerCase() !== "онцлох");
}

function renderHeroLabel(article = {}) {
  return [article.author, heroCategoryName(article) || articleCategoryNames(article)]
    .filter(Boolean)
    .map(escapeHtml)
    .join(" / ");
}

function getImageExtension(value = "") {
  const cleanValue = String(value || "").split("?")[0].split("#")[0];
  const match = cleanValue.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : "";
}

function isProbablyValidImageUrl(value = "") {
  const imageUrl = String(value || "").trim();
  if (!imageUrl) return true;

  const extension = getImageExtension(imageUrl);
  if (!allowedImageExtensions.has(extension)) return false;
  if (imageUrl.startsWith("/images/")) return true;

  try {
    const parsed = new URL(imageUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(new Error("Could not read image file.")));
    reader.readAsDataURL(file);
  });
}

async function uploadAdminImage(file) {
  if (!file) return null;

  if (!file.type.startsWith("image/")) {
    throw new Error("Upload an image file.");
  }

  if (file.size > maxImageUploadBytes) {
    throw new Error("Image must be 3 MB or smaller.");
  }

  const data = await readFileAsDataUrl(file);
  return fetchJson("/api/admin/images", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      data,
    }),
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getCheckedValues(container, name) {
  if (!container) return [];
  return [...container.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}

function setChoiceValues(container, name, values = []) {
  if (!container) return;
  const selected = new Set(values.map((value) => String(value)));
  container.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
    input.checked = selected.has(input.value);
  });
}

function renderChoiceGroup(container, name, items, selectedValues = []) {
  if (!container) return;
  const selected = new Set(selectedValues.map((value) => String(value)));
  container.innerHTML = items
    .map((item) => {
      const value = String(item.value ?? item.slug ?? item);
      const label = String(item.label ?? item.name ?? item);
      const checked = selected.has(value) ? "checked" : "";

      return `
        <label class="choice-option">
          <input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${checked} />
          <span>${escapeHtml(label)}</span>
        </label>
      `;
    })
    .join("");
}

function renderTaxonomyControls(categoryContainer, yearContainer, article = {}) {
  const selectedCategories = articleVisibleCategorySlugs(article);
  renderChoiceGroup(
    categoryContainer,
    "categorySlugs",
    state.categories.map((category) => ({ value: category.slug, label: category.name })),
    selectedCategories.length ? selectedCategories : [state.categories[0]?.slug].filter(Boolean)
  );
}

function addTaxonomyPayload(payload, form) {
  const categorySlugSet = new Set(state.categories.map((category) => category.slug));
  payload.categorySlugs = getCheckedValues(form, "categorySlugs").filter((slug) => categorySlugSet.has(slug));
  delete payload.graduationYears;
  delete payload.graduationYear;
  delete payload.categorySlug;
  return payload;
}

function renderParagraphs(value = "") {
  return String(value)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br />")}</p>`)
    .join("");
}

async function fetchJson(url, options) {
  let response;

  try {
    response = await fetch(url, options);
  } catch {
    throw new Error("Cannot connect to backend");
  }

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json().catch(() => ({})) : {};

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(data.message || "Wrong password");
    }

    if (response.status >= 500) {
      throw new Error(data.message || "Server error");
    }

    throw new Error(data.message || "Request failed");
  }

  return data;
}

function collectionItems(data) {
  return Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
}

function adminLoginErrorMessage(error = {}) {
  const message = String(error.message || "");
  if (!message || message === "Failed to fetch") return "Cannot connect to backend";
  if (message === "Cannot connect to backend") return message;
  if (message.toLowerCase().includes("wrong password") || message.toLowerCase().includes("invalid email")) return "Wrong password";
  if (message.toLowerCase().includes("server") || message.toLowerCase().includes("configured")) return "Server error";
  return message;
}

function bindPasswordToggles(root = document) {
  root.querySelectorAll("[data-password-toggle]").forEach((button) => {
    const field = button.closest(".password-field");
    const input = field?.querySelector("input");
    if (!field || !input || button.dataset.bound === "true") return;

    const syncToggle = () => {
      const isVisible = input.type === "text";
      field.classList.toggle("is-visible", isVisible);
      button.setAttribute("aria-pressed", String(isVisible));
      button.setAttribute("aria-label", isVisible ? "Hide password" : "Show password");
      button.title = isVisible ? "Hide password" : "Show password";
    };

    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      input.type = input.type === "password" ? "text" : "password";
      syncToggle();
      input.focus();
    });
    syncToggle();
  });
}

function setStatus(message = "") {
  if (statusText) {
    statusText.textContent = message;
  }
}

function updateAdminEntryLabel() {
  const label = state.isAdmin ? "Open admin dashboard" : "Admin login";
  if (brandLink) {
    brandLink.title = label;
    brandLink.setAttribute("aria-label", label);
  }
}

function adminHeaders() {
  return {
    Authorization: `Bearer ${state.adminToken}`,
    "x-admin-token": state.adminToken,
  };
}

function normalizeAdminProfile(admin = {}) {
  if (typeof admin === "string") {
    return { id: null, name: admin || "admin", email: "", role: "" };
  }

  return {
    id: admin.id || null,
    name: admin.name || admin.email || "admin",
    email: admin.email || "",
    role: admin.role || admin.adminRole || "",
  };
}

function getStoredAdminProfile() {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(adminProfileStorageKey) || "null");
    if (stored && typeof stored === "object") return normalizeAdminProfile(stored);
  } catch {
    window.sessionStorage.removeItem(adminProfileStorageKey);
  }

  return normalizeAdminProfile(window.sessionStorage.getItem(adminNameStorageKey) || "admin");
}

function setAdminProfile(admin = {}) {
  const profile = normalizeAdminProfile(admin);
  state.admin = profile;
  state.adminName = profile.name;
  window.sessionStorage.setItem(adminNameStorageKey, profile.name);
  window.sessionStorage.setItem(adminProfileStorageKey, JSON.stringify(profile));
  return profile;
}

function currentAdminRole() {
  return String(state.admin?.role || "").trim().toLowerCase();
}

function isOwnerAdmin() {
  return currentAdminRole() === "owner";
}

function isEditorAdmin() {
  return currentAdminRole() === "editor";
}

function isWriterAdmin() {
  return currentAdminRole() === "writer";
}

function canManageAdmins() {
  return isOwnerAdmin();
}

function canManageCategories() {
  return isOwnerAdmin() || isEditorAdmin();
}

function canPublishArchiveDelete() {
  return isOwnerAdmin() || isEditorAdmin();
}

function canFeatureArticles() {
  return canPublishArchiveDelete();
}

function canUseDangerousAdminActions() {
  return canPublishArchiveDelete();
}

function canEditAdminArticle(article = {}) {
  if (isOwnerAdmin() || isEditorAdmin()) return true;
  return isWriterAdmin() && article.status === "draft" && Number(article.createdByAdminId || 0) === Number(state.admin?.id || 0);
}

function slugifyText(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function plainTextFromContent(value = "") {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = String(value || "").replace(/<\/?(p|br|div|li|h[1-6]|blockquote)[^>]*>/gi, " ");
  return (wrapper.textContent || wrapper.innerText || String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function trimToSentenceBoundary(value = "", maxLength = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength).trim();
  const boundary = Math.max(slice.lastIndexOf("."), slice.lastIndexOf("!"), slice.lastIndexOf("?"));
  if (boundary >= 60) return slice.slice(0, boundary + 1).trim();
  return `${slice.replace(/[\s,;:.-]+$/, "")}...`;
}

function excerptFromBody(value = "", maxLength = 180) {
  const text = plainTextFromContent(value);
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  const firstSentences = sentences.slice(0, 2).join(" ").trim();
  return trimToSentenceBoundary(firstSentences || text, maxLength);
}

function metaDescriptionFromText(value = "", fallback = "") {
  return trimToSentenceBoundary(plainTextFromContent(value) || fallback, 155);
}

function setAdminSession(admin, token) {
  setAdminProfile(admin);
  state.adminToken = token;
  state.isAdmin = true;
  window.sessionStorage.setItem(adminTokenStorageKey, token);
  updateAdminEntryLabel();
}

function adminLogout() {
  state.admin = normalizeAdminProfile("");
  state.adminName = "";
  state.adminToken = "";
  state.isAdmin = false;
  window.sessionStorage.removeItem(adminNameStorageKey);
  window.sessionStorage.removeItem(adminTokenStorageKey);
  window.sessionStorage.removeItem(adminProfileStorageKey);
  updateAdminEntryLabel();

  const slug = getArticleSlugFromPath();
  if (slug && state.view === "article") {
    openArticle(slug, { pushUrl: false });
  }
}

function isAdminPath() {
  return window.location.pathname.replace(/\/+$/, "") === "/admin";
}

function isAdminDashboardPath() {
  return window.location.pathname.replace(/\/+$/, "") === "/admin/dashboard";
}

function ensureMetaTag(selector, attributes) {
  let tag = document.head.querySelector(selector);
  if (!tag) {
    tag = document.createElement("meta");
    Object.entries(attributes.identity).forEach(([key, value]) => tag.setAttribute(key, value));
    document.head.appendChild(tag);
  }

  Object.entries(attributes.values).forEach(([key, value]) => tag.setAttribute(key, value));
}

function setPageMeta({ title = "Tom/Art", description = "Tomujin Article", image = fallbackImageUrl, url = window.location.href } = {}) {
  document.title = title;
  ensureMetaTag('meta[name="description"]', {
    identity: { name: "description" },
    values: { content: description },
  });
  ensureMetaTag('meta[property="og:title"]', {
    identity: { property: "og:title" },
    values: { content: title },
  });
  ensureMetaTag('meta[property="og:description"]', {
    identity: { property: "og:description" },
    values: { content: description },
  });
  ensureMetaTag('meta[property="og:image"]', {
    identity: { property: "og:image" },
    values: { content: new URL(image, window.location.origin).href },
  });
  ensureMetaTag('meta[property="og:url"]', {
    identity: { property: "og:url" },
    values: { content: url },
  });
}

function goHome({ pushUrl = true } = {}) {
  state.activeCategory = "";
  state.activeMainSection = "";
  state.activeAuthor = "";
  state.activeContentType = "";
  state.editorPickOnly = false;
  state.activePage = 1;
  state.query = "";
  headerSearchInput.value = "";
  syncCategoryArchiveMode();

  if (pushUrl && window.location.pathname !== "/") {
    history.pushState({ view: "home" }, "", "/");
  }

  mountHome();
  renderCategories();
  loadArticles();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function articleUrl(slug) {
  return `/article/${encodeURIComponent(slug)}`;
}

function getArticleSlugFromPath() {
  const match = window.location.pathname.match(/^\/article\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : "";
}

function mountHome() {
  state.view = "home";
  document.body.dataset.view = "home";
  syncCategoryArchiveMode();
  window.clearInterval(heroTimer);
  setPageMeta();
  app.innerHTML = homeTemplate.innerHTML;

  articleGrid = document.querySelector("#articleGrid");
  articlePagination = document.querySelector("#articlePagination");
  archiveFilters = document.querySelector("#archiveFilters");
  statusText = document.querySelector("#status");
  heroTrack = document.querySelector("#heroTrack");
  heroDots = document.querySelector("#heroDots");
  heroPrev = document.querySelector("#heroPrev");
  heroNext = document.querySelector("#heroNext");

  renderArchiveFilters();
  bindContactScrollLinks();
  renderArticles();
  bindHeroCarousel();
  loadHeroArticles();
}

function openAdminLogin({ pushUrl = false } = {}) {
  state.view = "admin";
  document.body.dataset.view = "admin";
  app.innerHTML = loginTemplate.innerHTML;

  if (pushUrl && !isAdminPath()) {
    history.pushState({ view: "admin" }, "", "/admin");
  }

  const loginForm = document.querySelector("#adminLoginForm");
  const emailInput = document.querySelector("#adminEmail");
  const passwordInput = document.querySelector("#adminPassword");
  const loginStatus = document.querySelector("#adminLoginStatus");
  const submitButton = document.querySelector("#adminLoginSubmit");
  const backButton = document.querySelector("#backFromLogin");
  const defaultSubmitText = submitButton.textContent;

  bindPasswordToggles(app);
  window.setTimeout(() => emailInput.focus(), 80);

  function setLoginStatus(message = "", tone = "") {
    loginStatus.textContent = message;
    loginStatus.dataset.tone = tone;
  }

  backButton.addEventListener("click", () => {
    history.pushState({ view: "home" }, "", "/");
    mountHome();
    renderCategories();
    loadArticles();
  });

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      setLoginStatus("Enter email and password.", "error");
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Signing in...";
    setLoginStatus("Checking login...");

    try {
      const result = await fetchJson("/api/admin/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });

      setAdminSession(result.admin || "admin", result.token);
      setLoginStatus("Signed in.", "success");
      await openAdminDashboard({ pushUrl: true });
    } catch (error) {
      setLoginStatus(adminLoginErrorMessage(error), "error");
      passwordInput.select();
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = defaultSubmitText;
    }
  });
}
async function openAdminDashboard({ pushUrl = false } = {}) {
  if (!state.isAdmin) {
    openAdminLogin({ pushUrl: true });
    return;
  }

  try {
    const session = await fetchJson("/api/admin/session", { headers: adminHeaders() });
    if (session.admin) setAdminProfile(session.admin);
  } catch {
    adminLogout();
    openAdminLogin({ pushUrl: true });
    return;
  }

  state.view = "admin-dashboard";
  document.body.dataset.view = "admin-dashboard";
  window.clearInterval(heroTimer);
  if (!state.categories.length) {
    await loadCategories();
  }
  app.innerHTML = adminTemplate.innerHTML;

  if (pushUrl && !isAdminDashboardPath()) {
    history.pushState({ view: "admin-dashboard" }, "", "/admin/dashboard");
  }

  const adminForm = document.querySelector("#adminArticleForm");
  const adminCategoryList = document.querySelector("#adminArticleCategories");
  const adminYearList = null;
  const formStatusText = document.querySelector("#adminFormStatus");
  const listStatus = document.querySelector("#adminListStatus");
  const articleList = document.querySelector("#adminArticleList");
  const articleSearchInput = document.querySelector("#adminArticleSearch");
  const featuredStatus = document.querySelector("#adminFeaturedStatus");
  const featuredList = document.querySelector("#adminFeaturedList");
  const featuredCount = document.querySelector("#adminFeaturedCount");
  const overviewTotalArticles = document.querySelector("#adminTotalArticles");
  const overviewTotalCategories = document.querySelector("#adminTotalCategories");
  const overviewTotalSubcategories = document.querySelector("#adminTotalSubcategories");
  const overviewTotalRecommended = document.querySelector("#adminTotalRecommended");
  const draftButton = document.querySelector("#adminSaveDraft");
  const publishButton = document.querySelector("#adminPublishArticle");
  const archiveButton = document.querySelector("#adminArchiveArticle");
  const restoreButton = document.querySelector("#adminRestoreArticle");
  const newButton = document.querySelector("#newArticleButton");
  const imageInput = adminForm.querySelector('[name="imageUrl"]');
  const imageFileInput = document.querySelector("#adminImageFile");
  const imageStatus = document.querySelector("#adminImageStatus");
  const imagePreview = document.querySelector("#adminImagePreview");
  const heroPreview = document.querySelector("#adminHeroPreview");
  const statusFilter = document.querySelector("#adminStatusFilter");
  const adminIdentity = document.querySelector("#adminIdentity");
  const ownerPanel = document.querySelector("#adminOwnerPanel");
  const adminAdminForm = document.querySelector("#adminAdminForm");
  const adminAdminStatus = document.querySelector("#adminAdminStatus");
  const adminAdminList = document.querySelector("#adminAdminList");
  const adminCategoryPanel = document.querySelector("#adminCategoryPanel");
  const adminCategoryForm = document.querySelector("#adminCategoryForm");
  const adminCategoryStatus = document.querySelector("#adminCategoryStatus");
  const adminCategoryListPanel = document.querySelector("#adminCategoryList");
  const adminCategoryOriginalSlug = adminCategoryForm?.querySelector('[name="originalSlug"]');
  const adminCategoryNameInput = adminCategoryForm?.querySelector('[name="name"]');
  const adminCategorySlugInput = adminCategoryForm?.querySelector('[name="slug"]');
  const adminCategorySortInput = adminCategoryForm?.querySelector('[name="sortOrder"]');
  const adminCategoryHeaderInput = adminCategoryForm?.querySelector('[name="visibleInHeader"]');
  const adminCategoryHomepageInput = adminCategoryForm?.querySelector('[name="visibleOnHomepage"]');
  const adminTabs = document.querySelector("#adminTabs");
  const adminPanels = [...document.querySelectorAll("[data-admin-panel]")];

  bindPasswordToggles(app);
  setPageMeta({ title: "Admin Dashboard / Tomujin Article", description: "Tomujin Article admin dashboard" });
  renderTaxonomyControls(adminCategoryList, adminYearList);

  function setPanelStatus(element, message = "", tone = "") {
    if (!element) return;
    element.textContent = message;
    element.dataset.tone = tone;
  }

  function setAdminTab(activeTab = "articles") {
    adminTabs?.querySelectorAll("[data-admin-tab]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.adminTab === activeTab);
      button.setAttribute("aria-selected", String(button.dataset.adminTab === activeTab));
    });
    adminPanels.forEach((panel) => {
      panel.classList.toggle("admin-panel-hidden", panel.dataset.adminPanel !== activeTab);
    });
  }

  adminTabs?.querySelectorAll("[data-admin-tab]").forEach((button) => {
    button.addEventListener("click", () => setAdminTab(button.dataset.adminTab || "articles"));
  });

  function renderAdminAccount() {
    const profile = normalizeAdminProfile(state.admin || {});
    const role = currentAdminRole();

    if (adminIdentity) {
      adminIdentity.innerHTML = `
        <span>${escapeHtml(profile.name)}</span>
        ${profile.email ? `<small>${escapeHtml(profile.email)}</small>` : ""}
        ${role ? `<strong>${escapeHtml(role)}</strong>` : ""}
      `;
    }

    ownerPanel?.classList.toggle("is-hidden", !canManageAdmins());
    adminCategoryPanel?.classList.toggle("is-hidden", !canManageCategories());
  }

  renderAdminAccount();

  function setAdminAdminStatus(message = "", tone = "") {
    setPanelStatus(adminAdminStatus, message, tone);
  }

  function renderAdminUsers(admins = []) {
    if (!adminAdminList) return;
    adminAdminList.innerHTML = admins.length
      ? admins
          .map(
            (admin) => `
              <article class="admin-admin-row" data-admin-id="${escapeHtml(admin.id)}">
                <div>
                  <strong>${escapeHtml(admin.name)}</strong>
                  <small>${escapeHtml(admin.email)}</small>
                </div>
                <select data-admin-action="role">
                  ${["owner", "editor", "writer"]
                    .map((role) => `<option value="${role}" ${admin.role === role ? "selected" : ""}>${role}</option>`)
                    .join("")}
                </select>
                <button class="delete-link" type="button" data-admin-action="remove">Remove</button>
              </article>
            `
          )
          .join("")
      : "No admins found.";

    adminAdminList.querySelectorAll("[data-admin-id]").forEach((row) => {
      const adminId = row.dataset.adminId;
      const admin = admins.find((item) => String(item.id) === String(adminId));
      row.querySelector('[data-admin-action="role"]').addEventListener("change", async (event) => {
        try {
          await fetchJson(`/api/admin/admins/${encodeURIComponent(adminId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...adminHeaders() },
            body: JSON.stringify({ name: admin.name, email: admin.email, role: event.target.value }),
          });
          setAdminAdminStatus("Admin role updated.", "success");
          await loadAdminUsers();
        } catch (error) {
          setAdminAdminStatus(error.message || "Could not update admin.", "error");
          event.target.value = admin.role;
        }
      });

      row.querySelector('[data-admin-action="remove"]').addEventListener("click", async () => {
        if (!window.confirm(`Remove admin ${admin.email}?`)) return;
        try {
          await fetchJson(`/api/admin/admins/${encodeURIComponent(adminId)}`, {
            method: "DELETE",
            headers: adminHeaders(),
          });
          setAdminAdminStatus("Admin removed.", "success");
          await loadAdminUsers();
        } catch (error) {
          setAdminAdminStatus(error.message || "Could not remove admin.", "error");
        }
      });
    });
  }

  async function loadAdminUsers() {
    if (!canManageAdmins() || !adminAdminList) return;
    setAdminAdminStatus("Loading admins...");
    try {
      renderAdminUsers(await fetchJson("/api/admin/admins", { headers: adminHeaders() }));
      setAdminAdminStatus();
    } catch (error) {
      setAdminAdminStatus(error.message || "Could not load admins.", "error");
    }
  }

  function setAdminCategoryStatus(message = "", tone = "") {
    setPanelStatus(adminCategoryStatus, message, tone);
  }

  function renderAdminCategories() {
    if (!adminCategoryListPanel) return;

    adminCategoryListPanel.innerHTML = state.categories.length
      ? state.categories
          .map(
            (category) => `
              <article class="admin-category-row" data-category-slug="${escapeHtml(category.slug)}">
                <div class="admin-category-copy">
                  <strong>${escapeHtml(category.name)}</strong>
                  <small>${escapeHtml(category.slug)}</small>
                </div>
                <div class="admin-category-metrics">
                  <span><strong>${Number(category.articleCount || 0)}</strong> articles</span>
                  <span><strong>${Number(category.subcategoryCount || 0)}</strong> subcategories</span>
                  <span>${category.visibleInHeader === false ? "Hidden header" : "Header"}</span>
                  <span>${category.visibleOnHomepage === false ? "Hidden homepage" : "Homepage"}</span>
                </div>
                <div class="admin-category-actions">
                  <button class="back-link" type="button" data-category-action="edit">Edit</button>
                  <button class="auth-secondary" type="button" data-category-action="delete">Delete</button>
                </div>
              </article>
            `
          )
          .join("")
      : "No categories found.";

    adminCategoryListPanel.querySelectorAll("[data-category-slug]").forEach((row) => {
      const category = state.categories.find((item) => item.slug === row.dataset.categorySlug);
      row.querySelector('[data-category-action="edit"]')?.addEventListener("click", () => {
        if (!category || !adminCategoryForm) return;
        adminCategoryOriginalSlug.value = category.slug;
        adminCategoryNameInput.value = category.name;
        adminCategorySlugInput.value = category.slug;
        if (adminCategorySortInput) adminCategorySortInput.value = Number(category.sortOrder || 0);
        if (adminCategoryHeaderInput) adminCategoryHeaderInput.checked = category.visibleInHeader !== false;
        if (adminCategoryHomepageInput) adminCategoryHomepageInput.checked = category.visibleOnHomepage !== false;
        adminCategorySlugInput.dataset.touched = "true";
        setAdminCategoryStatus(`Editing category: ${category.name}`);
        adminCategoryNameInput.focus();
      });
      row.querySelector('[data-category-action="delete"]')?.addEventListener("click", async () => {
        if (!category || !canManageCategories()) return;
        if (!window.confirm(`Delete category "${category.name}"? Articles must be moved first.`)) return;
        setAdminCategoryStatus("Deleting category...");
        try {
          await fetchJson(`/api/admin/categories/${encodeURIComponent(category.slug)}`, {
            method: "DELETE",
            headers: adminHeaders(),
          });
          setAdminCategoryStatus("Category deleted.", "success");
          await refreshAdminCategories();
          await loadAdminArticles();
          await loadHeroArticles();
        } catch (error) {
          setAdminCategoryStatus(error.message || "Could not delete category.", "error");
        }
      });
    });
    renderAdminOverview();
  }

  function renderAdminOverview() {
    const articles = state.adminAllArticles?.length ? state.adminAllArticles : state.adminArticles || [];
    const recommendedCount = getFeaturedArticles().length;
    if (overviewTotalArticles) overviewTotalArticles.textContent = String(articles.length);
    if (overviewTotalCategories) overviewTotalCategories.textContent = String(state.categories.length);
    if (overviewTotalSubcategories) overviewTotalSubcategories.textContent = String(state.categories.filter((category) => category.parentId).length);
    if (overviewTotalRecommended) overviewTotalRecommended.textContent = String(recommendedCount);
  }

  async function refreshAdminCategories() {
    await loadCategories();
    renderTaxonomyControls(adminCategoryList, adminYearList);
    renderAdminCategories();
  }

  function getFeaturedArticles() {
    const seen = new Set();
    return (state.adminAllArticles?.length ? state.adminAllArticles : state.adminArticles || [])
      .filter((article) => {
        if (!isArticleFeatured(article) || seen.has(article.slug)) return false;
        seen.add(article.slug);
        return true;
      })
      .sort((left, right) => (left.featuredOrder || 9999) - (right.featuredOrder || 9999));
  }

  function canFeatureArticle(slug = "") {
    return canFeatureArticles() && (getFeaturedArticles().some((article) => article.slug === slug) || getFeaturedArticles().length < featuredLimit);
  }

  function setFormStatus(message = "", tone = "") {
    setPanelStatus(formStatusText, message, tone);
  }

  function setListStatus(message = "", tone = "") {
    setPanelStatus(listStatus, message, tone);
  }

  function setFeaturedStatus(message = "", tone = "") {
    setPanelStatus(featuredStatus, message, tone);
  }

  function setFeaturedWarning(message = "") {
    setFeaturedStatus(message, message ? "error" : "");
    if (message) setFormStatus(message, "error");
  }

  function selectedAdminCategory() {
    const selectedSlug = getCheckedValues(adminForm, "categorySlugs")[0] || state.categories[0]?.slug || "";
    const category = state.categories.find((item) => item.slug === selectedSlug);
    return category
      ? { slug: category.slug, name: category.name }
      : { slug: "", name: "Category" };
  }

  function selectedAdminCategories() {
    const selectedSlugs = getCheckedValues(adminForm, "categorySlugs");
    return selectedSlugs
      .map((slug) => state.categories.find((category) => category.slug === slug))
      .filter(Boolean)
      .map((category) => ({ slug: category.slug, name: category.name }));
  }

  function adminField(name = "") {
    return adminForm.elements[name];
  }

  function fieldWasEdited(name = "") {
    return adminField(name)?.dataset.userEdited === "true";
  }

  function markFieldEdited(name = "") {
    const field = adminField(name);
    if (!field) return;
    field.dataset.userEdited = "true";
    field.dataset.touched = "true";
  }

  function clearGeneratedFieldState() {
    ["slug", "excerpt", "metaTitle", "metaDescription"].forEach((name) => {
      const field = adminField(name);
      if (!field) return;
      delete field.dataset.userEdited;
      delete field.dataset.touched;
    });
  }

  function setAutoField(name = "", value = "") {
    const field = adminField(name);
    if (!field || fieldWasEdited(name)) return;
    field.value = value;
  }

  function defaultAdminAuthorName() {
    const profile = normalizeAdminProfile(state.admin || {});
    return profile.name || profile.email || state.adminName || "admin";
  }

  function applyDefaultAuthor() {
    if (!adminForm.author.value.trim()) {
      adminForm.author.value = defaultAdminAuthorName();
    }
  }

  function applyTitleAutofill() {
    const title = adminForm.title.value.trim();
    setAutoField("slug", slugifyText(title));
    setAutoField("metaTitle", title);
  }

  function applyBodyAutofill() {
    const body = adminForm.body.value;
    const excerpt = excerptFromBody(body);
    setAutoField("excerpt", excerpt);
    setAutoField("metaDescription", metaDescriptionFromText(excerpt, body));
  }

  function ensureGeneratedPublishFields() {
    applyDefaultAuthor();
    applyTitleAutofill();
    applyBodyAutofill();
  }

  function markLoadedGeneratedFieldState(article = {}) {
    [
      ["slug", article.slug],
      ["excerpt", article.excerpt],
      ["metaTitle", article.metaTitle],
      ["metaDescription", article.metaDescription],
    ].forEach(([name, value]) => {
      const field = adminField(name);
      if (!field) return;
      if (String(value || "").trim()) {
        field.dataset.userEdited = "true";
        field.dataset.touched = "true";
      } else {
        delete field.dataset.userEdited;
        delete field.dataset.touched;
      }
    });
  }

  function previewArticleFromForm() {
    const slug = adminForm.originalSlug.value || adminForm.slug.value;
    const existing = (state.adminArticles || []).find((article) => article.slug === slug);
    const categories = selectedAdminCategories();
    const category = categories[0] || selectedAdminCategory();
    return {
      title: adminForm.title.value.trim() || "Нийтлэлийн гарчиг",
      excerpt: adminForm.excerpt.value.trim() || "Товч тайлбар энд харагдана.",
      author: adminForm.author.value.trim(),
      imageUrl: imageInput.value.trim() || fallbackImageUrl,
      status: existing?.status || "draft",
      metaTitle: adminForm.metaTitle.value.trim(),
      metaDescription: adminForm.metaDescription.value.trim(),
      publishedAt: existing?.publishedAt || new Date().toISOString(),
      viewCount: existing?.viewCount || 0,
      category,
      categories: categories.length ? categories : [category].filter((item) => item.slug),
      categorySlugs: categories.map((item) => item.slug),
    };
  }

  function renderAdminHeroPreview() {
    const article = previewArticleFromForm();
    const imageUrl = articleImageUrl(article);
    const urlIsValid = isProbablyValidImageUrl(imageInput.value);

    if (imageStatus && imageInput.value.trim() && !urlIsValid) {
      setPanelStatus(imageStatus, "Upload a jpg, png, webp, avif, or gif image.", "error");
    } else if (imageStatus && !imageFileInput?.files?.length) {
      setPanelStatus(imageStatus);
    }

    heroPreview.innerHTML = `
      <span class="admin-preview-title">Hero preview</span>
      <div class="admin-hero-card">
        <img src="${escapeHtml(imageUrl)}" alt="" />
        <div class="admin-hero-copy">
          <span class="eyebrow hero-meta">${renderMetaChips(article, { includeAuthor: true, includeViews: false })}</span>
          <strong>${escapeHtml(article.title)}</strong>
          <p>${escapeHtml(article.excerpt)}</p>
          <em>Унших</em>
        </div>
      </div>
    `;

    heroPreview.querySelector("img").addEventListener("error", (event) => {
      event.currentTarget.src = fallbackImageUrl;
    });
    renderAdminImagePreview(imageUrl);
  }

  function renderAdminImagePreview(imageUrl) {
    if (!imagePreview) return;
    const previewUrl = imageUrl || imageInput.value.trim() || fallbackImageUrl;
    imagePreview.innerHTML = `
      <span>Image preview</span>
      <img src="${escapeHtml(previewUrl)}" alt="" />
    `;
    imagePreview.querySelector("img").addEventListener("error", (event) => {
      event.currentTarget.src = fallbackImageUrl;
    });
  }

  function updateEditorActions(article = null) {
    if (state.adminImageUploading) {
      [draftButton, publishButton, archiveButton, restoreButton, newButton].filter(Boolean).forEach((button) => {
        button.disabled = true;
      });
      adminForm.featured.disabled = true;
      adminForm.featuredOrder.disabled = true;
      return;
    }

    const roleCanPublish = canPublishArchiveDelete();
    const isEditing = Boolean(adminForm.originalSlug.value);
    const status = article?.status || "draft";
    const canEdit = !article || canEditAdminArticle(article);

    draftButton.disabled = !canEdit;
    publishButton.disabled = !canEdit || !roleCanPublish;
    archiveButton.disabled = !isEditing || !roleCanPublish || status === "archived";
    restoreButton.disabled = !isEditing || !roleCanPublish || status !== "archived";
    newButton.disabled = false;
    adminForm.featured.disabled = !canFeatureArticles() || status !== "published";
    adminForm.featuredOrder.disabled = adminForm.featured.disabled || !adminForm.featured.checked;
  }

  function resetAdminForm() {
    adminForm.reset();
    adminForm.originalSlug.value = "";
    adminForm.slug.value = "";
    clearGeneratedFieldState();
    applyDefaultAuthor();
    renderTaxonomyControls(adminCategoryList, adminYearList);
    setFormStatus();
    setPanelStatus(imageStatus);
    renderAdminHeroPreview();
    updateEditorActions();
  }

  function clearAdminForm() {
    resetAdminForm();
    setFormStatus("Ready for a new article.", "success");
    adminForm.title.focus();
  }

  function fillAdminForm(article) {
    adminForm.originalSlug.value = article.slug;
    adminForm.slug.value = article.slug;
    adminForm.title.value = article.title;
    adminForm.author.value = article.author || defaultAdminAuthorName();
    renderTaxonomyControls(adminCategoryList, adminYearList, article);
    adminForm.imageUrl.value = article.imageUrl || "";
    adminForm.featured.checked = isArticleFeatured(article);
    adminForm.featuredOrder.value = article.featuredOrder || "";
    adminForm.excerpt.value = article.excerpt;
    adminForm.metaTitle.value = article.metaTitle || "";
    adminForm.metaDescription.value = article.metaDescription || "";
    adminForm.body.value = article.body;
    markLoadedGeneratedFieldState(article);
    setFormStatus(`Editing ${article.status || "draft"} article: ${article.title}`);
    setPanelStatus(imageStatus);
    renderAdminHeroPreview();
    updateEditorActions(article);
    adminForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function patchArticleFeatured(slug, isFeatured, featuredOrder = "") {
    await fetchJson(`/api/articles/${slug}/featured`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({
        isFeatured,
        featuredOrder,
      }),
    });
  }

  async function updateArticleFeatured(slug, isFeatured, featuredOrder = "") {
    if (isFeatured && !canFeatureArticle(slug)) {
      setFeaturedWarning(`Онцлох нийтлэл хамгийн ихдээ ${featuredLimit} байна. Эхлээд нэгийг нь хасна уу.`);
      return false;
    }

    try {
      await patchArticleFeatured(slug, isFeatured, featuredOrder);
      await loadAdminArticles();
      setFeaturedStatus(isFeatured ? "Featured posts updated." : "Removed from featured.", "success");
      setFormStatus(isFeatured ? "Featured setting saved." : "Removed from featured.", "success");
      return true;
    } catch (error) {
      setFeaturedWarning(error.message || "Онцлох төлөвийг шинэчилж чадсангүй.");
      return false;
    }
  }

  async function moveFeaturedArticle(slug, direction) {
    const featuredArticles = getFeaturedArticles();
    const currentIndex = featuredArticles.findIndex((article) => article.slug === slug);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= featuredArticles.length) return;

    const current = featuredArticles[currentIndex];
    const next = featuredArticles[nextIndex];
    const currentOrder = current.featuredOrder || currentIndex + 1;
    const nextOrder = next.featuredOrder || nextIndex + 1;

    try {
      await patchArticleFeatured(current.slug, true, nextOrder);
      await patchArticleFeatured(next.slug, true, currentOrder);
      await loadAdminArticles();
      setFeaturedStatus("Featured order updated.", "success");
    } catch (error) {
      setFeaturedWarning(error.message || "Дарааллыг шинэчилж чадсангүй.");
    }
  }

  function renderAdminFeatured() {
    if (!featuredList || !featuredStatus || !featuredCount) return;

    const featuredArticles = getFeaturedArticles();
    const overLimit = featuredArticles.length > featuredLimit;

    featuredCount.textContent = `${featuredArticles.length} / ${featuredLimit}`;
    setFeaturedStatus(overLimit
      ? `Featured posts exceed ${featuredLimit}. Remove one first.`
      : featuredArticles.length
        ? "Shown in the hero slider by this order."
        : "No featured posts selected.",
      overLimit ? "error" : ""
    );

    featuredList.innerHTML = featuredArticles
      .map(
        (article, index) => `
          <article class="featured-admin-row" data-featured-slug="${escapeHtml(article.slug)}">
            <span class="featured-rank">${index + 1}</span>
            <img src="${escapeHtml(articleImageUrl(article))}" alt="" loading="lazy" />
            <div class="featured-admin-copy">
              <small>${renderMetaLine(article, { includeAuthor: true })}</small>
              <strong>${escapeHtml(article.title)}</strong>
            </div>
            <div class="featured-admin-controls">
              <label class="feature-order-label">
                Featured order
                <input class="feature-order-input" data-featured-action="order" type="number" min="1" max="99" value="${escapeHtml(article.featuredOrder || index + 1)}" aria-label="Featured order" />
              </label>
              <div class="feature-order-actions">
                <button class="feature-order-button" type="button" data-featured-action="up" ${index === 0 ? "disabled" : ""}>Up</button>
                <button class="feature-order-button" type="button" data-featured-action="down" ${index === featuredArticles.length - 1 ? "disabled" : ""}>Down</button>
              </div>
              <button class="delete-link" type="button" data-featured-action="remove">Remove from featured</button>
            </div>
          </article>
        `
      )
      .join("");

    featuredList.querySelectorAll("img").forEach((image) => {
      image.addEventListener("error", () => {
        image.src = fallbackImageUrl;
      });
    });

    featuredList.querySelectorAll("[data-featured-slug]").forEach((row) => {
      const slug = row.dataset.featuredSlug;
      const orderInput = row.querySelector('[data-featured-action="order"]');
      row.querySelector('[data-featured-action="remove"]').addEventListener("click", () => updateArticleFeatured(slug, false, ""));
      row.querySelector('[data-featured-action="up"]').addEventListener("click", () => moveFeaturedArticle(slug, -1));
      row.querySelector('[data-featured-action="down"]').addEventListener("click", () => moveFeaturedArticle(slug, 1));
      orderInput.addEventListener("change", () => updateArticleFeatured(slug, true, orderInput.value));
    });
  }

  async function updateArticleStatus(slug, status) {
    setListStatus("Updating article status...");

    try {
      const article = await fetchJson(`/api/articles/${encodeURIComponent(slug)}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ status }),
      });
      setListStatus(`Article status set to ${article.status}.`, "success");
      if (adminForm.originalSlug.value === slug) fillAdminForm(article);
      await loadAdminArticles();
      await loadCategories();
      await loadHeroArticles();
    } catch (error) {
      setListStatus(error.message || "Could not update article status.", "error");
    }
  }

  function renderAdminArticles() {
    const articles = state.adminArticles || [];
    const query = articleSearchInput?.value.trim().toLocaleLowerCase("mn-MN") || "";
    const visibleArticles = query
      ? articles.filter((article) => {
          const searchableText = [
            article.title,
            article.author,
            article.slug,
            articleCategoryNames(article),
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase("mn-MN");

          return searchableText.includes(query);
        })
      : articles;
    const featuredArticles = getFeaturedArticles();
    const limitReached = featuredArticles.length >= featuredLimit;
    const showDangerousActions = canUseDangerousAdminActions();
    setListStatus(!articles.length
      ? "No articles yet."
      : query
        ? visibleArticles.length
          ? `${visibleArticles.length} of ${articles.length} articles shown.`
          : "No post matches that search."
        : ""
    );
    articleList.innerHTML = visibleArticles
      .map(
        (article) => `
          <article class="admin-article-row${article.deletedAt ? " is-deleted" : ""}" data-admin-slug="${escapeHtml(article.slug)}">
            <img src="${escapeHtml(articleImageUrl(article))}" alt="" loading="lazy" />
            <div>
              <span>${renderMetaLine(article, { includeAuthor: false })}</span>
              <strong>${escapeHtml(article.title)}</strong>
              <small>${escapeHtml(article.author)} / ${escapeHtml(article.status || "draft")}${article.deletedAt ? " / deleted" : ""}</small>
            </div>
            <div class="admin-row-controls">
              <button class="feature-toggle-button" type="button" data-action="feature" ${(!canFeatureArticles() || article.status !== "published" || article.deletedAt || (limitReached && !isArticleFeatured(article))) ? "disabled" : ""}>${isArticleFeatured(article) ? "Remove from featured" : "Feature"}</button>
              <label class="feature-order-label admin-row-feature-order">
                Featured order
                <input class="feature-order-input" data-action="order" type="number" min="1" max="99" value="${escapeHtml(article.featuredOrder || "")}" aria-label="Featured order" ${isArticleFeatured(article) && canFeatureArticles() ? "" : "disabled"} />
              </label>
              <button class="back-link" type="button" data-action="edit" ${canEditAdminArticle(article) ? "" : "disabled"}>Edit</button>
              ${showDangerousActions && article.status !== "published" ? '<button class="back-link" type="button" data-action="publish">Publish</button>' : ""}
              ${showDangerousActions && article.status !== "archived" ? '<button class="back-link" type="button" data-action="archive">Archive</button>' : ""}
              ${showDangerousActions && article.status === "archived" ? '<button class="back-link" type="button" data-action="restore">Restore</button>' : ""}
              ${showDangerousActions ? '<button class="delete-link" type="button" data-action="delete">Delete</button>' : ""}
            </div>
          </article>
        `
      )
      .join("");

    articleList.querySelectorAll("img").forEach((image) => {
      image.addEventListener("error", () => {
        image.src = fallbackImageUrl;
      });
    });

    articleList.querySelectorAll("[data-admin-slug]").forEach((row) => {
      const slug = row.dataset.adminSlug;
      const article = visibleArticles.find((item) => item.slug === slug);
      row.querySelector('[data-action="edit"]').addEventListener("click", () => fillAdminForm(article));
      row.querySelector('[data-action="publish"]')?.addEventListener("click", () => updateArticleStatus(slug, "published"));
      row.querySelector('[data-action="archive"]')?.addEventListener("click", () => updateArticleStatus(slug, "archived"));
      row.querySelector('[data-action="restore"]')?.addEventListener("click", () => updateArticleStatus(slug, "draft"));
      row.querySelector('[data-action="delete"]')?.addEventListener("click", async () => {
        if (!window.confirm(`"${article.title}" нийтлэлийг устгах уу?`)) return;
        setListStatus("Deleting article...");

        try {
          await fetchJson(`/api/articles/${slug}`, { method: "DELETE", headers: adminHeaders() });
          if (adminForm.originalSlug.value === slug) resetAdminForm();
          await loadAdminArticles();
          await loadCategories();
          setListStatus("Article deleted.", "success");
        } catch (error) {
          setListStatus(error.message || "Could not delete article.", "error");
        }
      });

      const featureButton = row.querySelector('[data-action="feature"]');
      const orderInput = row.querySelector('[data-action="order"]');
      const updateFeatureOrder = async () => {
        if (!isArticleFeatured(article)) return;
        await updateArticleFeatured(slug, true, orderInput.value);
      };

      featureButton.addEventListener("click", async () => {
        featureButton.disabled = true;
        const updated = await updateArticleFeatured(slug, !isArticleFeatured(article), orderInput.value);
        if (!updated) featureButton.disabled = false;
      });
      orderInput.addEventListener("change", updateFeatureOrder);
    });

    renderAdminFeatured();
    renderAdminOverview();
  }

  async function loadAdminArticles() {
    setListStatus("Loading articles...");

    try {
      const params = new URLSearchParams();
      if (state.adminStatusFilter) params.set("status", state.adminStatusFilter);
      params.set("page", "1");
      params.set("limit", "100");
      state.adminArticles = collectionItems(await fetchJson(`/api/admin/articles${params.toString() ? `?${params.toString()}` : ""}`, { headers: adminHeaders() }));
      state.adminAllArticles = state.adminStatusFilter
        ? collectionItems(await fetchJson("/api/admin/articles?page=1&limit=100", { headers: adminHeaders() }))
        : state.adminArticles;
      renderAdminArticles();
      renderAdminHeroPreview();
      renderAdminOverview();
    } catch (error) {
      setListStatus(error.message || "Could not load articles.", "error");
    }
  }

  adminForm.addEventListener("input", renderAdminHeroPreview);
  adminForm.addEventListener("change", renderAdminHeroPreview);
  ["slug", "excerpt", "metaTitle", "metaDescription"].forEach((name) => {
    adminField(name)?.addEventListener("input", () => markFieldEdited(name));
  });
  adminForm.title.addEventListener("input", () => {
    applyTitleAutofill();
    renderAdminHeroPreview();
  });
  adminForm.slug.addEventListener("input", () => {
    adminForm.slug.value = slugifyText(adminForm.slug.value);
  });
  adminForm.body.addEventListener("input", () => {
    applyBodyAutofill();
    renderAdminHeroPreview();
  });
  articleSearchInput?.addEventListener("input", renderAdminArticles);
  statusFilter?.querySelectorAll("[data-status-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.adminStatusFilter = button.dataset.statusFilter || "";
      statusFilter.querySelectorAll("[data-status-filter]").forEach((item) => {
        item.classList.toggle("is-active", item === button);
      });
      loadAdminArticles();
    });
  });

  adminForm.featured.addEventListener("change", () => {
    if (adminForm.featured.checked && !canFeatureArticle(adminForm.originalSlug.value || adminForm.slug.value)) {
      adminForm.featured.checked = false;
      setFeaturedWarning(`Онцлох нийтлэл хамгийн ихдээ ${featuredLimit} байна. Эхлээд нэгийг нь хасна уу.`);
    }

    renderAdminHeroPreview();
    updateEditorActions((state.adminArticles || []).find((article) => article.slug === adminForm.originalSlug.value));
  });

  imageFileInput.addEventListener("change", async () => {
    const file = imageFileInput.files?.[0];
    if (!file) return;

    state.adminImageUploading = true;
    imageFileInput.disabled = true;
    updateEditorActions((state.adminArticles || []).find((article) => article.slug === adminForm.originalSlug.value));
    setPanelStatus(imageStatus, "Uploading image...");

    try {
      const result = await uploadAdminImage(file);
      imageInput.value = result.imageUrl;
      setPanelStatus(imageStatus, "Image uploaded.", "success");
      setFormStatus("Image uploaded and added to the article.", "success");
      renderAdminHeroPreview();
    } catch (error) {
      setPanelStatus(imageStatus, error.message || "Could not upload image.", "error");
      setFormStatus(error.message || "Could not upload image.", "error");
    } finally {
      state.adminImageUploading = false;
      imageFileInput.disabled = false;
      imageFileInput.value = "";
      updateEditorActions((state.adminArticles || []).find((article) => article.slug === adminForm.originalSlug.value));
    }
  });

  adminForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.adminImageUploading) {
      setFormStatus("Wait for the image upload to finish before saving.", "error");
      return;
    }

    const submitter = event.submitter;
    const requestedStatus = submitter?.dataset.saveStatus || "draft";
    ensureGeneratedPublishFields();
    const payload = Object.fromEntries(new FormData(adminForm).entries());
    addTaxonomyPayload(payload, adminForm);
    payload.isFeatured = adminForm.featured.checked;
    payload.featured = adminForm.featured.checked;
    payload.featuredOrder = payload.featuredOrder ? Number(payload.featuredOrder) : "";
    payload.status = requestedStatus;
    if (requestedStatus !== "published") {
      payload.isFeatured = false;
      payload.featured = false;
      payload.featuredOrder = "";
    }
    payload.slug = slugifyText(payload.slug || payload.title);
    const originalSlug = payload.originalSlug;
    const existingArticle = originalSlug
      ? [...(state.adminAllArticles || []), ...(state.adminArticles || [])].find((article) => article.slug === originalSlug)
      : null;
    delete payload.originalSlug;

    if (!payload.slug) {
      setFormStatus("Slug is required.", "error");
      return;
    }

    if (requestedStatus === "published" && (!payload.excerpt?.trim() || !payload.body?.trim())) {
      setFormStatus("Published articles need an excerpt and body.", "error");
      return;
    }

    if (payload.featured && !canFeatureArticle(originalSlug || payload.slug)) {
      setFeaturedWarning(`Онцлох нийтлэл хамгийн ихдээ ${featuredLimit} байна. Эхлээд нэгийг нь хасна уу.`);
      return;
    }

    payload.imageUrl = (payload.imageUrl || "").trim();
    payload.author = payload.author?.trim() || defaultAdminAuthorName();
    payload.metaTitle = payload.metaTitle?.trim() || (fieldWasEdited("metaTitle") ? "" : payload.title?.trim());
    payload.metaDescription = payload.metaDescription?.trim() || (fieldWasEdited("metaDescription") ? "" : metaDescriptionFromText(payload.excerpt, payload.body));
    delete payload.tags;
    if (existingArticle?.publishedAt) {
      payload.publishedAt = existingArticle.publishedAt;
    } else if (requestedStatus === "published") {
      payload.publishedAt = new Date().toISOString();
    }

    const actionButtons = [draftButton, publishButton, archiveButton, restoreButton, newButton].filter(Boolean);
    actionButtons.forEach((button) => {
      button.disabled = true;
    });
    const defaultSubmitText = submitter?.textContent || "";
    if (submitter) submitter.textContent = requestedStatus === "published" ? "Publishing..." : "Saving...";
    setFormStatus(originalSlug ? "Saving article..." : "Creating article...");

    try {
      const article = await fetchJson(originalSlug ? `/api/articles/${encodeURIComponent(originalSlug)}` : "/api/articles", {
        method: originalSlug ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(payload),
      });
      fillAdminForm(article);
      setFormStatus(requestedStatus === "published" ? "Article published." : "Draft saved.", "success");
      await loadCategories();
      await loadAdminArticles();
      state.adminArticles = state.adminArticles.map((item) => (item.slug === article.slug ? article : item));
    } catch (error) {
      setFormStatus(error.message || "Could not save article.", "error");
    } finally {
      if (submitter) submitter.textContent = defaultSubmitText;
      actionButtons.forEach((button) => {
        button.disabled = false;
      });
      const article = (state.adminArticles || []).find((item) => item.slug === adminForm.originalSlug.value);
      updateEditorActions(article);
    }
  });

  newButton.addEventListener("click", clearAdminForm);
  archiveButton.addEventListener("click", () => {
    if (adminForm.originalSlug.value) updateArticleStatus(adminForm.originalSlug.value, "archived");
  });
  restoreButton.addEventListener("click", () => {
    if (adminForm.originalSlug.value) updateArticleStatus(adminForm.originalSlug.value, "draft");
  });
  adminAdminForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = adminAdminForm.querySelector('button[type="submit"]');
    const payload = Object.fromEntries(new FormData(adminAdminForm).entries());
    submitButton.disabled = true;
    setAdminAdminStatus("Adding admin...");

    try {
      await fetchJson("/api/admin/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(payload),
      });
      adminAdminForm.reset();
      setAdminAdminStatus("Admin added.", "success");
      await loadAdminUsers();
    } catch (error) {
      setAdminAdminStatus(error.message || "Could not add admin.", "error");
    } finally {
      submitButton.disabled = false;
    }
  });
  adminCategoryForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!canManageCategories()) return;

    const submitButton = adminCategoryForm.querySelector('button[type="submit"]');
    const originalSlug = adminCategoryOriginalSlug.value.trim();
    const name = adminCategoryNameInput.value.trim();
    const slug = slugifyText(adminCategorySlugInput.value || name);

    if (!name || !slug) {
      setAdminCategoryStatus("Category name and slug are required.", "error");
      return;
    }

    submitButton.disabled = true;
    setAdminCategoryStatus(originalSlug ? "Saving category..." : "Creating category...");

    try {
      await fetchJson(originalSlug ? `/api/admin/categories/${encodeURIComponent(originalSlug)}` : "/api/admin/categories", {
        method: originalSlug ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          name,
          slug,
          sortOrder: Number(adminCategorySortInput?.value || 0),
          visibleInHeader: Boolean(adminCategoryHeaderInput?.checked),
          visibleOnHomepage: Boolean(adminCategoryHomepageInput?.checked),
        }),
      });
      adminCategoryForm.reset();
      if (adminCategoryHeaderInput) adminCategoryHeaderInput.checked = true;
      if (adminCategoryHomepageInput) adminCategoryHomepageInput.checked = true;
      delete adminCategorySlugInput.dataset.touched;
      setAdminCategoryStatus(originalSlug ? "Category updated." : "Category created.", "success");
      await refreshAdminCategories();
      await loadAdminArticles();
      await loadHeroArticles();
    } catch (error) {
      setAdminCategoryStatus(error.message || "Could not save category.", "error");
    } finally {
      submitButton.disabled = false;
    }
  });
  adminCategoryNameInput?.addEventListener("input", () => {
    if (!adminCategoryOriginalSlug.value && !adminCategorySlugInput.dataset.touched) {
      adminCategorySlugInput.value = slugifyText(adminCategoryNameInput.value);
    }
  });
  adminCategorySlugInput?.addEventListener("input", () => {
    adminCategorySlugInput.dataset.touched = "true";
    adminCategorySlugInput.value = slugifyText(adminCategorySlugInput.value);
  });
  document.querySelector("#refreshAdminArticles").addEventListener("click", loadAdminArticles);
  document.querySelector("#adminBackHome").addEventListener("click", () => goHome());
  document.querySelector("#adminLogoutButton").addEventListener("click", () => {
    adminLogout();
    openAdminLogin({ pushUrl: true });
  });

  resetAdminForm();
  renderAdminCategories();
  setAdminTab("articles");
  await loadAdminUsers();
  await loadAdminArticles();
}

function renderCategories() {
  syncCategoryArchiveMode();
  const writingCategories = headerWritingCategories();
  const directCategories = headerDirectCategories();
  const menuCategoryButtons = writingCategories
    .map((category) => `
      <button class="${state.activeCategory === category.slug ? "is-active" : ""}" data-category="${escapeHtml(category.slug)}" type="button" role="menuitem" title="${escapeHtml(category.name)}">
        ${escapeHtml(category.name)}
        <small aria-label="${Number(category.articleCount || 0)} нийтлэл">${Number(category.articleCount || 0)}</small>
      </button>
    `)
    .join("");
  const directCategoryButtons = directCategories
    .map((category) => `
      <button class="nav-section ${state.activeCategory === category.slug ? "is-active" : ""}" data-category="${escapeHtml(category.slug)}" type="button">
        ${escapeHtml(category.name)}
      </button>
    `)
    .join("");

  const activeMenuCategory = writingCategories.find((category) => category.slug === state.activeCategory);
  categoryNav.innerHTML = `
    <button class="nav-home ${!state.activeCategory && !state.activeMainSection && state.view === "home" ? "is-active" : ""}" data-home-nav type="button">
      Home
    </button>
    <div class="nav-dropdown category-dropdown ${activeMenuCategory ? "is-active" : ""}">
      <button class="category-toggle ${activeMenuCategory ? "is-active" : ""}" data-nav-toggle type="button" aria-haspopup="true" aria-expanded="false">
        ${escapeHtml(writingDropdownLabel)}
        ${activeMenuCategory ? `<small>${escapeHtml(activeMenuCategory.name)}</small>` : ""}
        <span class="nav-chevron" aria-hidden="true">▾</span>
      </button>
      <div class="nav-menu category-menu" role="menu">
        ${menuCategoryButtons}
      </div>
    </div>
    ${directCategoryButtons}
  `;

  categoryNav.querySelector("[data-home-nav]")?.addEventListener("click", () => {
    state.activeCategory = "";
    state.activeMainSection = "";
    state.activePage = 1;
    state.query = "";
    if (headerSearchInput) headerSearchInput.value = "";
    closeMobileHeaderPanels();
    goHome();
  });

  categoryNav.querySelectorAll(".nav-dropdown").forEach((dropdown) => {
    const toggle = dropdown.querySelector("[data-nav-toggle]");

    toggle?.addEventListener("click", (event) => {
      event.stopPropagation();
      categoryNav.querySelectorAll(".nav-dropdown").forEach((item) => {
        if (item !== dropdown) {
          item.classList.remove("is-open");
          item.querySelector("[data-nav-toggle]")?.setAttribute("aria-expanded", "false");
        }
      });
      const isOpen = dropdown.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(isOpen));
    });
  });

  categoryNav.querySelectorAll("[data-category]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeCategory = button.dataset.category || "";
      state.activeMainSection = "";
      state.activeAuthor = "";
      state.activePage = 1;
      renderCategories();
      if (getArticleSlugFromPath()) {
        history.pushState({ view: "home" }, "", "/");
      }
      closeMobileHeaderPanels();
      loadArticles({ scrollNews: true });
    });
  });
}

function closeCategoryDropdowns() {
  categoryNav?.querySelectorAll(".nav-dropdown.is-open").forEach((dropdown) => {
    dropdown.classList.remove("is-open");
    dropdown.querySelector("[data-nav-toggle]")?.setAttribute("aria-expanded", "false");
  });
}
async function loadCategories() {
  const loadedCategories = await fetchJson("/api/categories");
  state.categories = sortedCategories((Array.isArray(loadedCategories) ? loadedCategories : [])
    .map((category, index) => ({
      id: category.id ?? index + 1,
      slug: String(category.slug || "").trim(),
      name: category.name || category.label || category.slug || "Category",
      articleCount: Number(category.articleCount || 0),
      subcategoryCount: Number(category.subcategoryCount || 0),
      sortOrder: Number(category.sortOrder ?? category.sort_order ?? index + 1),
      visibleInHeader: category.visibleInHeader === undefined && category.visible_in_header === undefined
        ? true
        : String(category.visibleInHeader ?? category.visible_in_header) !== "0" && category.visibleInHeader !== false,
      visibleOnHomepage: category.visibleOnHomepage === undefined && category.visible_on_homepage === undefined
        ? true
        : String(category.visibleOnHomepage ?? category.visible_on_homepage) !== "0" && category.visibleOnHomepage !== false,
      parentId: category.parentId ?? category.parent_id ?? null,
    }))
    .filter((category) => category.slug));
  renderCategories();
}

async function loadArticles({ openSingle = false, scrollNews = false } = {}) {
  if (state.view !== "home") mountHome();
  syncCategoryArchiveMode();

  const params = new URLSearchParams();
  if (state.activeCategory) params.set("category", state.activeCategory);
  if (state.activeAuthor) params.set("author", state.activeAuthor);
  if (state.query) params.set("q", state.query);
  renderArchiveFilters();

  setStatus("Нийтлэлүүдийг ачаалж байна...");

  try {
    params.set("page", "1");
    params.set("limit", "50");
    const loadedArticles = collectionItems(await fetchJson(`/api/articles?${params.toString()}`));
    const activeSection = sectionConfig(state.activeMainSection);
    state.articles = activeSection ? loadedArticles.filter((article) => articleMatchesSection(article, activeSection)) : loadedArticles;
    const totalPages = Math.max(1, Math.ceil(state.articles.length / articlesPerPage));
    state.activePage = Math.min(Math.max(1, state.activePage || 1), totalPages);
    setStatus(state.articles.length ? "" : "Нийтлэл олдсонгүй.");

    if (openSingle && state.articles.length === 1) {
      openArticle(state.articles[0].slug, { pushUrl: true });
      return;
    }

    renderArticles();
    if (scrollNews) {
      document.querySelector("#news").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    console.error("Could not load articles:", error);
    setStatus(error.message || "Нийтлэлүүдийг ачаалж чадсангүй.");
    renderArticles();
  }
}

async function loadHeroArticles() {
  if (!heroTrack) return;

  try {
    const featured = await fetchJson("/api/articles/featured");
    state.heroArticles = featured.length ? featured : [];
    state.heroIndex = 0;
    state.heroPreviousIndex = null;
    state.heroDirection = 0;
    renderHeroCarousel();
  } catch (error) {
    console.error("Could not load featured articles:", error);
    state.heroArticles = [];
    state.heroPreviousIndex = null;
    state.heroDirection = 0;
    renderHeroCarousel();
  }
}

function bindHeroCarousel() {
  if (!heroTrack || !heroPrev || !heroNext) return;

  let swipeStartX = 0;

  heroPrev.addEventListener("click", () => moveHeroSlide(-1));
  heroNext.addEventListener("click", () => moveHeroSlide(1));
  heroTrack.addEventListener("pointerdown", (event) => {
    swipeStartX = event.clientX;
  });
  heroTrack.addEventListener("pointerup", (event) => {
    const delta = event.clientX - swipeStartX;
    if (Math.abs(delta) > 44) {
      moveHeroSlide(delta > 0 ? -1 : 1);
    }
  });
}

function moveHeroSlide(direction) {
  const articles = state.heroArticles || [];
  if (articles.length <= 1) return;

  const currentIndex = state.heroIndex || 0;
  state.heroPreviousIndex = currentIndex;
  state.heroDirection = direction > 0 ? 1 : -1;
  state.heroIndex = (currentIndex + direction + articles.length) % articles.length;
  renderHeroCarousel();
}

function heroDirectionTo(currentIndex, targetIndex, totalSlides) {
  if (currentIndex === targetIndex) return 0;

  const forwardDistance = (targetIndex - currentIndex + totalSlides) % totalSlides;
  const backwardDistance = (currentIndex - targetIndex + totalSlides) % totalSlides;
  return forwardDistance <= backwardDistance ? 1 : -1;
}

function heroSlideClass(articleIndex, activeIndex, previousIndex, shouldAnimate) {
  const classes = ["hero-slide"];
  if (articleIndex === activeIndex) classes.push("is-active");
  if (shouldAnimate && articleIndex === previousIndex) classes.push("is-exiting");
  return classes.join(" ");
}

function renderHeroCarousel() {
  if (!heroTrack || !heroDots) return;

  const articles = state.heroArticles || [];
  window.clearInterval(heroTimer);

  if (!articles.length) {
    heroDots.innerHTML = "";
    heroPrev.classList.add("is-hidden");
    heroNext.classList.add("is-hidden");
    heroTrack.classList.remove("is-sliding-next", "is-sliding-prev");
    return;
  }

  heroPrev.classList.toggle("is-hidden", articles.length <= 1);
  heroNext.classList.toggle("is-hidden", articles.length <= 1);

  const index = Math.min(state.heroIndex || 0, articles.length - 1);
  const previousIndex = Number.isInteger(state.heroPreviousIndex) ? state.heroPreviousIndex : null;
  const direction = state.heroDirection === -1 ? -1 : state.heroDirection === 1 ? 1 : 0;
  const shouldAnimate = Boolean(direction && previousIndex !== null && previousIndex !== index && articles[previousIndex]);

  heroTrack.classList.toggle("is-sliding-next", shouldAnimate && direction > 0);
  heroTrack.classList.toggle("is-sliding-prev", shouldAnimate && direction < 0);

  heroTrack.innerHTML = articles
    .map(
      (article, articleIndex) => `
        <a class="${heroSlideClass(articleIndex, index, previousIndex, shouldAnimate)}" href="${articleUrl(article.slug)}" data-hero-slug="${escapeHtml(article.slug)}">
          <div class="hero-media">
            <img class="hero-image" src="${escapeHtml(articleImageUrl(article))}" alt="${escapeHtml(article.title)}" />
          </div>
          <div class="hero-overlay">
            <span class="hero-kicker">${renderHeroLabel(article)}</span>
            <h1>${escapeHtml(article.title)}</h1>
            <p>${escapeHtml(article.excerpt)}</p>
            <div class="hero-meta">
              <span>${escapeHtml(formatDate(article.publishedAt))}</span>
            </div>
          </div>
        </a>
      `
    )
    .join("");

  heroDots.innerHTML = articles
    .map(
      (_article, dotIndex) =>
        `<button class="${dotIndex === index ? "is-active" : ""}" type="button" data-hero-dot="${dotIndex}" aria-label="${dotIndex + 1} онцлох нийтлэл"></button>`
    )
    .join("");

  heroTrack.querySelectorAll("[data-hero-slug]").forEach((slide) => {
    slide.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      openArticle(slide.dataset.heroSlug, { pushUrl: true });
    });
  });

  heroTrack.querySelectorAll("img").forEach((image) => {
    image.addEventListener("error", () => {
      image.src = fallbackImageUrl;
    });
  });

  heroDots.querySelectorAll("[data-hero-dot]").forEach((dot) => {
    dot.addEventListener("click", () => {
      const targetIndex = Number(dot.dataset.heroDot);
      const currentIndex = state.heroIndex || 0;
      const dotDirection = heroDirectionTo(currentIndex, targetIndex, articles.length);
      if (!dotDirection) return;

      state.heroPreviousIndex = currentIndex;
      state.heroDirection = dotDirection;
      state.heroIndex = targetIndex;
      renderHeroCarousel();
    });
  });

  if (articles.length > 1) {
    heroTimer = window.setInterval(() => moveHeroSlide(1), 6500);
  }
}

function hasArchiveFilter() {
  return Boolean(state.activeCategory || state.activeMainSection || state.activeAuthor || state.query);
}

function syncCategoryArchiveMode() {
  document.body.classList.toggle("category-archive-active", Boolean(state.activeCategory));
}

function renderPostCard(article, { className = "post-card", dataName = "slug", showExcerpt = false } = {}) {
  return `
    <a class="${className}" href="${articleUrl(article.slug)}" data-${dataName}="${escapeHtml(article.slug)}" aria-label="${escapeHtml(article.title)} унших">
      <span class="post-thumb">
        <img src="${escapeHtml(articleImageUrl(article))}" alt="${escapeHtml(article.title)}" loading="lazy" />
      </span>
      <div class="post-copy">
        <span class="post-category">${escapeHtml(articleCategoryNames(article) || "Нийтлэл")}</span>
        <h3>${escapeHtml(article.title)}</h3>
        ${showExcerpt && article.excerpt ? `<p>${escapeHtml(article.excerpt)}</p>` : ""}
        <small>${escapeHtml(article.author || "Tom/Art")} · ${escapeHtml(formatDate(article.publishedAt))}</small>
      </div>
    </a>
  `;
}

function bindArticleCardLinks(container = articleGrid, dataName = "slug") {
  if (!container) return;
  const datasetKey = dataName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());

  container.querySelectorAll("img").forEach((image) => {
    image.addEventListener("error", () => {
      image.src = fallbackImageUrl;
    });
  });

  container.querySelectorAll(`[data-${dataName}]`).forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      openArticle(card.dataset[datasetKey], { pushUrl: true });
    });
  });
}

function openSectionArchive(sectionKey = "") {
  state.activeCategory = sectionKey;
  state.activeAuthor = "";
  state.activeMainSection = "";
  state.activePage = 1;
  renderCategories();
  closeMobileHeaderPanels();
  loadArticles({ scrollNews: true });
}

function openCategoryArchive(categorySlug = "") {
  state.activeAuthor = "";
  state.activeMainSection = "";
  state.activeCategory = categorySlug;
  state.activePage = 1;
  renderCategories();
  closeMobileHeaderPanels();
  loadArticles({ scrollNews: true });
}

function renderHomeSectionFrame(section = {}, bodyHtml = "") {
  if (!bodyHtml) return "";
  const accentColor = section.accentColor || homeCategoryAccentColors[0];

  return `
    <section class="home-category-section" data-home-section="${escapeHtml(section.slug)}" style="--category-accent: ${escapeHtml(accentColor)}">
      <div class="home-section-heading">
        <h3><span class="category-dot" aria-hidden="true"></span>${escapeHtml(section.label)}</h3>
        ${section.hasMore ? `<button type="button" data-category-open="${escapeHtml(section.slug)}">Цааш унших</button>` : ""}
      </div>
      ${bodyHtml}
    </section>
  `;
}

function homepageArticlesForCategory(section = {}) {
  const slugs = categoryGroupSlugs(section);
  return uniqueArticles(state.articles.filter((article) => articleVisibleCategorySlugs(article).some((slug) => slugs.includes(slug))));
}

function renderHomeSection(section = {}) {
  const allArticles = homepageArticlesForCategory(section);
  const articles = allArticles.slice(0, 2);
  if (!articles.length) return "";

  return renderHomeSectionFrame({ ...section, hasMore: true }, `
    <div class="home-category-posts">
      ${articles.map((article) => renderPostCard(article, { className: "home-small-card", dataName: "home-slug" })).join("")}
    </div>
  `);
}

function renderHomepageSections() {
  if (!articleGrid) return;
  articleGrid.classList.add("home-preview-sections");
  articleGrid.classList.remove("category-card-grid");
  if (articlePagination) articlePagination.innerHTML = "";

  const sectionCategories = homepageSectionCategories()
    .filter((category) => homepageArticlesForCategory(category).length);
  const categorySections = sectionCategories
    .map((category, index) => renderHomeSection({
      key: category.slug,
      slug: category.slug,
      label: category.name,
      accentColor: homeCategoryAccentColors[Math.floor(index / 2) % homeCategoryAccentColors.length],
    }))
    .filter(Boolean)
    .join("");
  articleGrid.innerHTML = `
    <div class="home-category-mosaic">${categorySections}</div>
  `;

  articleGrid.querySelectorAll("[data-category-open]").forEach((button) => {
    button.addEventListener("click", () => openCategoryArchive(button.dataset.categoryOpen));
  });
  bindArticleCardLinks(articleGrid, "home-slug");
}

function renderArticles() {
  if (!articleGrid) return;
  syncCategoryArchiveMode();

  if (!state.articles.length) {
    articleGrid.innerHTML = "";
    articleGrid.classList.remove("home-preview-sections");
    articleGrid.classList.add("category-card-grid");
    if (articlePagination) articlePagination.innerHTML = "";
    return;
  }

  if (!hasArchiveFilter()) {
    renderHomepageSections();
    return;
  }

  const totalPages = Math.max(1, Math.ceil(state.articles.length / articlesPerPage));
  state.activePage = Math.min(Math.max(1, state.activePage || 1), totalPages);
  const pageStart = (state.activePage - 1) * articlesPerPage;
  const pageArticles = state.articles.slice(pageStart, pageStart + articlesPerPage);

  articleGrid.classList.remove("home-preview-sections");
  articleGrid.classList.add("category-card-grid");
  articleGrid.innerHTML = pageArticles.map((article) => renderPostCard(article, { showExcerpt: true })).join("");

  renderArticlePagination(totalPages);
  bindArticleCardLinks(articleGrid);
}

function renderArticlePagination(totalPages) {
  if (!articlePagination) return;

  const pageButtons = Array.from({ length: totalPages }, (_item, index) => index + 1)
    .map(
      (page) => `
        <button class="${page === state.activePage ? "is-active" : ""}" type="button" data-page="${page}" aria-label="${page}-р хуудас">
          ${page}
        </button>
      `
    )
    .join("");

  articlePagination.innerHTML = `
    <button type="button" data-page-move="-1" aria-label="Өмнөх хуудас" ${state.activePage === 1 ? "disabled" : ""}>‹</button>
    ${pageButtons}
    <button type="button" data-page-move="1" aria-label="Дараах хуудас" ${state.activePage === totalPages ? "disabled" : ""}>›</button>
    <span>${state.activePage} / ${totalPages}</span>
  `;

  articlePagination.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activePage = Number(button.dataset.page);
      renderArticles();
      document.querySelector("#news")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  articlePagination.querySelectorAll("[data-page-move]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextPage = state.activePage + Number(button.dataset.pageMove);
      state.activePage = Math.min(Math.max(1, nextPage), totalPages);
      renderArticles();
      document.querySelector("#news")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function renderArchiveFilters() {
  if (!archiveFilters) return;

  const filters = [
    state.query ? { label: `Search: ${state.query}`, clear: "query" } : null,
    state.activeAuthor ? { label: `Author: ${state.activeAuthor}`, clear: "author" } : null,
    state.activeMainSection ? {
      label: sectionConfig(state.activeMainSection)?.label || state.activeMainSection,
      clear: "main",
    } : null,
    state.activeCategory ? {
      label: publicCategoryLabel(state.activeCategory),
      clear: "category",
    } : null,
  ].filter(Boolean);

  archiveFilters.classList.toggle("is-hidden", !filters.length);
  archiveFilters.innerHTML = filters
    .map((filter) => `<button type="button" data-clear-filter="${filter.clear}">${escapeHtml(filter.label)} x</button>`)
    .join("");

  archiveFilters.querySelectorAll("[data-clear-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.clearFilter === "query") {
        state.query = "";
        if (headerSearchInput) headerSearchInput.value = "";
      }
      if (button.dataset.clearFilter === "author") state.activeAuthor = "";
      if (button.dataset.clearFilter === "main") state.activeMainSection = "";
      if (button.dataset.clearFilter === "category") state.activeCategory = "";
      state.activePage = 1;
      renderCategories();
      renderArchiveFilters();
      loadArticles({ scrollNews: true });
    });
  });
}

function bindContactScrollLinks() {
  document.querySelectorAll('a[href="#aboutContact"]').forEach((link) => {
    link.addEventListener("click", (event) => {
      const target = document.querySelector("#aboutContact");
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

async function openArticle(slug, { pushUrl = false } = {}) {
  try {
    const article = await fetchJson(`/api/articles/${slug}`, state.adminToken ? { headers: adminHeaders() } : undefined);
    state.view = "article";
    document.body.dataset.view = "article";

    if (pushUrl && window.location.pathname !== articleUrl(slug)) {
      history.pushState({ view: "article", slug }, "", articleUrl(slug));
    }

    setPageMeta({
      title: article.metaTitle || `${article.title} / Tomujin Article`,
      description: article.metaDescription || article.excerpt || "Tomujin Article",
      image: articleImageUrl(article),
      url: window.location.href,
    });

    const detailMetaParts = [
      articleCategoryNames(article) || articleContentType(article),
      formatDate(article.publishedAt),
      article.author,
    ].filter(Boolean);

    app.innerHTML = `
      <section class="article-detail">
        <div class="article-actions">
          <button class="back-link" type="button" id="backToNews">← Нүүр хуудас</button>
          <button class="delete-link ${state.isAdmin && canUseDangerousAdminActions() ? "" : "is-hidden"}" type="button" id="deleteArticle">Устгах</button>
        </div>
        <div class="detail-layout">
          <article class="detail-copy">
            <header class="detail-header">
              ${articleCategoryNames(article) ? `<p class="detail-kicker">${escapeHtml(articleCategoryNames(article))}</p>` : ""}
              <h1>${escapeHtml(article.title)}</h1>
              <p class="excerpt">${escapeHtml(article.excerpt)}</p>
              <div class="detail-byline">
                <span class="detail-author-inline">
                  <span class="author-avatar">${escapeHtml((article.author || "T").slice(0, 1).toUpperCase())}</span>
                  <strong>${escapeHtml(article.author || "Tom/Art")}</strong>
                </span>
                <span>${escapeHtml(formatDate(article.publishedAt))}</span>
              </div>
            </header>
            <img class="detail-cover" src="${escapeHtml(articleImageUrl(article))}" alt="${escapeHtml(article.title)}" />
            <div class="detail-body">
              ${renderParagraphs(article.body)}
            </div>
            <aside class="detail-author-card">
              <span class="author-avatar large">${escapeHtml((article.author || "T").slice(0, 1).toUpperCase())}</span>
              <div>
                <p>Written by</p>
                <h2>${escapeHtml(article.author || "Tom/Art")}</h2>
                ${detailMetaParts.length ? `<span>${detailMetaParts.map(escapeHtml).join(" · ")}</span>` : ""}
              </div>
            </aside>
          </article>
        </div>
      </section>
    `;

    document.querySelector("#backToNews").addEventListener("click", () => {
      history.pushState({ view: "home" }, "", "/");
      mountHome();
      renderCategories();
      loadArticles({ scrollNews: true });
    });

    document.querySelector("#deleteArticle").addEventListener("click", () => {
      deleteArticle(article.slug, article.title);
    });

    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    setStatus(error.message || "Нийтлэл нээж чадсангүй.");
  }
}

async function deleteArticle(slug, title, { askConfirm = true } = {}) {
  if (!state.isAdmin) {
    openAdminLogin({ pushUrl: true });
    return;
  }

  if (askConfirm) {
    const confirmed = window.confirm(`"${title}" нийтлэлийг устгах уу?`);
    if (!confirmed) return;
  }

  try {
    await fetchJson(`/api/articles/${slug}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });

    state.activeCategory = "";
    state.activeMainSection = "";
    state.query = "";
    headerSearchInput.value = "";
    history.pushState({ view: "home" }, "", "/");
    mountHome();
    await loadCategories();
    await loadArticles({ scrollNews: true });
    await loadHeroArticles();
  } catch (error) {
    if (error.message === "Admin login required.") {
      adminLogout();
      window.alert("Админ эрх дахин баталгаажуулах хэрэгтэй.");
      return;
    }

    window.alert(error.message || "Нийтлэлийг устгаж чадсангүй.");
  }
}

headerSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.query = headerSearchInput.value.trim();
  state.activeCategory = "";
  state.activeMainSection = "";
  state.activeAuthor = "";
  state.activePage = 1;
  closeMobileHeaderPanels();
  loadArticles({ openSingle: true, scrollNews: true });
});

homeButton?.addEventListener("click", () => goHome());

function openAdminFromLogo(event) {
  event?.preventDefault();
  closeMobileHeaderPanels();

  if (state.isAdmin) {
    openAdminDashboard({ pushUrl: true });
    return;
  }

  openAdminLogin({ pushUrl: true });
}

brandLink?.addEventListener("click", openAdminFromLogo);

themeToggle?.addEventListener("click", () => {
  toggleThemeMode();
});

mobileThemeToggle?.addEventListener("click", () => {
  toggleThemeMode();
});

mobileSearchToggle?.addEventListener("click", () => {
  const willOpen = !document.body.classList.contains("mobile-search-open");
  setMobilePanel("search", willOpen);
  if (willOpen) {
    window.setTimeout(() => headerSearchInput?.focus(), 80);
  }
});

mobileMenuToggle?.addEventListener("click", () => {
  setMobilePanel("menu", !document.body.classList.contains("mobile-menu-open"));
});

document.addEventListener("click", (event) => {
  if (!categoryNav?.contains(event.target)) {
    closeCategoryDropdowns();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeCategoryDropdowns();
    closeMobileHeaderPanels();
  }
});

backTop.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});

window.addEventListener("scroll", () => {
  backTop.classList.toggle("is-visible", window.scrollY > 460);
});

window.addEventListener("popstate", () => {
  if (isAdminDashboardPath()) {
    openAdminDashboard();
    return;
  }

  if (isAdminPath()) {
    openAdminLogin();
    return;
  }

  const slug = getArticleSlugFromPath();

  if (slug) {
    openArticle(slug, { pushUrl: false });
    return;
  }

  mountHome();
  renderCategories();
  loadArticles();
});

async function startApp() {
  applyTheme();
  updateAdminEntryLabel();

  if (isAdminPath() && !isAdminDashboardPath()) {
    openAdminLogin();
    return;
  }

  await loadCategories();

  if (isAdminDashboardPath()) {
    await openAdminDashboard();
    return;
  }

  mountHome();
  renderCategories();

  const slug = getArticleSlugFromPath();
  if (slug) {
    await openArticle(slug, { pushUrl: false });
    return;
  }

  await loadArticles();
}

startApp().catch((error) => {
  mountHome();
  setStatus(error.message || "Сайтыг ачаалж чадсангүй.");
});
