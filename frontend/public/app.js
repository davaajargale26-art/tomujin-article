const state = {
  categories: [],
  articles: [],
  activeCategory: "all",
  query: "",
  view: "home",
};

const app = document.querySelector("#app");
const homeTemplate = document.querySelector("#homeTemplate");
const categoryNav = document.querySelector("#categoryNav");
const headerSearchForm = document.querySelector("#headerSearchForm");
const headerSearchInput = document.querySelector("#headerSearchInput");
const adminLogin = document.querySelector("#adminLogin");
const showAddArticle = document.querySelector("#showAddArticle");
const backTop = document.querySelector("#backTop");
const adminStorageKey = "tomujinAdminPassword";

let articleGrid;
let statusText;
let articleForm;
let articleCategory;
let formStatus;

state.adminPassword = window.sessionStorage.getItem(adminStorageKey) || "";
state.isAdmin = Boolean(state.adminPassword);

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

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || "Request failed");
  }

  return data;
}

function setStatus(message = "") {
  if (statusText) {
    statusText.textContent = message;
  }
}

function updateAdminButton() {
  adminLogin.classList.toggle("is-active", state.isAdmin);
  adminLogin.textContent = state.isAdmin ? "Админ ✓" : "Админ";
  adminLogin.title = state.isAdmin ? "Админ горимоос гарах" : "Админ код оруулах";
}

async function verifyAdminPassword(password) {
  await fetchJson("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

async function requestAdminLogin() {
  const password = window.prompt("Админ код оруулна уу");
  if (!password) return false;

  try {
    await verifyAdminPassword(password);
    state.adminPassword = password;
    state.isAdmin = true;
    window.sessionStorage.setItem(adminStorageKey, password);
    updateAdminButton();

    const slug = getArticleSlugFromPath();
    if (slug && state.view === "article") {
      await openArticle(slug, { pushUrl: false });
    }

    return true;
  } catch (error) {
    window.alert(error.message || "Админ код буруу байна.");
    return false;
  }
}

function adminLogout() {
  state.adminPassword = "";
  state.isAdmin = false;
  window.sessionStorage.removeItem(adminStorageKey);
  updateAdminButton();

  const slug = getArticleSlugFromPath();
  if (slug && state.view === "article") {
    openArticle(slug, { pushUrl: false });
  }
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
  app.innerHTML = homeTemplate.innerHTML;

  articleGrid = document.querySelector("#articleGrid");
  statusText = document.querySelector("#status");
  articleForm = document.querySelector("#articleForm");
  articleCategory = document.querySelector("#articleCategory");
  formStatus = document.querySelector("#formStatus");

  renderCategorySelect();
  bindArticleForm();
  renderArticles();
}

function renderCategories() {
  const buttons = [
    `<button class="${state.activeCategory === "all" ? "is-active" : ""}" data-category="all" type="button" title="Бүх нийтлэлийг харах">Buhu</button>`,
    ...state.categories.map((category) => {
      const count = Number(category.articleCount || 0);

      return `
        <button class="${state.activeCategory === category.slug ? "is-active" : ""}" data-category="${category.slug}" type="button" title="${escapeHtml(category.name)} ангиллыг харах">
          ${escapeHtml(category.name)}
          <small aria-label="${count} нийтлэл">${count}</small>
        </button>
      `;
    }),
  ];

  categoryNav.innerHTML = buttons.join("");

  categoryNav.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeCategory = button.dataset.category;
      state.query = "";
      headerSearchInput.value = "";
      renderCategories();
      if (getArticleSlugFromPath()) {
        history.pushState({ view: "home" }, "", "/");
      }
      loadArticles({ scrollNews: true });
    });
  });
}

function renderCategorySelect() {
  if (!articleCategory) return;

  articleCategory.innerHTML = state.categories
    .map((category) => `<option value="${category.slug}">${escapeHtml(category.name)}</option>`)
    .join("");
}

async function loadCategories() {
  state.categories = await fetchJson("/api/categories");
  renderCategories();
  renderCategorySelect();
}

async function loadArticles({ openSingle = false, scrollNews = false } = {}) {
  if (state.view !== "home") mountHome();

  const params = new URLSearchParams();
  if (state.activeCategory !== "all") params.set("category", state.activeCategory);
  if (state.query) params.set("q", state.query);

  setStatus("Нийтлэлүүдийг ачаалж байна...");

  try {
    state.articles = await fetchJson(`/api/articles?${params.toString()}`);
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
    setStatus(error.message || "Нийтлэлүүдийг ачаалж чадсангүй.");
    renderArticles();
  }
}

function renderArticles() {
  if (!articleGrid) return;

  if (!state.articles.length) {
    articleGrid.innerHTML = "";
    return;
  }

  articleGrid.innerHTML = state.articles
    .map(
      (article) => `
        <a class="post-card" href="${articleUrl(article.slug)}" data-slug="${escapeHtml(article.slug)}" aria-label="${escapeHtml(article.title)} унших">
          <img src="${escapeHtml(article.imageUrl || "/images/stagknight.jpg")}" alt="${escapeHtml(article.title)}" />
          <div class="post-copy">
            <div class="post-meta">
              <span>${escapeHtml(article.category.name)}</span>
              <span>${escapeHtml(formatDate(article.publishedAt))}</span>
            </div>
            <h3>${escapeHtml(article.title)}</h3>
            <p>${escapeHtml(article.excerpt)}</p>
            <small>${escapeHtml(article.author)}</small>
            <strong>Унших</strong>
          </div>
        </a>
      `
    )
    .join("");

  articleGrid.querySelectorAll("img").forEach((image) => {
    image.addEventListener("error", () => {
      image.src = "/images/stagknight.jpg";
    });
  });

  articleGrid.querySelectorAll("[data-slug]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }

      event.preventDefault();
      openArticle(card.dataset.slug, { pushUrl: true });
    });
  });
}

async function openArticle(slug, { pushUrl = false } = {}) {
  try {
    const article = await fetchJson(`/api/articles/${slug}`);
    state.view = "article";

    if (pushUrl && window.location.pathname !== articleUrl(slug)) {
      history.pushState({ view: "article", slug }, "", articleUrl(slug));
    }

    app.innerHTML = `
      <section class="article-detail">
        <div class="article-actions">
          <button class="back-link" type="button" id="backToNews">Буцах</button>
          <button class="delete-link ${state.isAdmin ? "" : "is-hidden"}" type="button" id="deleteArticle">Устгах</button>
        </div>
        <div class="detail-layout">
          <div class="detail-image">
            <img src="${escapeHtml(article.imageUrl || "/images/stagknight.jpg")}" alt="${escapeHtml(article.title)}" />
          </div>
          <article class="detail-copy">
            <span>${escapeHtml(article.category.name)} / ${escapeHtml(article.author)} / ${escapeHtml(formatDate(article.publishedAt))}</span>
            <h1>${escapeHtml(article.title)}</h1>
            <p class="excerpt">${escapeHtml(article.excerpt)}</p>
            ${renderParagraphs(article.body)}
          </article>
        </div>
      </section>
    `;

    document.querySelector(".detail-image img").addEventListener("error", (event) => {
      event.currentTarget.src = "/images/stagknight.jpg";
    });

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

async function deleteArticle(slug, title, adminPassword = "", { askConfirm = true } = {}) {
  if (!state.isAdmin) {
    const loggedIn = await requestAdminLogin();
    if (!loggedIn) return;
  }

  if (askConfirm) {
    const confirmed = window.confirm(`"${title}" нийтлэлийг устгах уу?`);
    if (!confirmed) return;
  }

  const password = adminPassword || state.adminPassword;
  const headers = password ? { "x-admin-password": password } : {};

  try {
    await fetchJson(`/api/articles/${slug}`, {
      method: "DELETE",
      headers,
    });

    state.activeCategory = "all";
    state.query = "";
    headerSearchInput.value = "";
    history.pushState({ view: "home" }, "", "/");
    mountHome();
    await loadCategories();
    await loadArticles({ scrollNews: true });
  } catch (error) {
    if (error.message === "Admin password required.") {
      adminLogout();
      window.alert("Админ код хэрэгтэй эсвэл код буруу байна.");
      return;
    }

    window.alert(error.message || "Нийтлэлийг устгаж чадсангүй.");
  }
}

function bindArticleForm() {
  if (!articleForm) return;

  articleForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = articleForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    formStatus.textContent = "Хадгалж байна...";

    const payload = Object.fromEntries(new FormData(articleForm).entries());
    if (payload.imageUrl) {
      payload.imageUrl = payload.imageUrl.trim();
    }

    try {
      const article = await fetchJson("/api/articles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      articleForm.reset();
      formStatus.textContent = "Нийтлэгдлээ.";
      state.activeCategory = "all";
      state.query = "";
      headerSearchInput.value = "";
      await loadCategories();
      await loadArticles();
      openArticle(article.slug, { pushUrl: true });
    } catch (error) {
      formStatus.textContent = error.message || "Нийтлэлийг хадгалж чадсангүй.";
    } finally {
      submitButton.disabled = false;
    }
  });
}

headerSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.query = headerSearchInput.value.trim();
  loadArticles({ openSingle: true, scrollNews: true });
});

adminLogin.addEventListener("click", () => {
  if (state.isAdmin) {
    const confirmed = window.confirm("Админ горимоос гарах уу?");
    if (confirmed) adminLogout();
    return;
  }

  requestAdminLogin();
});

showAddArticle.addEventListener("click", (event) => {
  event.preventDefault();
  if (state.view !== "home") mountHome();
  document.querySelector("#addArticle").scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => document.querySelector('[name="title"]').focus(), 350);
});

backTop.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});

window.addEventListener("scroll", () => {
  backTop.classList.toggle("is-visible", window.scrollY > 460);
});

window.addEventListener("popstate", () => {
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
  updateAdminButton();
  mountHome();
  await loadCategories();

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
