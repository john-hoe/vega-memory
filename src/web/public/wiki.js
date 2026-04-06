const state = {
  pages: [],
  selectedSlug: null,
  detail: null,
  backlinks: [],
  versions: [],
  versionsSlug: null,
  versionsLoading: false,
  showVersions: false,
  mode: "list",
  query: ""
};

const elements = {
  refreshStatus: document.getElementById("refresh-status"),
  resultsSummary: document.getElementById("results-summary"),
  tableBody: document.getElementById("page-table"),
  tableMessage: document.getElementById("table-message"),
  detailBody: document.getElementById("detail-body"),
  searchForm: document.getElementById("wiki-search-form"),
  searchInput: document.getElementById("wiki-search-input"),
  resetSearch: document.getElementById("wiki-reset-search"),
  pageTypeFilter: document.getElementById("page-type-filter"),
  statusFilter: document.getElementById("status-filter"),
  projectFilter: document.getElementById("project-filter")
};

const formatTimestamp = (value) => {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
};

const appendTextElement = (parent, tagName, text, className) => {
  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  element.textContent = text;
  parent.appendChild(element);
  return element;
};

const fetchJson = async (path, init = {}) => {
  const response = await fetch(path, init);

  if (response.status === 401) {
    window.location.reload();
    throw new Error("Authentication required.");
  }

  if (!response.ok) {
    let detail = response.statusText;

    try {
      const payload = await response.json();
      if (payload && typeof payload.error === "string") {
        detail = payload.error;
      }
    } catch {}

    throw new Error(detail || `Request failed with status ${response.status}`);
  }

  return response.json();
};

const updateRefreshStatus = (label) => {
  elements.refreshStatus.textContent = label;
};

const renderMessage = (message, isError = false) => {
  if (!message) {
    elements.tableMessage.hidden = true;
    elements.tableMessage.textContent = "";
    elements.tableMessage.className = "message";
    return;
  }

  elements.tableMessage.hidden = false;
  elements.tableMessage.textContent = message;
  elements.tableMessage.className = isError ? "message error" : "message";
};

const resetDetail = (message) => {
  elements.detailBody.replaceChildren();
  appendTextElement(
    elements.detailBody,
    "div",
    message ?? "Select a wiki page to inspect metadata, content, backlinks, and versions.",
    "empty-state"
  );
};

const buildEmptyTableRow = (message) => {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 5;
  cell.className = "empty-state";
  cell.textContent = message;
  row.appendChild(cell);
  return row;
};

const buildCell = (text) => {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
};

const buildTagCell = (text, className) => {
  const cell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = className;
  badge.textContent = text;
  cell.appendChild(badge);
  return cell;
};

const getFilters = () => ({
  page_type: elements.pageTypeFilter.value.trim(),
  status: elements.statusFilter.value.trim(),
  project: elements.projectFilter.value.trim()
});

const matchesFilters = (page) => {
  const filters = getFilters();

  if (filters.page_type && page.page_type !== filters.page_type) {
    return false;
  }

  if (filters.status && page.status !== filters.status) {
    return false;
  }

  if (filters.project && (page.project || "") !== filters.project) {
    return false;
  }

  return true;
};

const renderResultsSummary = () => {
  const filters = getFilters();
  const filterParts = [];

  if (filters.page_type) {
    filterParts.push(`type ${filters.page_type}`);
  }

  if (filters.status) {
    filterParts.push(`status ${filters.status}`);
  }

  if (filters.project) {
    filterParts.push(`project ${filters.project}`);
  }

  const filterLabel = filterParts.length > 0 ? ` with ${filterParts.join(", ")}` : "";

  if (state.mode === "search" && state.query) {
    elements.resultsSummary.textContent =
      `Search results for "${state.query}" (${state.pages.length})${filterLabel}`;
    return;
  }

  elements.resultsSummary.textContent = `Showing ${state.pages.length} wiki pages${filterLabel}`;
};

const renderTable = () => {
  elements.tableBody.replaceChildren();

  if (state.pages.length === 0) {
    elements.tableBody.appendChild(buildEmptyTableRow("No wiki pages found."));
    return;
  }

  for (const page of state.pages) {
    const row = document.createElement("tr");

    if (page.slug === state.selectedSlug) {
      row.classList.add("selected");
    }

    row.appendChild(buildCell(page.title || "Untitled Page"));
    row.appendChild(buildTagCell(page.page_type || "-", "type-tag"));
    row.appendChild(buildTagCell(page.status || "-", "status-tag"));
    row.appendChild(buildTagCell(page.project || "-", "project-tag"));
    row.appendChild(buildCell(formatTimestamp(page.updated_at)));
    row.addEventListener("click", () => {
      void selectPage(page.slug);
    });

    elements.tableBody.appendChild(row);
  }
};

const buildDetailSection = (title) => {
  const section = document.createElement("section");
  section.className = "detail-section";
  const head = document.createElement("div");
  head.className = "section-head";
  appendTextElement(head, "div", title, "section-title");
  section.appendChild(head);
  return { head, section };
};

const renderDetail = () => {
  if (!state.detail) {
    resetDetail();
    return;
  }

  const titleBlock = document.createElement("div");
  appendTextElement(titleBlock, "h3", state.detail.title || "Untitled Page");

  const metadata = document.createElement("div");
  metadata.className = "detail-meta";
  for (const line of [
    `Type: ${state.detail.page_type || "-"}`,
    `Status: ${state.detail.status || "-"}`,
    `Project: ${state.detail.project || "-"}`,
    `Slug: ${state.detail.slug || "-"}`,
    `Version: ${state.detail.version ?? "-"}`,
    `Updated: ${formatTimestamp(state.detail.updated_at)}`,
    `Created: ${formatTimestamp(state.detail.created_at)}`,
    `Reviewed: ${state.detail.reviewed ? "Yes" : "No"}`
  ]) {
    appendTextElement(metadata, "div", line);
  }

  const sections = [];

  if (state.detail.summary) {
    const { section } = buildDetailSection("Summary");
    const summary = document.createElement("div");
    summary.className = "list-block";
    summary.textContent = state.detail.summary;
    section.appendChild(summary);
    sections.push(section);
  }

  {
    const { section } = buildDetailSection("Content");
    const content = document.createElement("pre");
    content.className = "detail-content";
    content.textContent = state.detail.content || "";
    section.appendChild(content);
    sections.push(section);
  }

  {
    const { section } = buildDetailSection("Backlinks");

    if (state.backlinks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "list-block";
      empty.textContent = "No backlinks reference this page yet.";
      section.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "link-list";

      for (const backlink of state.backlinks) {
        const item = document.createElement("div");
        item.className = "link-item";

        const link = document.createElement("button");
        link.className = "inline-link";
        link.type = "button";
        link.textContent = backlink.title;
        link.addEventListener("click", () => {
          void selectPage(backlink.slug);
        });
        item.appendChild(link);

        appendTextElement(item, "div", backlink.context || "", "link-context");
        list.appendChild(item);
      }

      section.appendChild(list);
    }

    sections.push(section);
  }

  {
    const { head, section } = buildDetailSection("Version History");
    const toggle = document.createElement("button");
    toggle.className = "button";
    toggle.type = "button";
    toggle.textContent = state.showVersions ? "Hide Versions" : "Show Versions";
    toggle.addEventListener("click", () => {
      void toggleVersions();
    });
    head.appendChild(toggle);

    if (state.showVersions) {
      if (state.versionsLoading) {
        const loading = document.createElement("div");
        loading.className = "list-block";
        loading.textContent = "Loading version history...";
        section.appendChild(loading);
      } else if (state.versions.length === 0) {
        const empty = document.createElement("div");
        empty.className = "list-block";
        empty.textContent = "No prior versions available.";
        section.appendChild(empty);
      } else {
        const list = document.createElement("div");
        list.className = "version-list";

        for (const version of state.versions) {
          const item = document.createElement("div");
          item.className = "version-row";
          appendTextElement(item, "div", `Version ${version.version}`, "section-title");
          appendTextElement(
            item,
            "div",
            `${version.change_reason || "No change reason"} • ${formatTimestamp(version.created_at)}`,
            "version-meta"
          );
          const content = document.createElement("pre");
          content.className = "detail-content";
          content.textContent = version.content || "";
          item.appendChild(content);
          list.appendChild(item);
        }

        section.appendChild(list);
      }
    }

    sections.push(section);
  }

  elements.detailBody.replaceChildren(titleBlock, metadata, ...sections);
};

const setListState = (pages) => {
  state.pages = Array.isArray(pages) ? pages : [];
  renderResultsSummary();
  renderTable();

  if (state.pages.length === 0) {
    state.selectedSlug = null;
    state.detail = null;
    state.backlinks = [];
    state.versions = [];
    state.versionsSlug = null;
    state.versionsLoading = false;
    resetDetail("No wiki pages match the current view.");
  }
};

const loadVersions = async (slug) => {
  state.versionsLoading = true;
  renderDetail();

  try {
    const versions = await fetchJson(`/api/wiki/pages/${encodeURIComponent(slug)}/versions`);

    if (slug !== state.selectedSlug) {
      return;
    }

    state.versions = Array.isArray(versions) ? versions : [];
    state.versionsSlug = slug;
  } finally {
    if (slug === state.selectedSlug) {
      state.versionsLoading = false;
      renderDetail();
    }
  }
};

const loadDetail = async (slug) => {
  const detail = await fetchJson(`/api/wiki/pages/${encodeURIComponent(slug)}`);

  if (slug !== state.selectedSlug) {
    return;
  }

  state.detail = detail?.page ?? null;
  state.backlinks = Array.isArray(detail?.backlinks) ? detail.backlinks : [];

  if (state.versionsSlug !== slug) {
    state.versions = [];
    state.versionsSlug = null;
    state.versionsLoading = false;
  }

  renderDetail();

  if (state.showVersions) {
    await loadVersions(slug);
  }
};

const selectPage = async (slug) => {
  state.selectedSlug = slug;
  renderTable();
  renderMessage("");

  try {
    await loadDetail(slug);
  } catch (error) {
    state.detail = null;
    state.backlinks = [];
    state.versions = [];
    state.versionsSlug = null;
    resetDetail("Unable to load the selected wiki page.");
    renderMessage(error instanceof Error ? error.message : String(error), true);
  }
};

const syncSelection = async () => {
  if (state.pages.length === 0) {
    return;
  }

  const nextSlug = state.pages.some((page) => page.slug === state.selectedSlug)
    ? state.selectedSlug
    : state.pages[0].slug;

  if (!nextSlug) {
    return;
  }

  await selectPage(nextSlug);
};

const loadPages = async () => {
  const filters = getFilters();
  const params = new URLSearchParams();

  params.set("limit", "50");

  if (filters.project) {
    params.set("project", filters.project);
  }

  if (filters.page_type) {
    params.set("page_type", filters.page_type);
  }

  if (filters.status) {
    params.set("status", filters.status);
  }

  const pages = await fetchJson(`/api/wiki/pages?${params.toString()}`);
  state.mode = "list";
  state.query = "";
  setListState(pages);
  await syncSelection();
};

const searchPages = async (query) => {
  const filters = getFilters();
  const results = await fetchJson("/api/wiki/search", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      query,
      project: filters.project || undefined,
      limit: 50
    })
  });

  state.mode = "search";
  state.query = query;
  setListState((Array.isArray(results) ? results : []).filter(matchesFilters));
  await syncSelection();
};

const refreshWiki = async () => {
  updateRefreshStatus(state.mode === "search" && state.query ? "Searching" : "Refreshing list");
  renderMessage("");

  try {
    if (state.mode === "search" && state.query) {
      await searchPages(state.query);
    } else {
      await loadPages();
    }

    updateRefreshStatus("Live");
  } catch (error) {
    updateRefreshStatus("Error");
    renderMessage(error instanceof Error ? error.message : String(error), true);
  }
};

const toggleVersions = async () => {
  state.showVersions = !state.showVersions;
  renderDetail();

  if (state.showVersions && state.selectedSlug && state.versionsSlug !== state.selectedSlug) {
    try {
      await loadVersions(state.selectedSlug);
    } catch (error) {
      renderMessage(error instanceof Error ? error.message : String(error), true);
    }
  }
};

elements.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = elements.searchInput.value.trim();

  if (!query) {
    await refreshWiki();
    return;
  }

  updateRefreshStatus("Searching");
  renderMessage("");

  try {
    await searchPages(query);
    updateRefreshStatus("Live");
  } catch (error) {
    updateRefreshStatus("Error");
    renderMessage(error instanceof Error ? error.message : String(error), true);
  }
});

elements.resetSearch.addEventListener("click", async () => {
  elements.searchInput.value = "";
  state.mode = "list";
  state.query = "";
  await refreshWiki();
});

let projectFilterTimeout = null;

const handleFilterChange = () => {
  void refreshWiki();
};

elements.pageTypeFilter.addEventListener("change", handleFilterChange);
elements.statusFilter.addEventListener("change", handleFilterChange);
elements.projectFilter.addEventListener("input", () => {
  if (projectFilterTimeout !== null) {
    clearTimeout(projectFilterTimeout);
  }

  projectFilterTimeout = window.setTimeout(() => {
    void refreshWiki();
  }, 250);
});

setInterval(() => {
  void refreshWiki();
}, 30000);

void refreshWiki();
